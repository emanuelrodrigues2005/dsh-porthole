/**
 * Contract tests for pair/host/push.js — the zero-length Web Push transport
 * (S2). No socket is opened: `https.request` is replaced by a controllable
 * double, and time is manual.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { createPushSender, validatePushEndpoint, PUSH_TTL_SECONDS } from '../host/push.js'
import { createFakeTimers } from './helpers.mjs'

const ENDPOINT = 'https://fcm.googleapis.com/wp/abc123'
const VAPID = {
  authorization: endpoint => ({
    authorization: `vapid t=header.payload.signature, k=test-key-for-${new URL(endpoint).origin}`,
    ttl: PUSH_TTL_SECONDS,
  }),
}

/** Controllable `https.request` double: records the call, answers on demand. */
function createFakeRequest() {
  const calls = []
  const request = (url, options, callback) => {
    const call = {
      url: String(url),
      options,
      headers: options?.headers ?? {},
      body: null,
      ended: false,
      destroyed: false,
      callback,
    }
    calls.push(call)
    const outgoing = new EventEmitter()
    outgoing.end = chunk => {
      call.ended = true
      call.body = chunk === undefined ? null : String(chunk)
    }
    outgoing.destroy = () => {
      call.destroyed = true
    }
    call.respond = statusCode => {
      const response = {
        statusCode,
        resumed: false,
        resume() {
          this.resumed = true
        },
        on() {
          return this
        },
      }
      callback(response)
    }
    call.fail = message => outgoing.emit('error', new Error(message))
    return outgoing
  }
  return { request, calls }
}

function createSender(t) {
  const fake = createFakeRequest()
  const timers = createFakeTimers()
  const sender = createPushSender({ request: fake.request, timers, now: () => 1_700_000_000_000 })
  return { sender, fake, timers }
}

/* ------------------------------------------------------------------------- *
 * Endpoint validation is the SSRF guard: a subscription is attacker input and
 * this is the only outbound connection Pair ever makes.
 * ------------------------------------------------------------------------- */

test('validatePushEndpoint accepts a real push endpoint and an explicit :443', () => {
  assert.equal(validatePushEndpoint(ENDPOINT).ok, true)
  assert.equal(validatePushEndpoint('https://push.example.net:443/wp/def').ok, true)
})

test('validatePushEndpoint rejects non-https, IP literals, single labels, credentials and other ports', () => {
  const rejected = [
    ['http://fcm.googleapis.com/wp/abc123', /https/],
    ['https://1.2.3.4/wp/abc', /IP literal/],
    ['https://[::1]/wp/abc', /IP literal/],
    ['https://localhost/wp/abc', /fully qualified/],
    ['https://user:pass@fcm.googleapis.com/wp/abc', /credentials/],
    ['https://fcm.googleapis.com:8443/wp/abc', /port 443/],
    ['https://fcm.googleapis.com/', /path/],
    ['', /non-empty/],
    [null, /non-empty/],
    ['not a url', /not a valid URL/],
  ]
  for (const [endpoint, pattern] of rejected) {
    const result = validatePushEndpoint(endpoint)
    assert.equal(result.ok, false, `${String(endpoint)} must be rejected`)
    assert.match(result.reason, pattern)
  }
})

test('send posts a zero-length body with the VAPID authorization and the TTL', async t => {
  const { sender, fake } = createSender(t)

  const pending = sender.send({ endpoint: ENDPOINT, vapid: VAPID })
  assert.equal(fake.calls.length, 1)
  const call = fake.calls[0]
  assert.equal(call.options.method, 'POST')
  assert.equal(call.url, ENDPOINT)
  assert.equal(call.ended, true, 'the request must be sent')
  assert.equal(call.body, null, 'the payload is zero bytes')
  assert.equal(call.headers['content-length'], '0')
  assert.equal(call.headers.ttl, '600')
  assert.match(call.headers.authorization, /^vapid t=header\.payload\.signature, k=test-key-for-https:\/\/fcm\.googleapis\.com$/)

  call.respond(201)
  assert.deepEqual(await pending, { ok: true, status: 201, drop: false })
})

test('a 404 or 410 drops the subscription; other failures keep it, and redirects are never followed', async t => {
  const { sender, fake } = createSender(t)

  const gone = sender.send({ endpoint: ENDPOINT, vapid: VAPID })
  fake.calls[0].respond(404)
  assert.deepEqual(await gone, { ok: false, status: 404, drop: true })

  const unregistered = sender.send({ endpoint: ENDPOINT, vapid: VAPID })
  fake.calls[1].respond(410)
  assert.deepEqual(await unregistered, { ok: false, status: 410, drop: true })

  const serverError = sender.send({ endpoint: ENDPOINT, vapid: VAPID })
  fake.calls[2].respond(503)
  assert.deepEqual(await serverError, { ok: false, status: 503, drop: false })

  const redirect = sender.send({ endpoint: ENDPOINT, vapid: VAPID })
  fake.calls[3].respond(302)
  assert.deepEqual(await redirect, { ok: false, status: 302, drop: false })
  assert.equal(fake.calls.length, 4, 'a 3xx must not trigger a second request')
})

test('a network error is a keep, not a drop', async t => {
  const { sender, fake } = createSender(t)

  const pending = sender.send({ endpoint: ENDPOINT, vapid: VAPID })
  fake.calls[0].fail('getaddrinfo ENOTFOUND')
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.drop, false, 'a transient network failure must keep the subscription')
  assert.match(result.error, /ENOTFOUND/)
})

test('the request is abandoned after ten seconds', async t => {
  const { sender, fake, timers } = createSender(t)

  const pending = sender.send({ endpoint: ENDPOINT, vapid: VAPID })
  assert.deepEqual(timers.pendingDelays(), [10_000], 'the timeout is ten seconds')

  timers.tick(10_000)
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.drop, false)
  assert.match(result.error, /timed out/)
  assert.equal(fake.calls[0].destroyed, true, 'the stuck socket must be destroyed')
})

test('an invalid endpoint is dropped without opening a connection', async t => {
  const { sender, fake } = createSender(t)

  const result = await sender.send({ endpoint: 'http://127.0.0.1/wp/abc', vapid: VAPID })

  assert.deepEqual(fake.calls, [], 'a rejected endpoint must never reach https.request')
  assert.equal(result.ok, false)
  assert.equal(result.drop, true)
})
