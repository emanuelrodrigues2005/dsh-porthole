/**
 * Contract tests for the concurrency-safe half of pair/host/setup.js and for the
 * configuration precedence it introduces.
 *
 * Pinned here:
 *   - `$DSH_HOME/pair/config.json` is written atomically, mode 0600, version 1;
 *   - the three writable keys are validated and merged, never reset;
 *   - a corrupt or unsupported file disables the row loudly instead of pairing
 *     with the wrong origin;
 *   - precedence is row config < override file, re-read at construction and on
 *     every restart, so `apply()` goes live without a harness restart;
 *   - a busy gate port answers 409 and writes nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { createPairService } from '../host/index.js'
import {
  CONFIG_FILE_VERSION,
  createSetupService,
  readConfigOverride,
  writeConfigOverride,
} from '../host/setup.js'
import { createMockUpstream, makeTempDir, removeTempDir } from './helpers.mjs'

const TS_URL = 'https://studio.tailnet-abc.ts.net'
const OTHER_URL = 'https://laptop.tailnet-abc.ts.net'
const LAUNCH_TOKEN = 'setup-config-launch-token'

/** Reserves a loopback port, then releases it. */
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

/** A server that keeps a port busy for the duration of a test. */
async function occupyPort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  return {
    port,
    async close() {
      await new Promise(resolve => server.close(() => resolve()))
    },
  }
}

function createSetup(dir, { config = {}, restarts = [] } = {}) {
  const file = join(dir, 'config.json')
  const setup = createSetupService({
    stateDir: dir,
    configFile: file,
    platform: 'win32',
    execFile: (binary, args, options, callback) => callback(new Error('tailscale is not installed'), '', ''),
    // Mirrors the pair service: the effective config is the base plus the file.
    getConfig: () => ({
      gatePort: 0,
      publicUrl: '',
      autoStart: true,
      cloudflaredPath: '',
      ...config,
      ...readConfigOverride(file),
    }),
    restart: async () => {
      restarts.push('restart')
    },
    resolveBinary: async () => {
      throw new Error('no cloudflared here')
    },
  })
  return { setup, file, restarts }
}

/* ------------------------------------------------------------------------- *
 * The file itself
 * ------------------------------------------------------------------------- */

test('a missing override file is an empty override, not an error', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))

  assert.deepEqual(readConfigOverride(join(dir, 'config.json')), {})
  assert.deepEqual(readConfigOverride(''), {})
})

test('writeConfigOverride is atomic, versioned and leaves no temporary file behind', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  const file = join(dir, 'config.json')

  const payload = writeConfigOverride(file, { publicUrl: `${TS_URL}/`, gatePort: 8791, autoStart: false })

  assert.deepEqual(payload, { version: CONFIG_FILE_VERSION, publicUrl: TS_URL, gatePort: 8791, autoStart: false })
  const text = readFileSync(file, 'utf8')
  assert.equal(text, `${JSON.stringify({ version: 1, publicUrl: TS_URL, gatePort: 8791, autoStart: false }, null, 2)}\n`)
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp')), [], 'a temp file survived the rename')
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600, 'the override holds an origin, not a secret: 0600 anyway')
  }
  assert.deepEqual(readConfigOverride(file), { publicUrl: TS_URL, gatePort: 8791, autoStart: false })
})

test('a second write replaces the file in one rename (no partial content)', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  const file = join(dir, 'config.json')

  writeConfigOverride(file, { publicUrl: TS_URL, gatePort: 8791 })
  writeConfigOverride(file, { publicUrl: OTHER_URL })

  assert.deepEqual(readConfigOverride(file), { publicUrl: OTHER_URL })
})

test('readConfigOverride rejects corrupt, unsupported and unknown-key files by name', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  const file = join(dir, 'config.json')

  writeFileSync(file, '{ not json')
  assert.throws(() => readConfigOverride(file), /is not valid JSON/u)

  writeFileSync(file, JSON.stringify({ version: 2, publicUrl: TS_URL }))
  assert.throws(() => readConfigOverride(file), /version 2/u)

  writeFileSync(file, JSON.stringify({ version: 1, tunnelToken: 'x' }))
  assert.throws(() => readConfigOverride(file), /unknown setup key/u)

  writeFileSync(file, JSON.stringify({ version: 1, publicUrl: 'http://not-https' }))
  assert.throws(() => readConfigOverride(file), /https origin/u)

  writeFileSync(file, JSON.stringify([1, 2]))
  assert.throws(() => readConfigOverride(file), /JSON object/u)
})

/* ------------------------------------------------------------------------- *
 * apply()
 * ------------------------------------------------------------------------- */

test('apply writes the file, asks the service to restart and returns the fresh status', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  const { setup, file, restarts } = createSetup(dir)

  const status = await setup.apply({ publicUrl: TS_URL })

  assert.deepEqual(restarts, ['restart'])
  assert.deepEqual(readConfigOverride(file), { publicUrl: TS_URL })
  assert.equal(status.config.publicUrl, TS_URL)
  assert.equal(status.ok, true)
  assert.deepEqual(status.needs, ['install'], 'the status must be re-detected after the restart')
})

test('apply merges into an existing override instead of resetting it', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  const { setup, file } = createSetup(dir)
  writeConfigOverride(file, { gatePort: 8791, autoStart: false })

  await setup.apply({ publicUrl: TS_URL })

  assert.deepEqual(readConfigOverride(file), { gatePort: 8791, autoStart: false, publicUrl: TS_URL })
})

test('apply validates before writing: an invalid patch leaves the file untouched', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  const { setup, file, restarts } = createSetup(dir)
  writeConfigOverride(file, { publicUrl: TS_URL })

  for (const bad of [{ publicUrl: 'http://plain' }, { gatePort: 0 }, { autoStart: 'yes' }, { tunnelToken: 'x' }]) {
    await assert.rejects(setup.apply(bad), error => error.status === 400, JSON.stringify(bad))
  }

  assert.deepEqual(readConfigOverride(file), { publicUrl: TS_URL }, 'a rejected patch must not be persisted')
  assert.deepEqual(restarts, [], 'a rejected patch must not restart the service')
})

test('apply answers 409 for a busy gate port and writes nothing', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  const busy = await occupyPort()
  t.after(() => busy.close())
  const { setup, file, restarts } = createSetup(dir)

  await assert.rejects(setup.apply({ gatePort: busy.port }), error => {
    assert.equal(error.status, 409)
    assert.match(error.message, new RegExp(`port ${String(busy.port)}`, 'u'))
    return true
  })

  assert.equal(readConfigOverride(file).gatePort, undefined)
  assert.deepEqual(restarts, [])
})

test('apply skips the port probe when the port is already the effective one', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  const port = await reservePort()
  // Pretend the gate is already listening there: probing would report the
  // service's own listener as busy.
  const busy = await occupyPortOn(port)
  t.after(() => busy.close())
  const { setup, restarts } = createSetup(dir, { config: { gatePort: port } })

  const status = await setup.apply({ gatePort: port })

  assert.deepEqual(restarts, ['restart'])
  assert.equal(status.config.gatePort, port)
})

/** Occupies one specific loopback port. */
async function occupyPortOn(port) {
  const server = createServer()
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  return {
    port,
    async close() {
      await new Promise(resolve => server.close(() => resolve()))
    },
  }
}

test('an empty patch is a no-op: no write, no restart', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  const { setup, file, restarts } = createSetup(dir)

  const status = await setup.apply({})

  assert.deepEqual(restarts, [])
  assert.deepEqual(readdirSync(dir).sort(), [], 'an empty patch must not create a file')
  assert.equal(readConfigOverride(file).publicUrl, undefined)
  assert.equal(status.ok, true)
})

/* ------------------------------------------------------------------------- *
 * Precedence inside the pair service
 * ------------------------------------------------------------------------- */

function createService(dir, { row = {}, upstreamPort = 9, configFile = join(dir, 'config.json') } = {}) {
  return createPairService({
    stateDir: dir,
    configFile,
    config: { gatePort: 0, autoStart: false, ...row },
    getUpstreamPort: () => upstreamPort,
    getLaunchToken: () => LAUNCH_TOKEN,
    resolveBinary: async () => {
      throw new Error('cloudflared is unused in these tests')
    },
  })
}

test('the override file wins over the row config at construction', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  writeConfigOverride(join(dir, 'config.json'), { publicUrl: TS_URL, gatePort: 9123, autoStart: false })

  const service = createService(dir, { row: { gatePort: 8791, autoStart: true } })

  const config = service.config()
  assert.equal(config.publicUrl, TS_URL)
  assert.equal(config.gatePort, 9123)
  assert.equal(config.autoStart, false)
  await service.stop().catch(() => {})
})

test('the row config still applies for keys the file does not set', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  writeConfigOverride(join(dir, 'config.json'), { publicUrl: TS_URL })

  const service = createService(dir, { row: { gatePort: 8791, autoStart: false, deviceTtlDays: 7 } })

  const config = service.config()
  assert.equal(config.gatePort, 8791)
  assert.equal(config.deviceTtlDays, 7)
  assert.equal(config.publicUrl, TS_URL)
  await service.stop().catch(() => {})
})

test('restart() re-reads the override file so a new origin goes live', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  const configFile = join(dir, 'config.json')
  const service = createService(dir, { configFile, row: { autoStart: false } })
  t.after(() => service.stop().catch(() => {}))
  assert.equal(service.config().publicUrl, '')

  writeConfigOverride(configFile, { publicUrl: TS_URL })
  await service.restart()

  assert.equal(service.config().publicUrl, TS_URL)
  assert.equal(service.status().state, 'off', 'restart must not start a service that was off')
})

test('restart() keeps a public-URL service running and reports the new URL', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  const upstream = createMockUpstream()
  const upstreamPort = await upstream.start()
  t.after(() => upstream.close())
  const gatePort = await reservePort()
  const configFile = join(dir, 'config.json')
  writeConfigOverride(configFile, { publicUrl: TS_URL, gatePort, autoStart: true })
  const service = createService(dir, { configFile, upstreamPort })
  t.after(() => service.stop().catch(() => {}))

  // `autoStart` starts the gate asynchronously at construction.
  await waitFor(() => service.status().state === 'ready', 'the gate to come up from the override file')
  assert.equal(service.status().url, TS_URL)

  writeConfigOverride(configFile, { publicUrl: OTHER_URL, gatePort, autoStart: true })
  const restarted = await service.restart()
  await waitFor(() => service.status().state === 'ready', 'the restarted gate to come up')
  const status = service.status()

  assert.equal(restarted.state, 'starting', 'restart answers before the listener is up')
  assert.equal(status.state, 'ready')
  assert.equal(status.url, OTHER_URL)
  assert.equal(status.stable, true)
  assert.equal(service.config().publicUrl, OTHER_URL)
})

test('a corrupt override file disables the row loudly instead of pairing with the wrong origin', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), '{ nope')

  assert.throws(() => createService(dir), /config\.json is not valid JSON/u)
})

test('setup.apply() drives the real service to the new public URL without a restart', async t => {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  const upstream = createMockUpstream()
  const upstreamPort = await upstream.start()
  t.after(() => upstream.close())
  const gatePort = await reservePort()
  const configFile = join(dir, 'config.json')
  const service = createService(dir, { configFile, upstreamPort })
  t.after(() => service.stop().catch(() => {}))
  const setup = createSetupService({
    stateDir: dir,
    configFile,
    platform: 'win32',
    execFile: (binary, args, options, callback) => callback(new Error('tailscale is not installed'), '', ''),
    getConfig: () => service.config(),
    restart: () => service.restart(),
    resolveBinary: async () => {
      throw new Error('no cloudflared here')
    },
  })

  const status = await setup.apply({ publicUrl: TS_URL, gatePort, autoStart: true })

  assert.equal(status.config.publicUrl, TS_URL)
  assert.equal(status.config.gatePort, gatePort)
  assert.equal(status.config.effectiveGatePort, gatePort)
  await waitFor(() => service.status().state === 'ready', 'the restarted gate to come up')
  assert.equal(service.status().state, 'ready', 'the gate must be serving the applied origin')
  assert.equal(service.status().url, TS_URL)
  assert.deepEqual(readConfigOverride(configFile), { publicUrl: TS_URL, gatePort, autoStart: true })
})

/** Polls a predicate without sleeping; the timeout is a failure bound only. */
async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setImmediate(resolve))
  }
}
