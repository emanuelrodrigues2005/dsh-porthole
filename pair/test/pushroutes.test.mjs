/**
 * Contract tests for the two push operator routes added to
 * pair/host/routes.js:
 *
 *   POST /pair/api/devices/notifications  { deviceId, enabled?, categories? }
 *   POST /pair/api/push/test              { deviceId }
 *
 * They sit on the harness listener, so they run the exact same guard order as
 * the five original routes: proxied marker first, then requestRejection, then
 * loopback, then the owner admission — only then the method and the service.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { registerPairRoutes, registerPushRoutes } from '../host/routes.js'
import { flush } from './helpers.mjs'

const OWNER_ADMISSION = { peer: { principal: { kind: 'owner' } } }
const NOTIFICATIONS_PATH = '/pair/api/devices/notifications'
const TEST_PATH = '/pair/api/push/test'

function createFakeService({ notificationsResult, testResult } = {}) {
  const calls = []
  return {
    calls,
    status() {
      return {
        state: 'off',
        url: null,
        expiresAt: null,
        devices: [{ id: 'device-1', name: 'phone', createdAt: 1, lastSeenAt: 2, notifications: { enabled: true } }],
        pairUrl: null,
        matrix: null,
      }
    },
    async setDeviceNotifications(deviceId, patch) {
      calls.push(['notifications', deviceId, patch])
      if (notificationsResult instanceof Error) throw notificationsResult
      if (notificationsResult === 'missing') return undefined
      return { deviceId, enabled: patch.enabled ?? true, categories: { approvals: true, questions: true, completion: true, reports: true } }
    },
    pushTest(deviceId) {
      calls.push(['test', deviceId])
      return testResult ?? { ok: true }
    },
  }
}

function createFakeContext({ rejection = undefined, admission = OWNER_ADMISSION } = {}) {
  const registered = []
  const connectionCalls = []
  const state = { rejection, admission }
  const ctx = {
    connection: {
      requestRejection(request) {
        connectionCalls.push('requestRejection')
        return state.rejection
      },
      admit(request) {
        connectionCalls.push('admit')
        return state.admission
      },
    },
    webServer: {
      register(route) {
        const entry = { kind: route.kind, path: route.path, handler: route.handler, disposed: false }
        registered.push(entry)
        return () => {
          entry.disposed = true
          const index = registered.indexOf(entry)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
  }
  return {
    ctx,
    registered,
    connectionCalls,
    setRejection(value) {
      state.rejection = value
    },
    setAdmission(value) {
      state.admission = value
    },
  }
}

function createFakeRequest({ method = 'POST', remoteAddress = '127.0.0.1', headers = {}, body } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  request.method = method
  request.headers = { 'content-type': 'application/json', ...headers }
  request.socket = { remoteAddress }
  return request
}

function createFakeResponse() {
  const state = { statusCode: 200, headers: {}, chunks: [], ended: false }
  const response = {
    get writableEnded() {
      return state.ended
    },
    get statusCode() {
      return state.statusCode
    },
    set statusCode(value) {
      state.statusCode = value
    },
    writeHead(status, headers) {
      state.statusCode = status
      Object.assign(state.headers, headers)
      return response
    },
    end(chunk) {
      if (chunk !== undefined) state.chunks.push(Buffer.from(chunk))
      state.ended = true
    },
    destroy() {
      state.ended = true
    },
  }
  return {
    response,
    state,
    json() {
      return JSON.parse(Buffer.concat(state.chunks).toString('utf8'))
    },
  }
}

async function call(ctx, path, requestOptions) {
  const fake = createFakeContext()
  const service = requestOptions.service ?? createFakeService(requestOptions.serviceOptions)
  const merged = { ...fake.ctx, ...(ctx ?? {}) }
  // Both registrations, so `/pair/api/status` is reachable next to the push
  // routes through the same guard.
  const disposePush = registerPushRoutes(merged, service)
  const disposeLifecycle = registerPairRoutes(merged, service)
  const entry = fake.registered.find(candidate => candidate.path === path)
  assert.ok(entry, `route ${path} is not registered (registered: ${fake.registered.map(item => item.path).join(', ')})`)
  const sink = createFakeResponse()
  entry.handler(
    createFakeRequest({
      method: requestOptions.method,
      remoteAddress: requestOptions.remoteAddress,
      headers: requestOptions.headers,
      body: requestOptions.body,
    }),
    sink.response,
  )
  await flush()
  await flush()
  disposePush()
  disposeLifecycle()
  return { status: sink.state.statusCode, headers: sink.state.headers, body: sink.json(), fake, service }
}

test('registerPushRoutes adds the two push routes and leaves the five lifecycle routes to registerPairRoutes', async () => {
  const fake = createFakeContext()
  const service = createFakeService()
  const disposePush = registerPushRoutes(fake.ctx, service)
  const disposeLifecycle = registerPairRoutes(fake.ctx, service)

  const pushPaths = fake.registered
    .filter(entry => entry.path === NOTIFICATIONS_PATH || entry.path === TEST_PATH)
    .map(entry => entry.path)
    .sort()
  assert.deepEqual(pushPaths, [NOTIFICATIONS_PATH, TEST_PATH])
  assert.equal(fake.registered.length, 7, 'the two registrations together expose all seven routes')
  assert.ok(fake.registered.every(entry => entry.kind === 'exact'))

  disposePush()
  assert.equal(fake.registered.length, 5, 'disposing the push routes leaves the lifecycle routes alone')
  disposeLifecycle()
  assert.deepEqual(fake.registered, [])
})

test('the push routes refuse the gate-proxied marker before any admission call', async () => {
  for (const path of [NOTIFICATIONS_PATH, TEST_PATH]) {
    const result = await call(null, path, {
      method: 'POST',
      headers: { 'x-dsh-pair-proxied': '1' },
      body: JSON.stringify({ deviceId: 'device-1' }),
    })
    assert.equal(result.status, 403, `${path} must refuse a proxied request`)
    assert.deepEqual(result.fake.connectionCalls, [], 'neither admission call may run')
  }
})

test('the push routes keep the loopback and owner guards', async () => {
  const nonLoopback = await call(null, NOTIFICATIONS_PATH, {
    method: 'POST',
    remoteAddress: '10.0.0.5',
    body: JSON.stringify({ deviceId: 'device-1' }),
  })
  assert.equal(nonLoopback.status, 403)
  assert.deepEqual(nonLoopback.fake.connectionCalls, ['requestRejection'])

  const fake = createFakeContext({ admission: { peer: { principal: { kind: 'ownerish' } } } })
  const dispose = registerPushRoutes(fake.ctx, createFakeService())
  const entry = fake.registered.find(candidate => candidate.path === TEST_PATH)
  const sink = createFakeResponse()
  entry.handler(createFakeRequest({ method: 'POST', body: JSON.stringify({ deviceId: 'device-1' }) }), sink.response)
  await flush()
  await flush()
  dispose()
  assert.equal(sink.state.statusCode, 403, 'a non-owner peer must never drive the push routes')

  const rejected = await call(null, TEST_PATH, {
    method: 'POST',
    headers: {},
    body: JSON.stringify({ deviceId: 'device-1' }),
    serviceOptions: {},
  })
  assert.equal(rejected.status, 200, 'the owner path still works with the default fake service')
})

test('POST /pair/api/devices/notifications applies the operator switches and answers the view', async () => {
  const result = await call(null, NOTIFICATIONS_PATH, {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'device-1', enabled: false, categories: { reports: false } }),
  })

  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  assert.equal(result.body.notifications.deviceId, 'device-1')
  assert.deepEqual(result.service.calls, [['notifications', 'device-1', { enabled: false, categories: { reports: false } }]])
})

test('POST /pair/api/devices/notifications validates the body and reports bad settings as 400', async () => {
  const missing = await call(null, NOTIFICATIONS_PATH, { method: 'POST', body: JSON.stringify({}) })
  assert.equal(missing.status, 400)
  assert.match(missing.body.error, /deviceId is required/)

  const badCategories = await call(null, NOTIFICATIONS_PATH, {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'device-1' }),
    serviceOptions: { notificationsResult: new Error('unknown notification category "telepathy"') },
  })
  assert.equal(badCategories.status, 400)
  assert.match(badCategories.body.error, /unknown notification category/)

  const wrongMethod = await call(null, NOTIFICATIONS_PATH, { method: 'GET' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')
})

test('POST /pair/api/push/test maps ok, cooldown and a missing subscription', async () => {
  const ok = await call(null, TEST_PATH, { method: 'POST', body: JSON.stringify({ deviceId: 'device-1' }) })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { ok: true })
  assert.deepEqual(ok.service.calls, [['test', 'device-1']])

  const cooling = await call(null, TEST_PATH, {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'device-1' }),
    serviceOptions: { testResult: { ok: false, reason: 'cooldown', retryAfter: 30 } },
  })
  assert.equal(cooling.status, 429)
  assert.equal(cooling.headers['retry-after'], '30')

  const missing = await call(null, TEST_PATH, {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'device-1' }),
    serviceOptions: { testResult: { ok: false, reason: 'no-subscription' } },
  })
  assert.equal(missing.status, 409)
  assert.match(missing.body.error, /no push subscription/)

  const disabled = await call(null, TEST_PATH, {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'device-1' }),
    serviceOptions: { testResult: { ok: false, reason: 'disabled' } },
  })
  assert.equal(disabled.status, 409)
  assert.match(disabled.body.error, /switched off/)

  const malformed = await call(null, TEST_PATH, { method: 'POST', body: '{oops' })
  assert.equal(malformed.status, 400)
})

test('a service without the push methods answers 503 instead of failing', async () => {
  const service = {
    status: () => ({ state: 'off' }),
    start: async () => {},
    stop: async () => {},
    reissue: async () => {},
    revoke: async () => true,
  }
  const notifications = await call(null, NOTIFICATIONS_PATH, {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'device-1' }),
    service,
  })
  assert.equal(notifications.status, 503)
  assert.match(notifications.body.error, /unavailable/)

  const testRoute = await call(null, TEST_PATH, {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'device-1' }),
    service,
  })
  assert.equal(testRoute.status, 503)
})

test('status() carries the per-device notification settings verbatim', async () => {
  const result = await call(null, '/pair/api/status', { method: 'GET' })
  assert.equal(result.status, 200)
  assert.equal(result.body.devices[0].notifications.enabled, true)
})
