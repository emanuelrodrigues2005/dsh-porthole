/**
 * Wiring test for index.js: the Pair row must contribute the Tailscale setup
 * routes and the two `pair_setup_*` tools, with the override file living at
 * `$DSH_HOME/pair/config.json`.
 *
 * The detection itself probes for a real `tailscale` CLI, so this file asserts
 * the *shape* of the answer — 200, a known `needs` entry, the policy constant —
 * and never a particular installation state. Every request waits for the
 * handler to finish writing, because `webServer.register` handlers are
 * fire-and-forget by contract.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { join } from 'node:path'

import { apply } from '../../index.js'
import { FUNNEL_POLICY_JSON, readConfigOverride } from '../host/setup.js'
import { flush, makeTempDir, removeTempDir } from './helpers.mjs'

const NEED_VALUES = new Set(['install', 'up', 'https', 'funnel-policy', 'funnel-run', 'apply', 'done'])
/** Four 5 s probes plus a restart: a generous bound, never a sleep. */
const HANDLER_TIMEOUT_MS = 30_000

function createFakeRequest({ method = 'GET', url = '/pair/api/setup', remoteAddress = '127.0.0.1', headers = {}, body } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body)])
  request.method = method
  request.url = url
  request.headers = { 'content-type': 'application/json', ...headers }
  request.socket = { remoteAddress }
  return request
}

function createFakeResponse() {
  const state = { statusCode: 0, chunks: [], ended: false }
  const response = {
    get statusCode() {
      return state.statusCode
    },
    writeHead(statusCode) {
      state.statusCode = statusCode
      return response
    },
    setHeader() {
      return response
    },
    write(chunk) {
      state.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      return true
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) response.write(chunk)
      state.ended = true
      return response
    },
    get writableEnded() {
      return state.ended
    },
    get bodyText() {
      return Buffer.concat(state.chunks).toString('utf8')
    },
  }
  return response
}

/** Applies the row with a fake host context and returns what it contributed. */
async function applyRow(t, config) {
  const dir = await makeTempDir('dsh-pair-wiring-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  // The row's `ctx.effect` returns the teardown; run it so the gate stops and
  // the test process can exit.
  const cleanups = []
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch {
        /* the row is already gone */
      }
    }
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await removeTempDir(dir)
  })

  const registered = []
  const toolNames = []
  const warnings = []
  const ctx = {
    webServer: {
      port: 4321,
      register(route) {
        const entry = { path: route.path, kind: route.kind, handler: route.handler }
        registered.push(entry)
        return () => {
          const index = registered.indexOf(entry)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    connection: {
      requestRejection: () => undefined,
      admit: () => ({ peer: { principal: { kind: 'owner' } } }),
      authenticatedUrl: () => 'http://127.0.0.1/?token=wiring-launch-token',
    },
    logger: {
      warn(message) {
        warnings.push(message)
      },
    },
    effect(callback) {
      const result = callback()
      if (typeof result === 'function') cleanups.push(result)
      return result
    },
    inject(_services, callback) {
      callback({
        ...ctx,
        tools: {
          register(definition) {
            toolNames.push(definition.name)
            return () => {}
          },
        },
      })
      return { dispose: async () => {} }
    },
  }

  apply(ctx, config)
  return { registered, toolNames, warnings, dir }
}

/** Invokes one registered route and waits for its response to be written. */
async function invoke(registered, path, request) {
  const route = registered.find(entry => entry.path === path)
  assert.ok(route, `${path} is not registered; got ${registered.map(entry => entry.path).join(', ')}`)
  const response = createFakeResponse()
  await route.handler(createFakeRequest({ url: path, ...request }), response)
  const deadline = Date.now() + HANDLER_TIMEOUT_MS
  while (!response.writableEnded) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await flush()
  }
  const text = response.bodyText
  return { status: response.statusCode, text, json: text.length === 0 ? undefined : JSON.parse(text) }
}

/** Reserves a loopback port for the gate, then releases it. */
async function reservePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
  })
  return port
}

test('the row registers the three setup routes next to the lifecycle and push routes', async t => {
  const { registered, warnings } = await applyRow(t, { gatePort: 0, autoStart: false })

  assert.deepEqual(warnings, [], `the row must load cleanly; got ${warnings.join(' | ')}`)
  const paths = registered.map(entry => entry.path)
  for (const path of ['/pair/api/setup', '/pair/api/setup/apply', '/pair/api/setup/funnel']) {
    assert.ok(paths.includes(path), `${path} is not registered; got ${paths.join(', ')}`)
  }
  for (const path of ['/pair/api/status', '/pair/api/start', '/pair/api/devices/notifications', '/pair/api/push/test']) {
    assert.ok(paths.includes(path), `${path} must stay registered`)
  }
  for (const route of registered) assert.equal(route.kind, 'exact')
})

test('the row registers pair_setup_status and pair_setup_apply with the other tools', async t => {
  const { toolNames } = await applyRow(t, { gatePort: 0, autoStart: false })

  assert.ok(toolNames.includes('pair_notify_report'), `the report tool must stay; got ${toolNames.join(', ')}`)
  assert.ok(toolNames.includes('pair_setup_status'), `pair_setup_status is missing; got ${toolNames.join(', ')}`)
  assert.ok(toolNames.includes('pair_setup_apply'), `pair_setup_apply is missing; got ${toolNames.join(', ')}`)
})

test('the wired row answers detection and applies the override file under $DSH_HOME/pair', async t => {
  const { registered, dir } = await applyRow(t, { gatePort: 0, autoStart: false })

  const detected = await invoke(registered, '/pair/api/setup', { method: 'GET' })
  assert.equal(detected.status, 200)
  assert.equal(detected.json.ok, true)
  assert.ok(Array.isArray(detected.json.os.install) && detected.json.os.install.length > 0, 'os.install must be present')
  assert.equal(detected.json.policy.json, FUNNEL_POLICY_JSON)
  assert.ok(Array.isArray(detected.json.needs) && detected.json.needs.length > 0)
  for (const need of detected.json.needs) assert.ok(NEED_VALUES.has(need), `unexpected need ${need}`)
  assert.equal(detected.json.config.publicUrl, '')
  assert.equal(typeof detected.json.config.cloudflaredPresent, 'boolean')

  const gatePort = await reservePort()
  const applied = await invoke(registered, '/pair/api/setup/apply', {
    method: 'POST',
    body: JSON.stringify({ publicUrl: 'https://wired.tailnet.ts.net', gatePort, autoStart: true }),
  })

  assert.equal(applied.status, 200, applied.text)
  assert.equal(applied.json.config.publicUrl, 'https://wired.tailnet.ts.net')
  assert.equal(applied.json.config.effectiveGatePort, gatePort)
  // The file is written under the harness home, not somewhere global.
  assert.deepEqual(readConfigOverride(join(dir, 'pair', 'config.json')), {
    publicUrl: 'https://wired.tailnet.ts.net',
    gatePort,
    autoStart: true,
  })
})
