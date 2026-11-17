/**
 * Contract tests for pair/host/tunnel.js.
 *
 * The manager is fully injected: fake spawn, fake timers (setTimeout /
 * clearTimeout), manual clock, no real cloudflared and no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseTunnelUrl, createTunnelManager } from '../host/tunnel.js'
import {
  createClock,
  createFakeSpawn,
  createFakeTimers,
  flush,
  makeTempDir,
  removeTempDir,
} from './helpers.mjs'

const GATE_PORT = 43123
const CLOUDFLARED = 'C:\\dsh-home\\pair\\cloudflared.exe'
const TIMEOUT_MS = 30_000

async function setup(t) {
  const fakeSpawn = createFakeSpawn()
  const timers = createFakeTimers()
  const clock = createClock()
  const stateDir = await makeTempDir()
  t.after(async () => {
    await removeTempDir(stateDir)
  })

  const manager = createTunnelManager({
    spawn: fakeSpawn.spawn,
    stateDir,
    gatePort: GATE_PORT,
    cloudflaredPath: CLOUDFLARED,
    now: clock.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  })

  return { manager, fakeSpawn, timers, clock, stateDir }
}

function lastChild(fakeSpawn) {
  const call = fakeSpawn.calls.at(-1)
  assert.ok(call, 'the manager never called the injected spawn()')
  return call.child
}

test('parseTunnelUrl finds the first quick-tunnel URL and ignores unrelated output', () => {
  const output = [
    'INF Requesting new quick Tunnel on trycloudflare.com...',
    'INF |  https://brave-river-mango.trycloudflare.com  |',
    'INF +--------------------------------------------------------------------------------------------+',
    'INF Registered tunnel connection connIndex=0',
    'INF https://second-tunnel.trycloudflare.com',
  ].join('\n')

  assert.equal(parseTunnelUrl(output), 'https://brave-river-mango.trycloudflare.com')
})

test('parseTunnelUrl returns the URL from a single line without decoration', () => {
  assert.equal(
    parseTunnelUrl('2026-11-14T17:00:00Z INF Your quick Tunnel has been created! Visit it at https://plain-words.trycloudflare.com'),
    'https://plain-words.trycloudflare.com',
  )
})

test('parseTunnelUrl returns null when no quick-tunnel URL is present', () => {
  assert.equal(parseTunnelUrl(''), null)
  assert.equal(parseTunnelUrl('INF Requesting new quick Tunnel...\nINF still starting'), null)
})

test('parseTunnelUrl rejects http:// and partial URLs', () => {
  assert.equal(parseTunnelUrl('http://insecure.trycloudflare.com'), null)
  assert.equal(parseTunnelUrl('https://partial.trycloud'), null)
})

test('parseTunnelUrl rejects lookalike hosts', () => {
  assert.equal(parseTunnelUrl('https://evil-trycloudflare.com'), null)
  assert.equal(parseTunnelUrl('https://trusted.trycloudflare.com.evil.example'), null)
  assert.equal(parseTunnelUrl('https://trycloudflare.com'), null)
})

test('status starts off, and start spawns cloudflared with the exact argv', async t => {
  const { manager, fakeSpawn, timers } = await setup(t)

  assert.equal(manager.status().state, 'off')
  assert.equal(manager.status().url, null)

  await manager.start()

  assert.equal(manager.status().state, 'starting')
  assert.equal(manager.status().url, null)

  assert.equal(fakeSpawn.calls.length, 1)
  const call = fakeSpawn.calls[0]
  assert.equal(call.command, CLOUDFLARED)
  assert.deepEqual(call.args, ['tunnel', '--url', `http://127.0.0.1:${GATE_PORT}`, '--no-autoupdate'])
  assert.equal(call.options.stdio, 'pipe')
  assert.equal(call.options.windowsHide, true)
})

test('status transitions starting -> ready when the child prints the URL on stdout', async t => {
  const { manager, fakeSpawn } = await setup(t)
  await manager.start()
  const child = lastChild(fakeSpawn)

  child.emitStdout('INF Requesting new quick Tunnel...\n')
  await flush()
  assert.equal(manager.status().state, 'starting')

  child.emitStdout('INF https://ready-words.trycloudflare.com\n')
  await flush()

  assert.equal(manager.status().state, 'ready')
  assert.equal(manager.status().url, 'https://ready-words.trycloudflare.com')
})

test('status becomes ready when the URL is printed on stderr', async t => {
  const { manager, fakeSpawn } = await setup(t)
  await manager.start()

  lastChild(fakeSpawn).emitStderr('INF |  https://stderr-words.trycloudflare.com  |\n')
  await flush()

  assert.equal(manager.status().state, 'ready')
  assert.equal(manager.status().url, 'https://stderr-words.trycloudflare.com')
})

test('status becomes ready when the URL is split across two stdout chunks', async t => {
  const { manager, fakeSpawn } = await setup(t)
  await manager.start()
  const child = lastChild(fakeSpawn)

  child.emitStdout('INF https://split-chunk')
  await flush()
  assert.equal(manager.status().state, 'starting')

  child.emitStdout('-name.trycloudflare.com\n')
  await flush()

  assert.equal(manager.status().state, 'ready')
  assert.equal(manager.status().url, 'https://split-chunk-name.trycloudflare.com')
})

test('start while ready is a no-op and does not spawn a second child', async t => {
  const { manager, fakeSpawn } = await setup(t)
  await manager.start()
  lastChild(fakeSpawn).emitStdout('https://already-ready.trycloudflare.com\n')
  await flush()

  await manager.start()
  await manager.start()

  assert.equal(fakeSpawn.calls.length, 1)
  assert.equal(manager.status().state, 'ready')
  assert.equal(manager.status().url, 'https://already-ready.trycloudflare.com')
})

test('a child exit before the URL reports error with the exit code', async t => {
  const { manager, fakeSpawn, timers } = await setup(t)
  await manager.start()

  lastChild(fakeSpawn).exitWith(2)
  await flush()

  assert.equal(manager.status().state, 'error')
  assert.match(manager.status().message, /2/, 'error message must include the exit code')
  assert.equal(timers.pendingCount, 0, 'the 30 s timeout should be cleared when the child exits')
})

test('stop kills the child, resets to off, and is idempotent', async t => {
  const { manager, fakeSpawn } = await setup(t)
  await manager.start()
  const child = lastChild(fakeSpawn)
  child.emitStdout('https://stop-me.trycloudflare.com\n')
  await flush()
  assert.equal(manager.status().state, 'ready')

  await manager.stop()

  assert.equal(child.killCalls.length, 1)
  assert.equal(manager.status().state, 'off')
  assert.equal(manager.status().url, null)

  await manager.stop()
  assert.equal(child.killCalls.length, 1, 'stop() is idempotent and must not kill twice')
  assert.equal(manager.status().state, 'off')
})

test('a 30 second timeout without a URL reports error and kills the child', async t => {
  const { manager, fakeSpawn, timers } = await setup(t)
  await manager.start()
  const child = lastChild(fakeSpawn)

  assert.deepEqual(timers.pendingDelays(), [TIMEOUT_MS])

  timers.tick(TIMEOUT_MS - 1)
  await flush()
  assert.equal(manager.status().state, 'starting')
  assert.equal(child.killCalls.length, 0)

  timers.tick(1)
  await flush()

  assert.equal(manager.status().state, 'error')
  assert.match(manager.status().message, /timeout|timed out/i)
  assert.equal(child.killCalls.length, 1)
})
