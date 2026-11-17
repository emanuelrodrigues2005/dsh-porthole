/**
 * Contract tests for the gate-owned push surface:
 *
 * - `GET /dsh-pair-sw.js` — the service worker, public, never proxied;
 * - `GET|POST /pair/self/push/*` — the phone API (S1/S2): config, settings,
 *   subscribe, unsubscribe, drain, test;
 * - `/pair/api/*` still answers 404 on the gate, and an unknown `/pair/self/`
 *   path never falls through to the upstream.
 *
 * Real loopback sockets for the gate, a mock upstream that must stay untouched,
 * a manual clock and temp directories.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { join } from 'node:path'

import { createGate } from '../host/gate.js'
import { createNotificationStore } from '../host/notifications.js'
import { createVapid } from '../host/vapid.js'
import { SERVICE_WORKER_SOURCE } from '../host/sw.js'
import { createClock, createFakeTicketStore, createMockUpstream, makeTempDir, removeTempDir } from './helpers.mjs'

const PUSH_ENDPOINT = 'https://fcm.googleapis.com/wp/device-one'

function httpRequest(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, agent: false }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          json() {
            return JSON.parse(Buffer.concat(chunks).toString('utf8'))
          },
        })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function setup(t, { publicOrigin = '' } = {}) {
  const dir = await makeTempDir()
  const clock = createClock()
  const store = createFakeTicketStore({ now: clock.now })
  const upstream = createMockUpstream()
  const upstreamPort = await upstream.start()
  const notifications = createNotificationStore({ stateFile: join(dir, 'notifications.json'), now: clock.now })
  const vapid = createVapid({ stateFile: join(dir, 'vapid.json'), now: clock.now })
  const testResults = []
  const push = {
    store: notifications,
    vapid,
    send: async () => true,
    test: deviceId => {
      const next = testResults.shift()
      return next === undefined ? { ok: true, deviceId } : next
    },
  }
  const gate = createGate({
    upstreamPort,
    store,
    now: clock.now,
    launchToken: 'launch-token-for-tests',
    push,
    publicOrigin,
  })
  const { port } = await gate.listen()

  const ticket = store.issue({ name: 'phone' })
  const first = store.claim(ticket.ticket, {})
  const secondTicket = store.issue({ name: 'phone two' })
  const second = store.claim(secondTicket.ticket, {})

  t.after(async () => {
    await gate.close()
    await upstream.close()
    await removeTempDir(dir).catch(() => {})
  })

  return {
    gate,
    port,
    clock,
    store,
    upstream,
    notifications,
    vapid,
    testResults,
    devices: [first, second],
    cookie: { cookie: `dsh_pair=${first.token}` },
    otherCookie: { cookie: `dsh_pair=${second.token}` },
  }
}

/* ------------------------------------------------------------------------- *
 * The service worker route
 * ------------------------------------------------------------------------- */

test('the gate serves the service worker at /dsh-pair-sw.js without touching the upstream', async t => {
  const { port, upstream } = await setup(t)

  const response = await httpRequest(port, '/dsh-pair-sw.js')

  assert.equal(response.status, 200)
  assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(response.headers['service-worker-allowed'], '/')
  assert.equal(response.headers['cache-control'], 'no-cache')
  assert.equal(response.body, SERVICE_WORKER_SOURCE)
  assert.equal(Number(response.headers['content-length']), Buffer.byteLength(SERVICE_WORKER_SOURCE))
  assert.deepEqual(upstream.requests, [], 'the worker is gate-owned; nothing may reach the harness')
  assert.deepEqual(upstream.upgrades, [])
})

test('HEAD returns the worker headers with no body and any other method is refused', async t => {
  const { port, upstream } = await setup(t)

  const head = await httpRequest(port, '/dsh-pair-sw.js', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
  assert.equal(head.headers['service-worker-allowed'], '/')

  const refused = await httpRequest(port, '/dsh-pair-sw.js', { method: 'POST', body: 'x' })
  assert.equal(refused.status, 405)
  assert.equal(refused.headers.allow, 'GET, HEAD')
  assert.deepEqual(upstream.requests, [])
})

/* ------------------------------------------------------------------------- *
 * The phone API
 * ------------------------------------------------------------------------- */

test('GET /pair/self/push/config answers this device only, with the VAPID key', async t => {
  const { port, cookie, otherCookie, devices, vapid } = await setup(t)

  const mine = await httpRequest(port, '/pair/self/push/config', { headers: cookie })
  assert.equal(mine.status, 200)
  const payload = mine.json()
  assert.equal(payload.deviceId, devices[0].deviceId)
  assert.equal(payload.vapidPublicKey, vapid.publicKey)
  assert.equal(payload.enabled, true)
  assert.deepEqual(payload.categories, { approvals: true, questions: true, completion: true, reports: true })
  assert.equal(payload.subscription, null)
  assert.equal(mine.headers['cache-control'], 'no-store')

  const other = await httpRequest(port, '/pair/self/push/config', { headers: otherCookie })
  assert.equal(other.json().deviceId, devices[1].deviceId, 'the device id comes from the cookie, never the body')
})

test('the phone API refuses a missing cookie, a revoked cookie, a wrong method and a foreign origin', async t => {
  const { port, cookie, otherCookie, store, devices, upstream } = await setup(t)
  const origin = `http://127.0.0.1:${String(port)}`

  const anonymous = await httpRequest(port, '/pair/self/push/config')
  assert.equal(anonymous.status, 401)
  assert.deepEqual(anonymous.json(), { error: 'pairing required' })

  const wrongMethod = await httpRequest(port, '/pair/self/push/config', { method: 'POST', headers: cookie, body: '{}' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'GET')

  const foreign = await httpRequest(port, '/pair/self/push/config', {
    headers: { ...cookie, origin: 'https://evil.example' },
  })
  assert.equal(foreign.status, 403)

  const sameOrigin = await httpRequest(port, '/pair/self/push/config', { headers: { ...cookie, origin } })
  assert.equal(sameOrigin.status, 200, 'the origin of a same-origin phone request is accepted')

  store.revoke(devices[1].deviceId)
  const revoked = await httpRequest(port, '/pair/self/push/config', { headers: otherCookie })
  assert.equal(revoked.status, 401, 'a revoked device loses the phone API immediately')

  assert.deepEqual(upstream.requests, [], 'no /pair/self/* request may ever reach the harness')
})

test('settings are persisted per device and never leak across devices', async t => {
  const { port, cookie, otherCookie, notifications, devices } = await setup(t)

  const updated = await httpRequest(port, '/pair/self/push/settings', {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, categories: { questions: false } }),
  })
  assert.equal(updated.status, 200)
  assert.deepEqual(updated.json(), {
    ok: true,
    enabled: true,
    categories: { approvals: true, questions: false, completion: true, reports: true },
  })

  const mine = (await httpRequest(port, '/pair/self/push/config', { headers: cookie })).json()
  assert.equal(mine.categories.questions, false)
  const other = (await httpRequest(port, '/pair/self/push/config', { headers: otherCookie })).json()
  assert.equal(other.categories.questions, true, 'the other device keeps its own settings')
  assert.equal(other.deviceId, devices[1].deviceId)
  assert.equal(notifications.view(devices[0].deviceId).categories.questions, false)

  const unknown = await httpRequest(port, '/pair/self/push/settings', {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ categories: { telepathy: true } }),
  })
  assert.equal(unknown.status, 400)
  assert.match(unknown.json().error, /unknown notification category/)

  const unknownKey = await httpRequest(port, '/pair/self/push/settings', {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ category: {} }),
  })
  assert.equal(unknownKey.status, 400)
  assert.match(unknownKey.json().error, /unknown settings key/)

  // A device id in the body is refused outright: under `/pair/self/*` the
  // device always comes from the cookie, so this is the cross-device attack.
  const spoofed = await httpRequest(port, '/pair/self/push/settings', {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: devices[1].deviceId, enabled: false }),
  })
  assert.equal(spoofed.status, 400)
  assert.match(spoofed.json().error, /unknown settings key "deviceId"/)
  assert.equal(notifications.view(devices[1].deviceId).enabled, true, 'the other device was not touched')
})

test('the body cap answers 413 and malformed JSON answers 400', async t => {
  const { port, cookie } = await setup(t)

  const oversized = await httpRequest(port, '/pair/self/push/settings', {
    method: 'POST',
    headers: {
      ...cookie,
      'content-type': 'application/json',
      'content-length': String(8192),
    },
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(oversized.status, 413)

  const malformed = await httpRequest(port, '/pair/self/push/settings', {
    method: 'POST',
    headers: { ...cookie, 'content-type': 'application/json' },
    body: '{not json',
  })
  assert.equal(malformed.status, 400)
})

test('subscribe validates the endpoint, stores one subscription, and unsubscribe is idempotent', async t => {
  const { port, cookie, notifications, devices } = await setup(t)

  const subscribe = endpoint =>
    httpRequest(port, '/pair/self/push/subscribe', {
      method: 'POST',
      headers: { ...cookie, 'content-type': 'application/json', 'user-agent': 'TestPhone/1.0' },
      body: JSON.stringify({ endpoint, keys: { p256dh: 'x', auth: 'y' } }),
    })

  const rejected = [
    'http://fcm.googleapis.com/wp/device-one',
    'https://127.0.0.1/wp/device-one',
    'https://localhost/wp/device-one',
    'https://fcm.googleapis.com:8443/wp/device-one',
  ]
  for (const endpoint of rejected) {
    const response = await subscribe(endpoint)
    assert.equal(response.status, 400, `${endpoint} must be rejected`)
    assert.match(response.json().error, /invalid push endpoint/)
  }
  assert.equal(notifications.endpointFor(devices[0].deviceId), null, 'a rejected endpoint is never stored')

  const accepted = await subscribe(PUSH_ENDPOINT)
  assert.equal(accepted.status, 200)
  assert.deepEqual(accepted.json(), {
    ok: true,
    subscription: { host: 'fcm.googleapis.com', createdAt: notifications.view(devices[0].deviceId).subscription.createdAt },
  })
  assert.equal(notifications.endpointFor(devices[0].deviceId), PUSH_ENDPOINT, 'the endpoint is persisted')

  const config = (await httpRequest(port, '/pair/self/push/config', { headers: cookie })).json()
  assert.deepEqual(config.subscription, { host: 'fcm.googleapis.com', createdAt: accepted.json().subscription.createdAt })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const unsubscribe = await httpRequest(port, '/pair/self/push/unsubscribe', {
      method: 'POST',
      headers: cookie,
    })
    assert.equal(unsubscribe.status, 200)
    assert.deepEqual(unsubscribe.json(), { ok: true })
  }
  assert.equal(notifications.endpointFor(devices[0].deviceId), null)
})

test('drain returns this device’s items once, then an empty list', async t => {
  const { port, cookie, otherCookie, notifications, devices } = await setup(t)
  notifications.setSubscription(devices[0].deviceId, { endpoint: PUSH_ENDPOINT })
  notifications.setSubscription(devices[1].deviceId, { endpoint: 'https://push.example.net/wp/two' })
  notifications.enqueue({ deviceId: devices[0].deviceId, category: 'approvals', title: 'Approve bash', body: 'bash -lc ls' })
  notifications.enqueue({ deviceId: devices[1].deviceId, category: 'approvals', title: 'Other phone' })

  const first = await httpRequest(port, '/pair/self/push/drain', { method: 'POST', headers: cookie })
  assert.equal(first.status, 200)
  assert.equal(first.headers['cache-control'], 'no-store')
  const drained = first.json()
  assert.equal(drained.count, 1)
  assert.equal(drained.items.length, 1)
  assert.equal(drained.items[0].title, 'Approve bash')
  assert.deepEqual(Object.keys(drained.items[0]).sort(), ['body', 'category', 'createdAt', 'id', 'title', 'url'])

  const second = await httpRequest(port, '/pair/self/push/drain', { method: 'POST', headers: cookie })
  assert.deepEqual(second.json(), { items: [], count: 0 })

  const other = await httpRequest(port, '/pair/self/push/drain', { method: 'POST', headers: otherCookie })
  assert.equal(other.json().count, 1, 'draining one device never drains another')
})

test('the test route maps the cooldown and the missing subscription to 429/409', async t => {
  const { port, cookie, testResults, notifications, devices } = await setup(t)

  const ok = await httpRequest(port, '/pair/self/push/test', { method: 'POST', headers: cookie })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json(), { ok: true })

  testResults.push({ ok: false, reason: 'cooldown', retryAfter: 42 })
  const cooling = await httpRequest(port, '/pair/self/push/test', { method: 'POST', headers: cookie })
  assert.equal(cooling.status, 429)
  assert.equal(cooling.headers['retry-after'], '42')

  testResults.push({ ok: false, reason: 'no-subscription' })
  const missing = await httpRequest(port, '/pair/self/push/test', { method: 'POST', headers: cookie })
  assert.equal(missing.status, 409)
  assert.match(missing.json().error, /no push subscription/)

  notifications.setSubscription(devices[0].deviceId, { endpoint: PUSH_ENDPOINT })
  notifications.updateSettings(devices[0].deviceId, { enabled: false })
  testResults.push({ ok: false, reason: 'disabled' })
  const disabled = await httpRequest(port, '/pair/self/push/test', { method: 'POST', headers: cookie })
  assert.equal(disabled.status, 409)
  assert.match(disabled.json().error, /switched off/)
})

test('operator routes still 404 on the gate and unknown /pair/self paths never fall through', async t => {
  const { port, cookie, upstream } = await setup(t)

  for (const path of ['/pair/api/status', '/pair/api/devices/notifications', '/pair/api/push/test']) {
    const response = await httpRequest(port, path, { headers: cookie })
    assert.equal(response.status, 404, `${path} must stay host-only`)
  }
  const unknown = await httpRequest(port, '/pair/self/push/nope', { headers: cookie })
  assert.equal(unknown.status, 404)

  assert.deepEqual(upstream.requests, [], 'none of these paths may reach the harness listener')
})

test('without a push facade the phone API answers 503 but still serves the worker', async t => {
  const upstream = createMockUpstream()
  const upstreamPort = await upstream.start()
  const store = createFakeTicketStore({ now: Date.now })
  const gate = createGate({ upstreamPort, store, launchToken: 'launch-token-for-tests' })
  const { port } = await gate.listen()
  const ticket = store.issue({ name: 'phone' })
  const device = store.claim(ticket.ticket, {})
  t.after(async () => {
    await gate.close()
    await upstream.close()
  })

  const config = await httpRequest(port, '/pair/self/push/config', {
    headers: { cookie: `dsh_pair=${device.token}` },
  })
  assert.equal(config.status, 503)
  assert.deepEqual(config.json(), { error: 'push notifications are unavailable' })

  const worker = await httpRequest(port, '/dsh-pair-sw.js')
  assert.equal(worker.status, 200, 'the worker is static and always available')
})
