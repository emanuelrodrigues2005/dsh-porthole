/**
 * Contract tests for the Tailscale setup operator routes in pair/host/routes.js.
 *
 * Pinned here:
 *   - the exact guard order for `GET /pair/api/setup` (proxied marker → 401/403
 *     → loopback → owner) and that no setup call happens before it passes;
 *   - `apply` answers 400 for an invalid patch, 409 for a busy gate port and
 *     restarts through the setup service on success;
 *   - `funnel` answers 409 with install guidance when Tailscale is missing, and
 *     the route itself never takes an argument from the request body;
 *   - the body cap for a setup patch is 2 KiB.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { registerSetupRoutes } from '../host/routes.js'
import { DEFAULT_PUBLIC_GATE_PORT, FUNNEL_POLICY_JSON } from '../host/setup.js'
import { flush } from './helpers.mjs'

const OWNER_ADMISSION = { peer: { principal: { kind: 'owner' } } }
const TS_URL = 'https://studio.tailnet-abc.ts.net'

const DETECTION = {
  ok: true,
  platform: 'win32',
  os: {
    id: 'windows',
    label: 'Windows',
    install: [{ label: 'winget', command: 'winget install --id Tailscale.Tailscale -e', url: 'https://tailscale.com/download' }],
  },
  tailscale: {
    installed: true,
    version: '1.68.1',
    running: true,
    dnsName: 'studio.tailnet-abc.ts.net',
    suggestedUrl: TS_URL,
    tailscaleIPs: ['100.101.102.103'],
    binary: 'tailscale',
  },
  funnel: { on: true, url: TS_URL, targetPort: 8791, matchesGatePort: true },
  config: {
    gatePort: 8791,
    effectiveGatePort: 8791,
    publicUrl: '',
    autoStart: true,
    cloudflaredPath: '',
    cloudflaredPresent: false,
    cloudflaredVerified: false,
  },
  needs: ['apply'],
  docs: {
    setupUrl: 'https://tailscale.com/download',
    adminDnsUrl: 'https://login.tailscale.com/admin/dns',
    adminAclUrl: 'https://login.tailscale.com/admin/acls/file',
    funnelDocsUrl: 'https://tailscale.com/kb/1223/funnel',
  },
  policy: { json: FUNNEL_POLICY_JSON, acl: '{}\n' },
}

function createFakeSetup() {
  const calls = []
  return {
    calls,
    async status() {
      calls.push(['status'])
      return DETECTION
    },
    async apply(patch) {
      calls.push(['apply', patch])
      if (patch !== null && typeof patch === 'object' && patch.publicUrl === 'http://plain') {
        throw Object.assign(new Error('publicUrl must be a bare https origin'), { status: 400 })
      }
      if (patch !== null && typeof patch === 'object' && patch.gatePort === 7000) {
        throw Object.assign(new Error('gate port 7000 is already in use on 127.0.0.1'), { status: 409 })
      }
      return { ...DETECTION, needs: ['done'] }
    },
    async runFunnel() {
      calls.push(['funnel'])
      return { ok: true, output: 'Funnel started', port: DEFAULT_PUBLIC_GATE_PORT }
    },
    async failFunnel() {
      throw Object.assign(new Error('Tailscale is not installed or not on PATH. Install it first: winget …'), { status: 409 })
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
        const entry = { kind: route.kind, path: route.path, handler: route.handler, disposed: false }
        registered.push(entry)
        return () => {
          if (entry.disposed) return
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

function createFakeRequest({ method = 'GET', url = '/pair/api/setup', remoteAddress = '127.0.0.1', headers = {}, body } = {}) {
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

function setup(options) {
  const fake = createFakeContext(options)
  const service = {}
  const setupService = createFakeSetup()
  const dispose = registerSetupRoutes(fake.ctx, service, setupService)
  return { ...fake, service, setupService, dispose }
}

function routeFor(registered, path) {
  const route = registered.find(entry => entry.path === path)
  assert.ok(route, `registerSetupRoutes did not register ${path}`)
  return route
}

/* ------------------------------------------------------------------------- *
 * Registration and guard order
 * ------------------------------------------------------------------------- */

test('registers exactly the three setup routes as exact web-server routes', () => {
  const { registered } = setup()

  assert.deepEqual(registered.map(entry => `${entry.kind} ${entry.path}`).sort(), [
    'exact /pair/api/setup',
    'exact /pair/api/setup/apply',
    'exact /pair/api/setup/funnel',
  ])
  for (const route of registered) assert.equal(typeof route.handler, 'function')
})

test('GET /pair/api/setup returns the detection object', async () => {
  const { registered, setupService } = setup()
  const result = await invoke(routeFor(registered, '/pair/api/setup'))

  assert.equal(result.status, 200)
  assert.match(String(result.headers['content-type']), /application\/json/u)
  assert.deepEqual(result.json, DETECTION)
  assert.deepEqual(result.json.needs, ['apply'])
  assert.deepEqual(result.json.policy.json, FUNNEL_POLICY_JSON)
  assert.deepEqual(setupService.calls, [['status']])
})

for (const rejection of [401, 403]) {
  test(`requestRejection ${rejection} is answered verbatim before any setup work`, async () => {
    const { registered, setupService, connectionCalls, setRejection } = setup()
    setRejection(rejection)

    const result = await invoke(routeFor(registered, '/pair/api/setup'), { remoteAddress: '10.1.2.3' })

    assert.equal(result.status, rejection)
    assert.deepEqual(connectionCalls.map(call => call.name), ['requestRejection'])
    assert.deepEqual(setupService.calls, [])
  })
}

test('a non-loopback socket is refused with 403 before admit and before detection', async () => {
  const { registered, setupService, connectionCalls } = setup()
  const result = await invoke(routeFor(registered, '/pair/api/setup'), { remoteAddress: '10.1.2.3' })

  assert.equal(result.status, 403)
  assert.deepEqual(connectionCalls.map(call => call.name), ['requestRejection'])
  assert.deepEqual(setupService.calls, [])
})

test('a non-owner peer is refused with 403 before detection or apply', async () => {
  for (const admission of [{ peer: { principal: { kind: 'viewer' } } }, { rejection: 401 }]) {
    const { registered, setupService, setAdmission } = setup()
    setAdmission(admission)

    for (const [path, method] of [
      ['/pair/api/setup', 'GET'],
      ['/pair/api/setup/apply', 'POST'],
      ['/pair/api/setup/funnel', 'POST'],
    ]) {
      const result = await invoke(routeFor(registered, path), { method })
      assert.equal(result.status, 403, `${path} accepted ${JSON.stringify(admission)}`)
    }
    assert.deepEqual(setupService.calls, [])
  }
})

test('a gate-proxied request is refused with 403 before the connection is consulted', async () => {
  const { registered, setupService, connectionCalls } = setup()

  const result = await invoke(routeFor(registered, '/pair/api/setup'), {
    headers: { 'x-dsh-pair-proxied': '1' },
  })

  assert.equal(result.status, 403)
  assert.deepEqual(connectionCalls, [])
  assert.deepEqual(setupService.calls, [])
})

test('the setup routes are method-locked', async () => {
  const cases = [
    ['/pair/api/setup', 'POST', 'GET'],
    ['/pair/api/setup/apply', 'GET', 'POST'],
    ['/pair/api/setup/funnel', 'GET', 'POST'],
  ]
  for (const [path, method, allowed] of cases) {
    const { registered, setupService } = setup()
    const result = await invoke(routeFor(registered, path), { method })

    assert.equal(result.status, 405, `${method} ${path} should be 405`)
    assert.equal(String(result.headers.allow ?? '').toUpperCase(), allowed)
    assert.deepEqual(setupService.calls, [])
  }
})

test('a missing setup service answers 503 instead of throwing', async () => {
  const fake = createFakeContext()
  registerSetupRoutes(fake.ctx, {}, null)

  for (const [path, method] of [
    ['/pair/api/setup', 'GET'],
    ['/pair/api/setup/apply', 'POST'],
    ['/pair/api/setup/funnel', 'POST'],
  ]) {
    const result = await invoke(routeFor(fake.registered, path), { method })
    assert.equal(result.status, 503, `${path} must answer 503 without a setup service`)
  }
})

/* ------------------------------------------------------------------------- *
 * apply
 * ------------------------------------------------------------------------- */

test('POST /pair/api/setup/apply passes the patch and answers the fresh status', async () => {
  const { registered, setupService } = setup()
  const result = await invoke(routeFor(registered, '/pair/api/setup/apply'), {
    method: 'POST',
    body: JSON.stringify({ publicUrl: TS_URL, gatePort: 8791 }),
  })

  assert.equal(result.status, 200)
  assert.deepEqual(setupService.calls, [['apply', { publicUrl: TS_URL, gatePort: 8791 }]])
  assert.deepEqual(result.json.needs, ['done'])
})

test('POST /pair/api/setup/apply accepts an empty body as an empty patch', async () => {
  const { registered, setupService } = setup()
  const result = await invoke(routeFor(registered, '/pair/api/setup/apply'), { method: 'POST' })

  assert.equal(result.status, 200)
  assert.deepEqual(setupService.calls, [['apply', {}]])
})

test('an invalid patch answers 400 with the validation message', async () => {
  const { registered } = setup()
  const result = await invoke(routeFor(registered, '/pair/api/setup/apply'), {
    method: 'POST',
    body: JSON.stringify({ publicUrl: 'http://plain' }),
  })

  assert.equal(result.status, 400)
  assert.match(result.json.error, /https origin/u)
})

test('a busy gate port answers 409', async () => {
  const { registered } = setup()
  const result = await invoke(routeFor(registered, '/pair/api/setup/apply'), {
    method: 'POST',
    body: JSON.stringify({ gatePort: 7000 }),
  })

  assert.equal(result.status, 409)
  assert.match(result.json.error, /port 7000/u)
})

test('a non-object body answers 400 and a body over 2 KiB answers 413', async () => {
  {
    const { registered, setupService } = setup()
    const result = await invoke(routeFor(registered, '/pair/api/setup/apply'), {
      method: 'POST',
      body: JSON.stringify([TS_URL]),
    })
    assert.equal(result.status, 400)
    assert.deepEqual(setupService.calls, [])
  }
  {
    const { registered, setupService } = setup()
    const result = await invoke(routeFor(registered, '/pair/api/setup/apply'), {
      method: 'POST',
      body: JSON.stringify({ publicUrl: TS_URL, padding: 'x'.repeat(3_000) }),
    })
    assert.equal(result.status, 413)
    assert.deepEqual(setupService.calls, [])
  }
  {
    const { registered } = setup()
    const result = await invoke(routeFor(registered, '/pair/api/setup/apply'), {
      method: 'POST',
      body: '{ not json',
    })
    assert.equal(result.status, 400)
  }
})

/* ------------------------------------------------------------------------- *
 * funnel
 * ------------------------------------------------------------------------- */

test('POST /pair/api/setup/funnel runs the fixed command and re-detects', async () => {
  const { registered, setupService } = setup()
  const result = await invoke(routeFor(registered, '/pair/api/setup/funnel'), { method: 'POST' })

  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.output, 'Funnel started')
  assert.equal(result.json.port, DEFAULT_PUBLIC_GATE_PORT)
  assert.deepEqual(result.json.status, DETECTION, 'the response carries the re-detected status')
  assert.deepEqual(setupService.calls, [['funnel'], ['status']])
})

test('POST /pair/api/setup/funnel takes no argument from the request body', async () => {
  const { registered, setupService } = setup()
  const result = await invoke(routeFor(registered, '/pair/api/setup/funnel'), {
    method: 'POST',
    body: JSON.stringify({ command: 'rm -rf /', port: 3000 }),
  })

  assert.equal(result.status, 200)
  assert.deepEqual(setupService.calls, [['funnel'], ['status']], 'the body must never reach the runner')
})

test('POST /pair/api/setup/funnel answers 409 with install guidance when Tailscale is missing', async () => {
  const fake = createFakeContext()
  const setupService = createFakeSetup()
  setupService.runFunnel = setupService.failFunnel
  registerSetupRoutes(fake.ctx, {}, setupService)

  const result = await invoke(routeFor(fake.registered, '/pair/api/setup/funnel'), { method: 'POST' })

  assert.equal(result.status, 409)
  assert.match(result.json.error, /not installed/u)
  assert.match(result.json.error, /winget/u)
})
