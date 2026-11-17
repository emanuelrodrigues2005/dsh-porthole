/**
 * Contract tests for pair/host/gate.js.
 *
 * The gate is exercised over real loopback sockets; the "DSH listener" is a
 * local mock upstream. No external network, no Cloudflare, no DSH process.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'

import { createGate } from '../host/gate.js'
import {
  createClock,
  createFakeTicketStore,
  createMockUpstream,
  makeTempDir,
  removeTempDir,
  DAY_MS,
  MINUTE_MS,
} from './helpers.mjs'

const LAUNCH_TOKEN = 'launch-token-for-tests'
const TUNNEL_HOST = 'brave-river-mango.trycloudflare.com'
const SOCKET_WAIT_MS = 2_000
/** Mirrors MAX_BODY_BYTES in pair/host/gate.js; read that constant before changing this. */
const GATE_MAX_BODY_BYTES = 32 * 1024 * 1024

async function setup(t, { deviceTtlMs } = {}) {
  const clock = createClock()
  const store = createFakeTicketStore({ now: clock.now, ...(deviceTtlMs === undefined ? {} : { deviceTtlMs }) })
  const upstream = createMockUpstream()
  const upstreamPort = await upstream.start()
  const gate = createGate({
    upstreamPort,
    store,
    now: clock.now,
    launchToken: LAUNCH_TOKEN,
  })
  const { port } = await gate.listen()

  t.after(async () => {
    await gate.close()
    await upstream.close()
  })

  return { gate, port, store, clock, upstream, upstreamPort }
}

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
        })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/**
 * Sends headers declaring a body above `GATE_MAX_BODY_BYTES` and one byte,
 * without ever completing the body. A gate that enforces the cap from the
 * declared length answers at once; a streaming gate waits forever, so the
 * failure timeout is the bound this test asserts against.
 */
function requestDeclaredBody(port, path, size, headers, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/octet-stream',
          'content-length': String(size),
        },
        agent: false,
      },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          settle(resolve, {
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', error => settle(reject, error))
    timer = setTimeout(() => {
      settle(
        reject,
        new Error(`the gate did not refuse a declared ${String(size)} byte body within ${String(timeoutMs)} ms`),
      )
    }, timeoutMs)
    function settle(callback, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.destroy()
      callback(value)
    }
    req.write('x')
  })
}

const EXCHANGE_COOKIE = 'dsh_auth=exchange-ok; HttpOnly; Path=/; SameSite=Strict'

function isExchangeRequest(record) {
  return record.url.startsWith('/?token=')
}

/** Requests the gate forwarded as application traffic, not the token exchange. */
function proxiedRequests(upstream) {
  return upstream.requests.filter(record => !isExchangeRequest(record))
}

/** The launch token must never be legible in the browser-facing response. */
function assertNoLaunchToken(response) {
  const material = `${String(response.status)}\n${JSON.stringify(response.headers)}\n${response.body}`
  assert.doesNotMatch(material, /token=/i, 'the browser response leaked the launch token')
}

/**
 * Pairs a phone through the gate.
 *
 * The gate is expected to perform the DSH launch-token exchange itself, so the
 * mock upstream answers `/?token=…` with a real-looking `303` + `Set-Cookie`
 * regardless of the proxied-response handler a test installed. Every pairing
 * therefore exercises the same exchange path, and tests that only care about
 * proxied traffic can filter with {@link proxiedRequests}.
 *
 * @returns {{issued: object, response: object, setCookies: string[],
 *   setCookie: string, cookie: string, token: string, exchangeRequests: object[]}}
 */
async function pairPhone(port, store, name = 'phone', { upstream, exchangeCookies = [EXCHANGE_COOKIE] } = {}) {
  const issued = store.issue({ name })
  const firstRequest = upstream === undefined ? 0 : upstream.requests.length

  if (upstream !== undefined) {
    const previous = upstream.respond((request, response, record) => {
      if (isExchangeRequest(record)) {
        response.writeHead(303, { location: '/', 'set-cookie': exchangeCookies })
        response.end()
        return
      }
      previous(request, response, record)
    })
  }

  const response = await httpRequest(port, `/pair/${issued.ticket}`)
  const setCookies = response.headers['set-cookie'] ?? []
  const setCookie = setCookies.find(value => value.startsWith('dsh_pair=')) ?? ''
  const cookie = setCookie.split(';')[0]
  const token = cookie.startsWith('dsh_pair=') ? cookie.slice('dsh_pair='.length) : ''
  const exchangeRequests = upstream === undefined
    ? []
    : upstream.requests.slice(firstRequest).filter(isExchangeRequest)

  return { issued, response, setCookies, setCookie, cookie, token, exchangeRequests }
}

async function openRawSocket(port) {
  const socket = connect({ host: '127.0.0.1', port })
  await once(socket, 'connect')
  return socket
}

function upgradeRequest(cookie) {
  const lines = [
    'GET /api/remote.mux HTTP/1.1',
    `Host: ${TUNNEL_HOST}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    `Origin: https://${TUNNEL_HOST}`,
  ]
  if (cookie !== undefined) lines.push(`Cookie: ${cookie}`)
  return lines.join('\r\n') + '\r\n\r\n'
}

/** Accumulates raw socket text and lets a test wait for a pattern or closure. */
function createSocketProbe(socket) {
  let text = ''
  let closed = false
  const waiters = new Set()
  const closedPromise = new Promise(resolve => {
    socket.once('close', () => {
      closed = true
      resolve()
    })
  })
  socket.on('data', chunk => {
    text += chunk.toString('latin1')
    for (const waiter of [...waiters]) {
      if (waiter.regex.test(text)) {
        waiters.delete(waiter)
        waiter.resolve(text)
      }
    }
  })

  return {
    get text() {
      return text
    },
    waitFor(regex, timeoutMs = SOCKET_WAIT_MS) {
      if (regex.test(text)) return Promise.resolve(text)
      return new Promise((resolve, reject) => {
        const waiter = {
          regex,
          resolve: value => {
            clearTimeout(timer)
            resolve(value)
          },
        }
        const timer = setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error(`timed out waiting for ${regex}; received ${JSON.stringify(text)}`))
        }, timeoutMs)
        waiters.add(waiter)
      })
    },
    async waitForClose(timeoutMs = SOCKET_WAIT_MS) {
      if (closed) return
      let timer
      try {
        await Promise.race([
          closedPromise,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`socket stayed open; received ${JSON.stringify(text)}`)),
              timeoutMs,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

test('listen resolves a port and GET /pair/health answers ok without a cookie', async t => {
  const { port, upstream } = await setup(t)

  assert.equal(typeof port, 'number')
  assert.ok(port > 0)

  const response = await httpRequest(port, '/pair/health')

  assert.equal(response.status, 200)
  assert.match(String(response.headers['content-type']), /application\/json/)
  assert.deepEqual(JSON.parse(response.body), { ok: true })
  assert.equal(upstream.requests.length, 0)
})

test('a bare /pair/ link answers an HTML explanation for a browser and JSON otherwise', async t => {
  const { port } = await setup(t)
  const browser = await httpRequest(port, '/pair/', { headers: { accept: 'text/html,application/xhtml+xml' } })
  assert.equal(browser.status, 404)
  assert.match(String(browser.headers['content-type']), /text\/html/)
  assert.match(browser.body, /Pairing link incomplete/)

  const machine = await httpRequest(port, '/pair/', { headers: { accept: 'application/json' } })
  assert.equal(machine.status, 404)
  assert.match(String(machine.headers['content-type']), /application\/json/)
})

test('GET /pair/<ticket> exchanges the launch token upstream and answers a redirect to the GUI root without the token', async t => {
  const { port, store, upstream, upstreamPort } = await setup(t)
  const paired = await pairPhone(port, store, 'phone', { upstream })

  // S2: the browser never sees the launch token. The redirect must resolve to
  // the GUI root from /pair/<ticket> — a relative "./" would land on /pair/.
  assert.ok([302, 303].includes(paired.response.status), `expected a 302/303 redirect, got ${paired.response.status}`)
  assert.equal(paired.response.headers.location, '/')
  assert.equal(new URL(paired.response.headers.location, `http://127.0.0.1:${port}/pair/X`).pathname, '/')
  assert.equal(String(paired.response.headers.location).includes('?'), false)
  assertNoLaunchToken(paired.response)

  // S3: the device cookie is HttpOnly, Path=/, SameSite=Lax and Secure.
  assert.match(paired.setCookie, /^dsh_pair=[A-Za-z0-9_-]{43};/)
  assert.match(paired.setCookie, /;\s*HttpOnly/i)
  assert.match(paired.setCookie, /;\s*Path=\//i)
  assert.match(paired.setCookie, /;\s*SameSite=Lax/i)
  assert.match(paired.setCookie, /;\s*Secure/i)
  assert.deepEqual(store.verify(paired.token), { deviceId: 'device-1' })

  // S2: the exchange is performed by the gate, once, against the loopback upstream.
  assert.equal(paired.exchangeRequests.length, 1, 'the gate must perform exactly one launch-token exchange')
  const exchange = paired.exchangeRequests[0]
  assert.equal(exchange.method, 'GET')
  assert.equal(exchange.url, `/?token=${LAUNCH_TOKEN}`)
  assert.equal(exchange.headers.host, `127.0.0.1:${upstreamPort}`)
})

test('the device cookie Max-Age matches the claimed device lifetime', async t => {
  const deviceTtlMs = 7 * DAY_MS
  const { port, store, upstream } = await setup(t, { deviceTtlMs })
  const paired = await pairPhone(port, store, 'phone', { upstream })

  const match = /;\s*Max-Age=(\d+)/i.exec(paired.setCookie)
  assert.ok(match, `dsh_pair must carry a numeric Max-Age; got ${JSON.stringify(paired.setCookie)}`)
  const maxAge = Number(match[1])
  const expected = Math.floor(deviceTtlMs / 1000)
  assert.ok(Number.isInteger(maxAge) && maxAge > 0, `Max-Age must be a positive integer, got ${String(maxAge)}`)
  assert.ok(
    Math.abs(maxAge - expected) <= 1,
    `Max-Age ${String(maxAge)} is more than 1 s away from the claimed ${String(expected)} s device lifetime`,
  )
})

test('pairing forwards every upstream Set-Cookie header to the browser', async t => {
  const { port, store, upstream } = await setup(t)
  const exchangeCookies = [
    'dsh_auth=session-value; HttpOnly; Path=/; SameSite=Strict',
    'dsh_pref=compact; Path=/; Max-Age=3600',
  ]

  const paired = await pairPhone(port, store, 'phone', { upstream, exchangeCookies })

  assert.ok([302, 303].includes(paired.response.status))
  for (const original of exchangeCookies) {
    const value = original.split(';')[0]
    assert.ok(
      paired.setCookies.some(cookie => cookie.startsWith(`${value};`)),
      `the upstream cookie ${JSON.stringify(value)} did not reach the browser`,
    )
  }
  assert.ok(
    paired.setCookies.some(cookie => cookie.startsWith('dsh_pair=')),
    'the gate must still set its own device cookie',
  )
})

test('a failed launch-token exchange answers 502/503 and hands out no device cookie', async t => {
  const { port, store, upstream } = await setup(t)
  upstream.respond((req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('exchange failed')
  })

  const issued = store.issue({ name: 'phone' })
  const response = await httpRequest(port, `/pair/${issued.ticket}`)

  assert.ok([502, 503].includes(response.status), `a failed exchange must answer 502/503, got ${response.status}`)
  assert.equal(response.headers['set-cookie'], undefined, 'no device cookie may be handed out when the exchange fails')
  assertNoLaunchToken(response)
})

test('dsh_pair and forwarded upstream cookies are Secure and keep their values', async t => {
  const { port, store, upstream } = await setup(t)
  const exchangeCookies = [
    'dsh_auth=abc123; HttpOnly; Path=/; SameSite=Strict',
    'dsh_pref=compact; Path=/',
  ]

  const paired = await pairPhone(port, store, 'phone', { upstream, exchangeCookies })

  // S3: the device cookie keeps every existing attribute and gains Secure.
  for (const pattern of [/;\s*HttpOnly/i, /;\s*Path=\//i, /;\s*SameSite=Lax/i, /;\s*Secure/i]) {
    assert.match(paired.setCookie, pattern, `dsh_pair is missing an attribute: ${String(pattern)}`)
  }
  assert.match(paired.setCookie, /^dsh_pair=[A-Za-z0-9_-]{43};/)

  // S3: every forwarded upstream cookie gains Secure and keeps its value.
  for (const original of exchangeCookies) {
    const value = original.split(';')[0]
    const forwarded = paired.setCookies.find(cookie => cookie.startsWith(`${value};`))
    assert.ok(forwarded, `the upstream cookie ${JSON.stringify(value)} was not forwarded`)
    assert.match(forwarded, /;\s*Secure/i, `forwarded cookie ${JSON.stringify(value)} is not Secure`)
    const withoutSecure = forwarded.replace(/;\s*Secure(?=;|$)/gi, '')
    assert.equal(withoutSecure, original, 'forwarding must add only the Secure attribute')
  }
})

test('a pairing ticket can be consumed only once', async t => {
  const { port, store, upstream } = await setup(t)
  const paired = await pairPhone(port, store, 'phone', { upstream })
  assert.ok([302, 303].includes(paired.response.status))

  const replay = await httpRequest(port, `/pair/${paired.issued.ticket}`)

  assert.equal(replay.status, 401)
  assert.equal(replay.headers['set-cookie'], undefined, 'a replayed ticket must not hand out another cookie')
})

test('an unknown pairing ticket is refused with 401', async t => {
  const { port } = await setup(t)

  const response = await httpRequest(port, `/pair/${'A'.repeat(43)}`)

  assert.equal(response.status, 401)
  assert.equal(response.headers['set-cookie'], undefined)
})

test('an expired pairing ticket is refused with 401', async t => {
  const { port, store, clock } = await setup(t)
  const issued = store.issue({ name: 'phone' })

  clock.advance(5 * MINUTE_MS + 1)
  const response = await httpRequest(port, `/pair/${issued.ticket}`)

  assert.equal(response.status, 401)
  assert.equal(response.headers['set-cookie'], undefined)
})

test('a gate without a launch token fails closed on claims, proxies and upgrades', async t => {
  const clock = createClock()
  const store = createFakeTicketStore({ now: clock.now })
  const upstream = createMockUpstream()
  const upstreamPort = await upstream.start()
  const gate = createGate({ upstreamPort, store, now: clock.now })
  const { port } = await gate.listen()
  t.after(async () => {
    await gate.close()
    await upstream.close()
  })

  const issued = store.issue({ name: 'phone' })
  const claimResponse = await httpRequest(port, `/pair/${issued.ticket}`)
  assert.equal(claimResponse.status, 503)
  assert.equal(claimResponse.headers['set-cookie'], undefined)
  assert.equal(upstream.requests.length, 0, 'an unavailable claim must not contact the upstream')

  // Drive the store directly: a device that exists but cannot be paired.
  const claimed = store.claim(issued.ticket, { name: 'phone' })
  const cookie = `dsh_pair=${claimed.token}`
  const proxyResponse = await httpRequest(port, '/api/x', { headers: { cookie } })
  assert.equal(proxyResponse.status, 503)
  assert.equal(upstream.requests.length, 0, 'an unavailable proxy request must not reach the upstream')

  const socket = await openRawSocket(port)
  t.after(() => socket.destroy())
  const probe = createSocketProbe(socket)
  socket.write(upgradeRequest(cookie))
  await probe.waitForClose()
  assert.match(probe.text, /^HTTP\/1\.1 503/, 'a fail-closed gate should answer 503 before closing the upgrade')
  assert.equal(upstream.upgrades.length, 0)
})

test('the sixth claim attempt in the rate window answers 429 with Retry-After', async t => {
  const { port, upstream } = await setup(t)

  const statuses = []
  let sixth
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const ticket = String.fromCharCode(65 + attempt).repeat(43)
    sixth = await httpRequest(port, `/pair/${ticket}`)
    statuses.push(sixth.status)
  }

  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401])
  assert.equal(statuses[5], 429)
  assert.match(String(sixth.headers['retry-after']), /^[1-9]\d*$/)
  assert.equal(upstream.requests.length, 0)
})

test('a body above the gate cap is refused before the upstream is contacted', async t => {
  const clock = createClock()
  const store = createFakeTicketStore({ now: clock.now })
  const upstream = createMockUpstream()
  const upstreamPort = await upstream.start()
  const gate = createGate({ upstreamPort, store, now: clock.now, launchToken: LAUNCH_TOKEN })
  const { port } = await gate.listen()
  t.after(async () => {
    await gate.close()
    await upstream.close()
  })

  const issued = store.issue({ name: 'phone' })
  const claimed = store.claim(issued.ticket, { name: 'phone' })
  const connectionsBefore = upstream.connectionCount

  const response = await requestDeclaredBody(port, '/api/upload', GATE_MAX_BODY_BYTES + 1, {
    host: TUNNEL_HOST,
    cookie: `dsh_pair=${claimed.token}`,
    origin: `https://${TUNNEL_HOST}`,
  })

  assert.ok(
    [413, 431].includes(response.status),
    `an oversized request body must answer 413/431, got ${response.status}`,
  )
  assert.equal(
    upstream.connectionCount,
    connectionsBefore,
    'the gate must refuse an oversized body before opening an upstream connection',
  )
  assert.equal(upstream.requests.length, 0)
})

test('any other path without a dsh_pair cookie is 401 and never reaches the upstream', async t => {
  const { port, upstream } = await setup(t)

  for (const path of ['/api/x?y=1', '/', '/api/remote.mux']) {
    const response = await httpRequest(port, path)
    assert.equal(response.status, 401, `${path} should require pairing`)
  }
  assert.equal(upstream.requests.length, 0)
  assert.equal(upstream.upgrades.length, 0)
})

test('a valid cookie proxies GET to the upstream with host, origin and referer rewritten', async t => {
  const { port, store, upstream, upstreamPort } = await setup(t)
  upstream.respond((req, res) => {
    res.writeHead(201, { 'content-type': 'text/plain', 'x-upstream': 'yes' })
    res.end('hello from upstream')
  })
  const paired = await pairPhone(port, store, 'phone', { upstream })

  const response = await httpRequest(port, '/api/x?y=1', {
    headers: {
      host: TUNNEL_HOST,
      cookie: paired.cookie,
      origin: `https://${TUNNEL_HOST}`,
      referer: `https://${TUNNEL_HOST}/some/page?keep=1`,
      connection: 'x-drop',
      'x-drop': '1',
      'keep-alive': 'timeout=5',
      te: 'trailers',
      'proxy-authorization': 'Basic abc',
    },
  })

  assert.equal(response.status, 201, 'the upstream status must be streamed back unchanged')
  assert.equal(response.headers['x-upstream'], 'yes', 'upstream headers must be streamed back')
  assert.equal(response.body, 'hello from upstream', 'the upstream body must be streamed back')

  assert.equal(proxiedRequests(upstream).length, 1)
  const forwarded = proxiedRequests(upstream)[0]
  assert.equal(forwarded.method, 'GET')
  assert.equal(forwarded.url, '/api/x?y=1')
  assert.equal(forwarded.headers.host, `127.0.0.1:${upstreamPort}`)
  assert.equal(forwarded.headers.origin, `http://127.0.0.1:${upstreamPort}`)
  assert.equal(forwarded.headers.referer, `http://127.0.0.1:${upstreamPort}`)
  assert.equal(
    forwarded.headers.cookie,
    'dsh_auth=exchange-ok',
    'the gate must replay the harness session cookie instead of the phone cookie',
  )
  assert.equal(forwarded.headers['x-drop'], undefined, 'a Connection-listed hop-by-hop header must be dropped')
  assert.equal(forwarded.headers['keep-alive'], undefined, 'keep-alive is hop-by-hop')
  assert.equal(forwarded.headers.te, undefined, 'TE is hop-by-hop')
  assert.equal(forwarded.headers['proxy-authorization'], undefined, 'proxy-authentication is hop-by-hop')

  await httpRequest(port, '/api/other', {
    headers: { host: TUNNEL_HOST, cookie: paired.cookie },
  })
  assert.equal(proxiedRequests(upstream)[1].headers.referer, undefined, 'a missing referer must not be invented')
})

test('proxied requests are stamped x-dsh-pair-proxied: 1 and a client value cannot override it', async t => {
  const { port, store, upstream } = await setup(t)
  const paired = await pairPhone(port, store, 'phone', { upstream })

  await httpRequest(port, '/api/stamp', {
    headers: {
      host: TUNNEL_HOST,
      cookie: paired.cookie,
      origin: `https://${TUNNEL_HOST}`,
      // A phone that somehow reached this proxy must not be able to suppress
      // the marker the operator routes trust.
      'x-dsh-pair-proxied': '0',
    },
  })
  await httpRequest(port, '/api/stamp-absent', {
    headers: { host: TUNNEL_HOST, cookie: paired.cookie },
  })

  const overridden = proxiedRequests(upstream).find(record => record.url === '/api/stamp')
  assert.ok(overridden, 'the proxied request never reached the upstream')
  assert.equal(overridden.headers['x-dsh-pair-proxied'], '1')
  const values = []
  for (let index = 0; index < overridden.rawHeaders.length; index += 2) {
    if (overridden.rawHeaders[index].toLowerCase() === 'x-dsh-pair-proxied') {
      values.push(overridden.rawHeaders[index + 1])
    }
  }
  assert.deepEqual(values, ['1'], 'the upstream must see exactly one stamp header, with value 1')

  const absent = proxiedRequests(upstream).find(record => record.url === '/api/stamp-absent')
  assert.ok(absent, 'the second proxied request never reached the upstream')
  assert.equal(
    absent.headers['x-dsh-pair-proxied'],
    '1',
    'the gate must add the stamp even when the client did not send one',
  )
})

test('a revoked device cookie is refused with 401 and never reaches the upstream', async t => {
  const { port, store, upstream } = await setup(t)
  const paired = await pairPhone(port, store, 'phone', { upstream })
  const { deviceId } = store.verify(paired.token)
  assert.equal(store.revoke(deviceId), true)

  const response = await httpRequest(port, '/api/x?y=1', {
    headers: { cookie: paired.cookie, origin: `https://${TUNNEL_HOST}` },
  })

  assert.equal(response.status, 401)
  assert.equal(proxiedRequests(upstream).length, 0)
})

test('a WebSocket upgrade with a valid cookie is proxied with the rewritten host and bytes in both directions', async t => {
  const { port, store, upstream, upstreamPort } = await setup(t)
  upstream.upgradeWith((req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.write('upstream-ready')
    socket.on('data', chunk => socket.write(Buffer.concat([Buffer.from('echo:'), chunk])))
  })
  const paired = await pairPhone(port, store, 'phone', { upstream })

  const socket = await openRawSocket(port)
  t.after(() => socket.destroy())
  const probe = createSocketProbe(socket)

  socket.write(upgradeRequest(paired.cookie))

  await probe.waitFor(/HTTP\/1\.1 101/)
  await probe.waitFor(/upstream-ready/)

  assert.equal(upstream.upgrades.length, 1)
  const upgrade = upstream.upgrades[0]
  assert.equal(upgrade.url, '/api/remote.mux')
  assert.equal(upgrade.headers.host, `127.0.0.1:${upstreamPort}`)
  assert.equal(upgrade.headers.origin, `http://127.0.0.1:${upstreamPort}`)
  assert.equal(upgrade.headers.cookie, 'dsh_auth=exchange-ok', 'the upgrade must replay the harness session cookie')

  socket.write('phone-ping')
  await probe.waitFor(/echo:phone-ping/, SOCKET_WAIT_MS)
})

test('a WebSocket upgrade without a valid cookie is refused and never reaches the upstream', async t => {
  const { port, upstream } = await setup(t)
  const socket = await openRawSocket(port)
  t.after(() => socket.destroy())
  const probe = createSocketProbe(socket)

  socket.write(upgradeRequest(undefined))
  await probe.waitForClose()

  assert.equal(upstream.upgrades.length, 0)
  if (probe.text.length > 0) {
    assert.match(probe.text, /^HTTP\/1\.1 401/, 'a refused upgrade should answer 401 before closing')
  }
})

test('close is idempotent, disposes upgraded sockets, and stops accepting connections', async t => {
  const { gate, port, store, upstream } = await setup(t)
  const paired = await pairPhone(port, store, 'phone', { upstream })

  const socket = await openRawSocket(port)
  t.after(() => socket.destroy())
  const probe = createSocketProbe(socket)
  socket.write(upgradeRequest(paired.cookie))
  await probe.waitFor(/HTTP\/1\.1 101/)

  await gate.close()
  await gate.close()

  await probe.waitForClose()
  await assert.rejects(httpRequest(port, '/pair/health'), 'the gate must stop listening after close()')
})

test('POST /pair/api/start over the tunnel is 404: control endpoints live on the harness listener', async t => {
  const { port, store, upstream } = await setup(t)
  const paired = await pairPhone(port, store, 'phone', { upstream })

  const controlEndpoints = [
    ['GET', '/pair/api/status'],
    ['POST', '/pair/api/start'],
    ['POST', '/pair/api/stop'],
    ['POST', '/pair/api/reissue'],
    ['POST', '/pair/api/revoke'],
    // The Tailscale setup surface is host-only too: detection, apply and the
    // funnel run must never be reachable through the tunnel.
    ['GET', '/pair/api/setup'],
    ['POST', '/pair/api/setup/apply'],
    ['POST', '/pair/api/setup/funnel'],
  ]
  for (const [method, path] of controlEndpoints) {
    const response = await httpRequest(port, path, {
      method,
      headers: { cookie: paired.cookie, 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ deviceId: 'device-1' }) : undefined,
    })
    assert.equal(response.status, 404, `${method} ${path} must not exist on the gate`)
  }
  assert.equal(proxiedRequests(upstream).length, 0)
})

/* ------------------------------------------------------------------------- *
 * A1/A4: installability and a human 401 for the tunnel front door.
 *
 * The real frontend dist links `./manifest.webmanifest` and the icons below.
 * Those bytes live in the DSH listener, so the gate is the only place that can
 * make them public without weakening the paired-device rule for every other
 * path. An unpaired phone that opens the tunnel in a browser deserves an
 * explanation, not a bare JSON error.
 * ------------------------------------------------------------------------- */

/** Assets the shipped DSH web UI needs before its install prompt appears. */
const PWA_ASSETS = [
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/favicon.svg',
  '/favicon-dark.svg',
]

/** The most recent upstream record for one url+method, or undefined. */
function lastUpstreamRequest(upstream, url, method = 'GET') {
  return [...upstream.requests].reverse().find(record => record.url === url && record.method === method)
}

test('the PWA assets are public: GET and HEAD reach the upstream without a cookie', async t => {
  const { port, upstream, upstreamPort } = await setup(t)
  const manifestBody = '{"name":"DeepSeek Harness","short_name":"DSH"}'

  upstream.respond((req, res, record) => {
    if (record.url === '/manifest.webmanifest') {
      res.writeHead(203, { 'content-type': 'application/manifest+json', 'x-pwa': 'manifest' })
      res.end(manifestBody)
      return
    }
    res.writeHead(200, { 'content-type': 'image/png', 'x-pwa': 'asset' })
    res.end('asset-bytes')
  })

  const manifest = await httpRequest(port, '/manifest.webmanifest')
  assert.equal(manifest.status, 203, 'the upstream status must be relayed unchanged')
  assert.equal(manifest.headers['x-pwa'], 'manifest', 'upstream headers must be relayed unchanged')
  assert.match(String(manifest.headers['content-type']), /application\/manifest\+json/)
  assert.equal(manifest.body, manifestBody, 'the upstream body must be relayed unchanged')

  const manifestHead = await httpRequest(port, '/manifest.webmanifest', { method: 'HEAD' })
  assert.equal(manifestHead.status, 203, 'HEAD must be relayed like GET without a cookie')
  assert.equal(manifestHead.headers['x-pwa'], 'manifest')
  assert.equal(manifestHead.body, '', 'a HEAD response must not carry a body')
  const manifestHeadRecord = lastUpstreamRequest(upstream, '/manifest.webmanifest', 'HEAD')
  assert.ok(manifestHeadRecord, 'HEAD /manifest.webmanifest never reached the upstream')
  assert.equal(manifestHeadRecord.headers.host, `127.0.0.1:${upstreamPort}`, 'the host must be rewritten')
  assert.equal(manifestHeadRecord.headers.cookie, undefined, 'a public asset must not send a cookie upstream')

  for (const asset of PWA_ASSETS.filter(candidate => candidate !== '/manifest.webmanifest')) {
    const get = await httpRequest(port, asset)
    assert.equal(get.status, 200, `GET ${asset} must be public`)
    assert.equal(get.body, 'asset-bytes', `GET ${asset} must relay the upstream body`)
    const getRecord = lastUpstreamRequest(upstream, asset)
    assert.ok(getRecord, `GET ${asset} never reached the upstream`)
    assert.equal(getRecord.headers.host, `127.0.0.1:${upstreamPort}`, `GET ${asset} must have its host rewritten`)
    assert.equal(getRecord.headers.cookie, undefined, `GET ${asset} must reach the upstream without a cookie`)

    const head = await httpRequest(port, asset, { method: 'HEAD' })
    assert.equal(head.status, 200, `HEAD ${asset} must be public`)
    assert.equal(head.body, '', `HEAD ${asset} must not carry a body`)
    const headRecord = lastUpstreamRequest(upstream, asset, 'HEAD')
    assert.ok(headRecord, `HEAD ${asset} never reached the upstream`)
    assert.equal(headRecord.headers.host, `127.0.0.1:${upstreamPort}`, `HEAD ${asset} must have its host rewritten`)
    assert.equal(headRecord.headers.cookie, undefined, `HEAD ${asset} must reach the upstream without a cookie`)
  }

  // Installability must not depend on a device cookie, not even a stale one.
  const stale = await httpRequest(port, '/manifest.webmanifest', {
    headers: { cookie: `dsh_pair=${'B'.repeat(43)}` },
  })
  assert.equal(stale.status, 203, 'a stale device cookie must not hide the public install assets')
})

test('a PWA asset path answers 405 with Allow for methods other than GET and HEAD', async t => {
  const { port, upstream } = await setup(t)

  for (const [method, path] of [
    ['POST', '/manifest.webmanifest'],
    ['PUT', '/icon-192.png'],
    ['DELETE', '/favicon.svg'],
  ]) {
    const response = await httpRequest(port, path, { method })
    assert.equal(response.status, 405, `${method} ${path} must answer 405`)
    const allow = new Set(
      String(response.headers.allow ?? '')
        .toLowerCase()
        .split(',')
        .map(value => value.trim())
        .filter(value => value.length > 0),
    )
    assert.ok(
      allow.has('get') && allow.has('head'),
      `Allow must list GET and HEAD for ${path}; got ${JSON.stringify(response.headers.allow)}`,
    )
  }
  assert.equal(upstream.requests.length, 0, 'a method-mismatched asset request must never reach the upstream')
})

test('a PWA asset name under /pair/ stays a ticket claim and is never proxied', async t => {
  const { port, upstream } = await setup(t)

  for (const path of ['/pair/manifest.webmanifest', '/pair/icon-192.png']) {
    const response = await httpRequest(port, path)
    assert.equal(response.status, 401, `${path} must stay a single-use ticket claim, not a public asset`)
  }
  assert.equal(upstream.requests.length, 0, 'no /pair/ request may be proxied to the upstream')
})

test('GET / with accept: text/html and no valid device cookie answers an HTML 401 that names the fix', async t => {
  const { port, upstream } = await setup(t)

  const anonymous = await httpRequest(port, '/', { headers: { accept: 'text/html,application/xhtml+xml' } })
  assert.equal(anonymous.status, 401, '/ must stay 401 without a device cookie')
  assert.match(String(anonymous.headers['content-type']), /text\/html/, 'a browser must get an HTML 401')
  assert.match(anonymous.body, /pair/i, 'the HTML 401 must tell the user how to pair again')
  assert.equal(proxiedRequests(upstream).length, 0, 'an unpaired / request must never be proxied')

  // A stale, revoked or bogus cookie must be treated like no cookie at all.
  const stale = await httpRequest(port, '/', {
    headers: { accept: 'text/html', cookie: `dsh_pair=${'B'.repeat(43)}` },
  })
  assert.equal(stale.status, 401)
  assert.match(String(stale.headers['content-type']), /text\/html/)
  assert.match(stale.body, /pair/i)
  assert.equal(proxiedRequests(upstream).length, 0, 'a rejected / request must never be proxied')

  // Machine callers keep the existing JSON shape.
  const machine = await httpRequest(port, '/', { headers: { accept: 'application/json' } })
  assert.equal(machine.status, 401)
  assert.match(String(machine.headers['content-type']), /application\/json/)
  const payload = JSON.parse(machine.body)
  assert.equal(typeof payload.error, 'string', 'the JSON 401 must keep an error field')
  assert.match(payload.error, /pair/i)
})

test('GET / with a valid device cookie still proxies to the upstream', async t => {
  const { port, store, upstream, upstreamPort } = await setup(t)
  upstream.respond((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('paired-page')
  })
  const paired = await pairPhone(port, store, 'phone', { upstream })

  const response = await httpRequest(port, '/', {
    headers: { cookie: paired.cookie, accept: 'text/html' },
  })

  assert.equal(response.status, 200, 'the human 401 must not affect a paired device')
  assert.equal(response.body, 'paired-page', 'a paired GET / must be proxied unchanged')

  const rootRecord = lastUpstreamRequest(upstream, '/')
  assert.ok(rootRecord, 'the paired GET / never reached the upstream')
  assert.equal(rootRecord.headers.host, `127.0.0.1:${upstreamPort}`, 'the upstream host must be rewritten')
})
