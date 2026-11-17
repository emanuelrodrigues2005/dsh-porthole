/**
 * Contract tests for pair/host/routes.js — the operator control endpoints on
 * the harness listener (never on the tunnel-facing gate).
 *
 * Guard order under test:
 *   1. ctx.connection.requestRejection(request) -> answer its status verbatim
 *   2. request.socket.remoteAddress must be loopback -> 403
 *   3. ctx.connection.admit(request) must yield an owner peer -> 403
 * Only then does the route call the pair service.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { registerPairRoutes } from '../host/routes.js'
import { flush } from './helpers.mjs'

const OWNER_ADMISSION = { peer: { principal: { kind: 'owner' } } }
const ROUTES = [
  ['GET', '/pair/api/status'],
  ['POST', '/pair/api/start'],
  ['POST', '/pair/api/stop'],
  ['POST', '/pair/api/reissue'],
  ['POST', '/pair/api/revoke'],
]
const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
const NON_LOOPBACK_ADDRESSES = ['10.0.0.5', '192.168.1.10', null]

const STATUS_PAYLOAD = {
  state: 'ready',
  url: 'https://brave-river-mango.trycloudflare.com',
  expiresAt: 1_763_000_600_000,
  devices: [
    { id: 'device-1', name: 'phone', createdAt: 1_763_000_000_000, lastSeenAt: 1_763_000_100_000 },
  ],
}

function createFakeService() {
  const calls = []
  return {
    calls,
    status() {
      calls.push(['status'])
      return STATUS_PAYLOAD
    },
    async start() {
      calls.push(['start'])
      return { state: 'starting', url: null }
    },
    async stop() {
      calls.push(['stop'])
      return { state: 'off', url: null }
    },
    async reissue() {
      calls.push(['reissue'])
      return { expiresAt: 1_763_000_300_000 }
    },
    async revoke(deviceId) {
      calls.push(['revoke', deviceId])
      return true
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
        connectionCalls.push({ name: 'requestRejection', request })
        return state.rejection
      },
      admit(request) {
        connectionCalls.push({ name: 'admit', request })
        return state.admission
      },
    },
    webServer: {
      register(route) {
        const entry = {
          kind: route.kind,
          path: route.path,
          handler: route.handler,
          disposed: false,
        }
        registered.push(entry)
        return () => {
          if (entry.disposed) return
          entry.disposed = true
          const index = registered.indexOf(entry)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    effect(callback) {
      return callback()
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

function createFakeRequest({
  method = 'GET',
  url = '/pair/api/status',
  remoteAddress = '127.0.0.1',
  headers = {},
  body,
} = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  request.method = method
  request.url = url
  request.headers = { 'content-type': 'application/json', ...headers }
  request.socket = { remoteAddress }
  return request
}

function createFakeResponse() {
  const state = { statusCode: 200, headers: {}, chunks: [], bodyText: '', ended: false }
  const response = {
    get statusCode() {
      return state.statusCode
    },
    set statusCode(value) {
      state.statusCode = value
    },
    get headers() {
      return state.headers
    },
    get bodyText() {
      return state.bodyText
    },
    setHeader(name, value) {
      state.headers[String(name).toLowerCase()] = value
      return response
    },
    getHeader(name) {
      return state.headers[String(name).toLowerCase()]
    },
    writeHead(statusCode, headers) {
      state.statusCode = statusCode
      if (headers !== undefined && headers !== null) {
        for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
      }
      return response
    },
    write(chunk) {
      state.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) response.write(chunk)
      state.bodyText = Buffer.concat(state.chunks).toString('utf8')
      state.ended = true
      return response
    },
    get writableEnded() {
      return state.ended
    },
  }
  return response
}

async function invoke(route, options = {}) {
  const request = createFakeRequest({ url: route.path, ...options })
  const response = createFakeResponse()
  await route.handler(request, response)
  await flush()
  const body = response.bodyText
  let json
  if (body.length > 0) {
    try {
      json = JSON.parse(body)
    } catch {
      json = undefined
    }
  }
  return { request, response, status: response.statusCode, headers: response.headers, body, json }
}

function routeFor(registered, path) {
  const route = registered.find(entry => entry.path === path)
  assert.ok(route, `registerPairRoutes did not register ${path}`)
  return route
}

function setup(options) {
  const fake = createFakeContext(options)
  const service = createFakeService()
  registerPairRoutes(fake.ctx, service)
  return { ...fake, service }
}

test('registers exactly the five operator routes as exact web-server routes', () => {
  const { registered } = setup()

  const seen = registered.map(entry => `${entry.kind} ${entry.path}`).sort()
  assert.deepEqual(seen, [
    'exact /pair/api/reissue',
    'exact /pair/api/revoke',
    'exact /pair/api/start',
    'exact /pair/api/status',
    'exact /pair/api/stop',
  ])
  for (const route of registered) {
    assert.equal(typeof route.handler, 'function', `${route.path} must have a handler`)
  }
})

test('status GET returns state, url, expiresAt and public device fields only', async () => {
  const { registered, service } = setup()
  const result = await invoke(routeFor(registered, '/pair/api/status'))

  assert.equal(result.status, 200)
  assert.match(String(result.headers['content-type']), /application\/json/)
  assert.deepEqual(result.json, STATUS_PAYLOAD)

  assert.deepEqual(Object.keys(result.json.devices[0]).sort(), ['createdAt', 'id', 'lastSeenAt', 'name'])
  const serialized = JSON.stringify(result.json)
  for (const forbidden of ['token', 'tokenHash', 'secret', 'PairError']) {
    assert.ok(!serialized.includes(forbidden), `status exposed ${forbidden}`)
  }
  assert.deepEqual(service.calls, [['status']])
})

test('POST /pair/api/start calls service.start and answers ok', async () => {
  const { registered, service } = setup()
  const result = await invoke(routeFor(registered, '/pair/api/start'), { method: 'POST' })

  assert.equal(result.status, 200)
  assert.deepEqual(result.json, { ok: true })
  assert.deepEqual(service.calls, [['start']])
})

test('POST /pair/api/stop calls service.stop and answers ok', async () => {
  const { registered, service } = setup()
  const result = await invoke(routeFor(registered, '/pair/api/stop'), { method: 'POST' })

  assert.equal(result.status, 200)
  assert.deepEqual(result.json, { ok: true })
  assert.deepEqual(service.calls, [['stop']])
})

test('POST /pair/api/reissue calls service.reissue and answers ok', async () => {
  const { registered, service } = setup()
  const result = await invoke(routeFor(registered, '/pair/api/reissue'), { method: 'POST' })

  assert.equal(result.status, 200)
  assert.deepEqual(result.json, { ok: true })
  assert.deepEqual(service.calls, [['reissue']])
})

test('POST /pair/api/revoke passes the deviceId from the JSON body', async () => {
  const { registered, service } = setup()
  const result = await invoke(routeFor(registered, '/pair/api/revoke'), {
    method: 'POST',
    body: JSON.stringify({ deviceId: 'device-7' }),
  })

  assert.equal(result.status, 200)
  assert.deepEqual(result.json, { ok: true })
  assert.deepEqual(service.calls, [['revoke', 'device-7']])
})

for (const rejection of [401, 403]) {
  test(`requestRejection ${rejection} is answered verbatim before any other guard`, async () => {
    const { registered, service, connectionCalls, setRejection } = setup()
    setRejection(rejection)

    const result = await invoke(routeFor(registered, '/pair/api/status'), {
      remoteAddress: '10.1.2.3',
      method: 'GET',
    })

    assert.equal(result.status, rejection)
    assert.deepEqual(
      connectionCalls.map(call => call.name),
      ['requestRejection'],
      'admit() must not run after requestRejection() already refused',
    )
    assert.deepEqual(service.calls, [])
  })
}

for (const address of LOOPBACK_ADDRESSES) {
  test(`an owner request from loopback ${address} is admitted`, async () => {
    const { registered } = setup()
    const result = await invoke(routeFor(registered, '/pair/api/status'), { remoteAddress: address })

    assert.equal(result.status, 200)
  })
}

test('every route refuses a non-loopback socket address with 403 before admit', async () => {
  for (const address of NON_LOOPBACK_ADDRESSES) {
    for (const [, path] of ROUTES) {
      const { registered, service, connectionCalls } = setup()
      const result = await invoke(routeFor(registered, path), {
        method: path === '/pair/api/status' ? 'GET' : 'POST',
        remoteAddress: address,
      })

      assert.equal(result.status, 403, `${path} accepted remoteAddress ${String(address)}`)
      assert.deepEqual(
        connectionCalls.map(call => call.name),
        ['requestRejection'],
        `${path} called admit() for a non-loopback request`,
      )
      assert.deepEqual(service.calls, [], `${path} called the service for a non-loopback request`)
    }
  }
})

test('every route refuses a request without an owner peer with 403', async () => {
  const rejections = [
    { peer: { principal: { kind: 'viewer' } } },
    { rejection: 401 },
  ]
  for (const admission of rejections) {
    for (const [, path] of ROUTES) {
      const { registered, service, setAdmission } = setup()
      setAdmission(admission)

      const result = await invoke(routeFor(registered, path), {
        method: path === '/pair/api/status' ? 'GET' : 'POST',
      })

      assert.equal(result.status, 403, `${path} accepted ${JSON.stringify(admission)}`)
      assert.deepEqual(service.calls, [], `${path} called the service for a non-owner peer`)
    }
  }
})

test('the owner guard runs requestRejection before admit', async () => {
  const { registered, connectionCalls, setAdmission } = setup()
  setAdmission(OWNER_ADMISSION)

  const result = await invoke(routeFor(registered, '/pair/api/status'))

  assert.equal(result.status, 200)
  assert.deepEqual(connectionCalls.map(call => call.name), ['requestRejection', 'admit'])
})

test('every route refuses a gate-proxied request with 403 before requestRejection or admit', async () => {
  // Presence of the marker is decisive, whatever its value: only the gate sets
  // it while proxying, and a phone must never drive operator routes even if a
  // future path-normalisation change lets one reach the harness listener.
  for (const value of ['1', '0', 'true', '']) {
    for (const [, path] of ROUTES) {
      const { registered, service, connectionCalls } = setup()

      const result = await invoke(routeFor(registered, path), {
        method: path === '/pair/api/status' ? 'GET' : 'POST',
        headers: { 'x-dsh-pair-proxied': value },
      })

      assert.equal(
        result.status,
        403,
        `${path} accepted a request carrying x-dsh-pair-proxied=${JSON.stringify(value)}`,
      )
      assert.deepEqual(
        connectionCalls,
        [],
        `${path} consulted requestRejection/admit for a gate-proxied request`,
      )
      assert.deepEqual(service.calls, [], `${path} called the service for a gate-proxied request`)
    }
  }
})

test('status is GET only and the mutations are POST only', async () => {
  const cases = [
    ['/pair/api/status', 'POST', 'GET'],
    ['/pair/api/start', 'GET', 'POST'],
    ['/pair/api/stop', 'GET', 'POST'],
    ['/pair/api/reissue', 'GET', 'POST'],
    ['/pair/api/revoke', 'GET', 'POST'],
  ]
  for (const [path, method, allowed] of cases) {
    const { registered, service } = setup()
    const result = await invoke(routeFor(registered, path), { method })

    assert.equal(result.status, 405, `${method} ${path} should be 405`)
    assert.equal(
      String(result.headers.allow ?? '').toUpperCase(),
      allowed,
      `${method} ${path} should advertise Allow: ${allowed}`,
    )
    assert.deepEqual(service.calls, [])
  }
})
