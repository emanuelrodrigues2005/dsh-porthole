/**
 * Contract tests for pair/host/index.js — the Pair service.
 *
 * S1: revocation must end a live session. The service owns a real gate; two
 * devices are paired through it, two WebSocket upgrades are opened, and
 * `service.revoke(deviceId)` must destroy only the revoked device's socket.
 * `service.stop()` must still destroy every remaining upgraded socket.
 *
 * S5: once a ticket is claimed through the gate, `status()` must stop exposing
 * `pairUrl`/`matrix`/`expiresAt` for the burned ticket while still listing the
 * newly paired device.
 *
 * The tunnel is a fake child process and the upstream is a loopback mock; no
 * external network, no Cloudflare, no real DSH process.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { connect, createServer } from 'node:net'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createPairService } from '../host/index.js'
import {
  createFakeSpawn,
  createMockUpstream,
  flush,
  makeTempDir,
  removeTempDir,
} from './helpers.mjs'

const LAUNCH_TOKEN = 'launch-token-for-tests'
const TUNNEL_HOST = 'pair-service-test.trycloudflare.com'
const TUNNEL_URL = `https://${TUNNEL_HOST}`
const CLOSE_WAIT_MS = 1_000
const READY_WAIT_MS = 1_000

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

/** Polls a predicate without sleeping; the timeout is a failure bound only. */
async function waitFor(predicate, label, timeoutMs = READY_WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await flush()
  }
}

/** Reserves a loopback port for the gate, then releases it for the service. */
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
    waitFor(regex, timeoutMs = CLOSE_WAIT_MS) {
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
    async waitForClose(timeoutMs = CLOSE_WAIT_MS) {
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
  return `${lines.join('\r\n')}\r\n\r\n`
}

async function openUpgrade(port, cookie) {
  const socket = connect({ host: '127.0.0.1', port })
  await once(socket, 'connect')
  const probe = createSocketProbe(socket)
  socket.write(upgradeRequest(cookie))
  await probe.waitFor(/HTTP\/1\.1 101/)
  await probe.waitFor(/upstream-ready/)
  return { socket, probe }
}

/** Builds the service without starting it; owns cleanup via `t.after`. */
async function createServiceHarness(t) {
  const dir = await makeTempDir()
  const upstream = createMockUpstream()
  const upstreamPort = await upstream.start()
  const gatePort = await reservePort()
  const fakeSpawn = createFakeSpawn()
  const killedChildren = []

  upstream.respond((req, res, record) => {
    if (record.url.startsWith('/?token=')) {
      res.writeHead(303, {
        location: '/',
        'set-cookie': 'dsh_auth=exchange-ok; HttpOnly; Path=/; SameSite=Strict',
      })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('upstream-ok')
  })

  const service = createPairService({
    stateDir: dir,
    config: { gatePort },
    getUpstreamPort: () => upstreamPort,
    getLaunchToken: () => LAUNCH_TOKEN,
    resolveBinary: async () => 'C:\\fake\\cloudflared.exe',
    spawn: fakeSpawn.spawn,
    killTree: child => {
      killedChildren.push(child)
    },
  })

  t.after(async () => {
    await service.stop().catch(() => {})
    await upstream.close()
    await removeTempDir(dir)
  })

  return { service, upstream, upstreamPort, gatePort, fakeSpawn, killedChildren, stateDir: dir }
}

/** Starts the harness and drives the fake cloudflared output to `ready`. */
async function setupService(t) {
  const harness = await createServiceHarness(t)
  const { service, fakeSpawn } = harness

  await service.start()
  await waitFor(() => fakeSpawn.calls.length === 1, 'the fake cloudflared spawn')
  fakeSpawn.calls[0].child.emitStdout(`Quick Tunnel ready at ${TUNNEL_URL}\n`)
  await waitFor(() => {
    const status = service.status()
    if (status.state === 'error') throw new Error(`the pair service failed to start: ${status.message}`)
    return status.state === 'ready'
  }, 'the pair service to become ready')

  return harness
}

function pairingPath(status) {
  assert.equal(status.state, 'ready')
  assert.equal(typeof status.pairUrl, 'string', 'status() has no pairing URL to claim')
  const path = new URL(status.pairUrl).pathname
  assert.match(path, /^\/pair\/[A-Za-z0-9_-]+$/, 'status().pairUrl is not a pairing URL')
  return path
}

async function claimThroughGate(gatePort, service) {
  const status = service.status()
  const response = await httpRequest(gatePort, pairingPath(status))
  const setCookies = response.headers['set-cookie'] ?? []
  const deviceCookie = setCookies.find(cookie => cookie.startsWith('dsh_pair='))
  assert.ok(deviceCookie, `pairing did not set dsh_pair (status ${response.status})`)
  return { response, cookie: deviceCookie.split(';')[0] }
}

test('service.revoke closes the revoked device WebSocket and leaves the other device connected', async t => {
  const { service, gatePort } = await setupService(t)

  const first = await claimThroughGate(gatePort, service)
  const firstDevices = service.status().devices
  assert.equal(firstDevices.length, 1)
  const firstDeviceId = firstDevices[0].id

  // A second pairing must coexist: the first device's session stays live.
  await service.reissue()
  const second = await claimThroughGate(gatePort, service)
  const devices = service.status().devices
  assert.equal(devices.length, 2)
  const secondDevice = devices.find(device => device.id !== firstDeviceId)
  assert.ok(secondDevice, 'the second paired device is not listed')
  const secondDeviceId = secondDevice.id

  const firstConnection = await openUpgrade(gatePort, first.cookie)
  t.after(() => firstConnection.socket.destroy())
  const secondConnection = await openUpgrade(gatePort, second.cookie)
  t.after(() => secondConnection.socket.destroy())

  assert.equal(await service.revoke(firstDeviceId), true)

  // S1: the revoked device's upgraded socket must die within ~1 s.
  await firstConnection.probe.waitForClose(CLOSE_WAIT_MS)

  // The other device keeps working and still echoes bytes end to end.
  secondConnection.socket.write('still-alive')
  await secondConnection.probe.waitFor(/echo:still-alive/, CLOSE_WAIT_MS)
  assert.deepEqual(
    service.status().devices.map(device => device.id),
    [secondDeviceId],
    'only the surviving device may remain listed',
  )
})

test('service.stop closes every live upgraded socket', async t => {
  const { service, gatePort } = await setupService(t)

  const first = await claimThroughGate(gatePort, service)
  await service.reissue()
  const second = await claimThroughGate(gatePort, service)

  const firstConnection = await openUpgrade(gatePort, first.cookie)
  t.after(() => firstConnection.socket.destroy())
  const secondConnection = await openUpgrade(gatePort, second.cookie)
  t.after(() => secondConnection.socket.destroy())

  await service.stop()

  await firstConnection.probe.waitForClose(CLOSE_WAIT_MS)
  await secondConnection.probe.waitForClose(CLOSE_WAIT_MS)
})

test('status stops exposing the QR fields once the ticket has been claimed', async t => {
  const { service, gatePort } = await setupService(t)

  const before = service.status()
  assert.equal(before.state, 'ready')
  assert.equal(typeof before.pairUrl, 'string')
  assert.ok(Array.isArray(before.matrix) && before.matrix.length > 0, 'status() should expose a QR matrix')
  assert.equal(typeof before.expiresAt, 'number')
  assert.ok(before.expiresAt > Date.now(), 'the live ticket should expire in the future')
  assert.deepEqual(before.devices, [])

  const claim = await claimThroughGate(gatePort, service)
  assert.ok(claim.cookie)

  // S5: the burned ticket must not be offered as a QR again.
  const after = service.status()
  assert.equal(after.pairUrl, null, 'a burned ticket must not be offered as a pairing URL')
  assert.equal(after.matrix, null, 'a burned ticket must not render a QR')
  assert.equal(after.expiresAt, null, 'a burned ticket must not report a future expiry')
  assert.equal(after.devices.length, 1, 'the newly paired device must still be listed')
  assert.equal(after.devices[0].name, 'phone')
})

test('start becomes ready and exposes a ticketed URL on the tunnel host', async t => {
  const { service } = await setupService(t)
  const status = service.status()

  assert.equal(status.state, 'ready')
  assert.equal(status.url, TUNNEL_URL)
  assert.match(
    String(status.pairUrl),
    /^https:\/\/pair-service-test\.trycloudflare\.com\/pair\/[A-Za-z0-9_-]{43}$/,
  )
})

test('stop closes the gate and kills the cloudflared child', async t => {
  const { service, gatePort, fakeSpawn, killedChildren } = await setupService(t)
  assert.equal(fakeSpawn.calls.length, 1)

  await service.stop()

  assert.equal(killedChildren.length, 1, 'stop() must kill the cloudflared child')
  assert.equal(killedChildren[0], fakeSpawn.calls[0].child)
  await assert.rejects(
    httpRequest(gatePort, '/pair/health'),
    /ECONNREFUSED|connect/i,
    'the gate must stop listening after stop()',
  )
})

test('a tunnel error before the URL sets state error and releases the gate', async t => {
  const { service, gatePort, fakeSpawn } = await createServiceHarness(t)

  await service.start()
  await waitFor(() => fakeSpawn.calls.length === 1, 'the fake cloudflared spawn')
  fakeSpawn.calls[0].child.exitWith(7)

  await waitFor(() => service.status().state === 'error', 'the pair service to report error')
  const status = service.status()
  assert.match(String(status.message), /code 7/, 'the error must name the exit code')
  assert.equal(status.pairUrl, null)
  await waitFor(async () => {
    try {
      await httpRequest(gatePort, '/pair/health')
      return false
    } catch {
      return true
    }
  }, 'the gate to stop listening after a tunnel error')
})

test('revoke persists the revoked device to the state file', async t => {
  const { service, gatePort, stateDir } = await setupService(t)
  const claim = await claimThroughGate(gatePort, service)
  const device = service.status().devices[0]
  assert.ok(device)

  assert.equal(await service.revoke(device.id), true)

  assert.deepEqual(service.status().devices, [])
  const persisted = JSON.parse(await readFile(join(stateDir, 'devices.json'), 'utf8'))
  const record = persisted.devices.find(entry => entry.id === device.id)
  assert.ok(record, 'the revoked device is missing from devices.json')
  assert.equal(record.revoked, true)
  const rawToken = claim.cookie.slice('dsh_pair='.length)
  assert.ok(!JSON.stringify(persisted).includes(rawToken), 'devices.json contains the raw device token')
})

test('a second start while ready is a no-op', async t => {
  const { service, fakeSpawn } = await setupService(t)
  assert.equal(fakeSpawn.calls.length, 1)

  const status = await service.start()

  assert.equal(status.state, 'ready')
  assert.equal(fakeSpawn.calls.length, 1, 'a second start must not spawn another cloudflared child')
})

/* ------------------------------------------------------------------------- *
 * B1–B3: a stable public URL (Tailscale Funnel) and auto-start.
 *
 * With `publicUrl` the gate needs no tunnel process at all: Funnel terminates
 * TLS and forwards to the fixed local gate port. With `autoStart` the gate
 * comes back by itself when a device is already paired, so a phone that was
 * paired once keeps working after a harness restart.
 * ------------------------------------------------------------------------- */

const PUBLIC_URL = 'https://demo.tailnet.ts.net'

/** Upstream answers: the launch-token exchange plus a plain page. */
function respondLikeHarness(upstream) {
  upstream.respond((req, res, record) => {
    if (record.url.startsWith('/?token=')) {
      res.writeHead(303, {
        location: '/',
        'set-cookie': 'dsh_auth=exchange-ok; HttpOnly; Path=/; SameSite=Strict',
      })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('upstream-ok')
  })
}

/**
 * Pairs one phone through a real gate in cloudflared mode, so the state
 * directory holds the same `devices.json` a previous harness run would leave.
 * Nothing from the new behavior is used to seed the fixture.
 */
async function seedPairedDevice({ stateDir, upstreamPort, gatePort }) {
  const fakeSpawn = createFakeSpawn()
  const seeder = createPairService({
    stateDir,
    config: { gatePort },
    getUpstreamPort: () => upstreamPort,
    getLaunchToken: () => LAUNCH_TOKEN,
    resolveBinary: async () => 'C:\\fake\\cloudflared.exe',
    spawn: fakeSpawn.spawn,
    killTree: () => {},
  })
  try {
    await seeder.start()
    await waitFor(() => fakeSpawn.calls.length === 1, 'the seeding cloudflared spawn')
    fakeSpawn.calls[0].child.emitStdout(`Quick Tunnel ready at ${TUNNEL_URL}\n`)
    await waitFor(() => seeder.status().state === 'ready', 'the seeding pair service to become ready')
    const claim = await claimThroughGate(gatePort, seeder)
    assert.ok(claim.cookie, 'seeding did not pair a device')
  } finally {
    await seeder.stop().catch(() => {})
  }
}

/**
 * Harness for the public-URL service. The factory call is captured rather than
 * left to throw, so a test can assert that construction itself stays non-throwing.
 */
async function createPublicUrlHarness(t, { config = {}, seed = false, launchToken = () => LAUNCH_TOKEN } = {}) {
  const stateDir = await makeTempDir()
  const upstream = createMockUpstream()
  const upstreamPort = await upstream.start()
  const gatePort = await reservePort()
  respondLikeHarness(upstream)

  if (seed) await seedPairedDevice({ stateDir, upstreamPort, gatePort })

  const resolveCalls = []
  const fakeSpawn = createFakeSpawn()
  const killedChildren = []
  let service = null
  let factoryError = null
  try {
    service = createPairService({
      stateDir,
      config: { gatePort, publicUrl: PUBLIC_URL, ...config },
      getUpstreamPort: () => upstreamPort,
      getLaunchToken: launchToken,
      resolveBinary: async context => {
        resolveCalls.push(context)
        return 'C:\\fake\\cloudflared.exe'
      },
      spawn: fakeSpawn.spawn,
      killTree: child => killedChildren.push(child),
    })
  } catch (error) {
    factoryError = error
  }

  t.after(async () => {
    if (service !== null) await service.stop().catch(() => {})
    await upstream.close()
    await removeTempDir(stateDir)
  })

  return { service, factoryError, upstream, upstreamPort, gatePort, stateDir, fakeSpawn, resolveCalls, killedChildren }
}

/** Asserts the factory did not throw and returns the service. */
function requireService(harness) {
  assert.equal(
    harness.factoryError,
    null,
    harness.factoryError === null ? undefined : `createPairService threw during construction: ${harness.factoryError.message}`,
  )
  assert.ok(harness.service !== null, 'createPairService returned no service')
  return harness.service
}

/** Bounded poll that proves the service never left `off` inside the window. */
async function assertStaysOff(service, windowMs = 300) {
  const deadline = Date.now() + windowMs
  while (Date.now() < deadline) {
    assert.equal(service.status().state, 'off', 'the service must stay off')
    await flush()
  }
  assert.equal(service.status().state, 'off')
}

test('createPairService accepts publicUrl and autoStart alongside the existing config keys', async t => {
  const stateDir = await makeTempDir()
  t.after(() => removeTempDir(stateDir))
  const base = {
    stateDir,
    getUpstreamPort: () => 1234,
    getLaunchToken: () => LAUNCH_TOKEN,
  }

  const service = createPairService({
    ...base,
    config: {
      gatePort: 0,
      deviceTtlDays: 7,
      ticketTtlSeconds: 60,
      cloudflaredPath: '',
      publicUrl: PUBLIC_URL,
      autoStart: false,
    },
  })

  const status = service.status()
  assert.equal(status.state, 'off')
  assert.equal(status.url, null)
  assert.equal(status.pairUrl, null)
  assert.deepEqual(status.devices, [])

  // The key set stays closed: accepting the two new keys must not turn the
  // configuration into an anything-goes object.
  assert.throws(
    () => createPairService({ ...base, config: { publicUrl: PUBLIC_URL, autoStart: false, tunnelToken: 'x' } }),
    /unknown configuration key/,
    'an unknown configuration key must still be rejected',
  )
})

test('publicUrl must be a bare https origin and names publicUrl when it is not', async t => {
  const stateDir = await makeTempDir()
  t.after(() => removeTempDir(stateDir))

  const invalid = [
    'http://demo.tailnet.ts.net',
    'demo.tailnet.ts.net',
    'ftp://demo.tailnet.ts.net',
    'https://demo.tailnet.ts.net/device',
    'https://demo.tailnet.ts.net/?device=1',
    'https://demo.tailnet.ts.net/#top',
    '',
    42,
  ]

  for (const value of invalid) {
    assert.throws(
      () =>
        createPairService({
          stateDir,
          config: { publicUrl: value },
          getUpstreamPort: () => 1234,
          getLaunchToken: () => LAUNCH_TOKEN,
        }),
      error => {
        const message = String(error?.message ?? error)
        assert.match(message, /publicUrl/, `the rejection must name publicUrl; got ${JSON.stringify(message)}`)
        assert.doesNotMatch(
          message,
          /unknown configuration key/i,
          'publicUrl is a known key; only its value may be rejected',
        )
        return true
      },
      `publicUrl ${JSON.stringify(value)} must be rejected`,
    )
  }
})

test('autoStart must be a boolean and names autoStart when it is not', async t => {
  const stateDir = await makeTempDir()
  t.after(() => removeTempDir(stateDir))

  for (const value of ['true', 1, {}]) {
    assert.throws(
      () =>
        createPairService({
          stateDir,
          config: { autoStart: value },
          getUpstreamPort: () => 1234,
          getLaunchToken: () => LAUNCH_TOKEN,
        }),
      error => {
        const message = String(error?.message ?? error)
        assert.match(message, /autoStart/, `the rejection must name autoStart; got ${JSON.stringify(message)}`)
        assert.doesNotMatch(
          message,
          /unknown configuration key/i,
          'autoStart is a known key; only its value may be rejected',
        )
        return true
      },
      `autoStart ${JSON.stringify(value)} must be rejected`,
    )
  }
})

test('publicUrl mode starts the gate on the configured port with no cloudflared work', async t => {
  const harness = await createPublicUrlHarness(t, { config: { publicUrl: `${PUBLIC_URL}/` } })
  const { gatePort, fakeSpawn, resolveCalls } = harness
  const service = requireService(harness)

  await service.start()
  await waitFor(() => service.status().state === 'ready', 'the pair service to become ready from publicUrl alone', 2_000)

  const status = service.status()
  assert.equal(status.url, PUBLIC_URL, 'a trailing slash on publicUrl must be normalized away')
  assert.match(
    String(status.pairUrl),
    /^https:\/\/demo\.tailnet\.ts\.net\/pair\/[A-Za-z0-9_-]{43}$/,
    'status().pairUrl must point at the stable origin',
  )
  assert.equal(status.message, undefined)
  assert.equal(status.stable, true, 'a publicUrl result must be flagged stable for the panel')

  // The gate really listens on the fixed port, which is what Funnel forwards to.
  const health = await httpRequest(gatePort, '/pair/health')
  assert.equal(health.status, 200, 'the gate must listen on the configured gatePort')

  assert.equal(resolveCalls.length, 0, 'publicUrl mode must never resolve a cloudflared binary')
  assert.equal(fakeSpawn.calls.length, 0, 'publicUrl mode must never spawn cloudflared')

  await service.stop()
  const stopped = service.status()
  assert.equal(stopped.state, 'off')
  assert.equal(stopped.url, null)
  await assert.rejects(
    httpRequest(gatePort, '/pair/health'),
    /ECONNREFUSED|connect/i,
    'stop() must close the gate',
  )
})

test('autoStart starts the gate by itself when a device is already paired', async t => {
  const harness = await createPublicUrlHarness(t, { config: { autoStart: true }, seed: true })
  const { gatePort, fakeSpawn, resolveCalls } = harness
  const service = requireService(harness)

  // No start() call: the factory must decide from the persisted device list.
  await waitFor(() => service.status().state === 'ready', 'the pair service to auto-start', 2_000)

  const status = service.status()
  assert.equal(status.state, 'ready')
  assert.equal(status.url, PUBLIC_URL)
  assert.equal(status.devices.length, 1, 'the seeded device must still be listed')
  assert.equal((await httpRequest(gatePort, '/pair/health')).status, 200, 'auto-start must really listen')
  assert.equal(resolveCalls.length, 0, 'auto-start with publicUrl must never resolve cloudflared')
  assert.equal(fakeSpawn.calls.length, 0, 'auto-start with publicUrl must never spawn cloudflared')
})

test('autoStart keeps the stable gate alive before any device is paired', async t => {
  const harness = await createPublicUrlHarness(t, { config: { autoStart: true } })
  const { gatePort, fakeSpawn, resolveCalls } = harness
  const service = requireService(harness)

  // No start() call and no paired device: the public URL must still be served
  // so a phone can reach the pairing page and the operator can issue a ticket.
  await waitFor(() => service.status().state === 'ready', 'the pair service to auto-start', 2_000)

  const status = service.status()
  assert.equal(status.state, 'ready')
  assert.equal(status.url, PUBLIC_URL)
  assert.equal(status.devices.length, 0, 'no device exists yet')
  assert.ok(
    typeof status.pairUrl === 'string' && status.pairUrl.startsWith(`${PUBLIC_URL}/pair/`),
    'a fresh pairing link must be available at boot',
  )
  assert.equal((await httpRequest(gatePort, '/pair/health')).status, 200, 'auto-start must really listen')
  assert.equal(resolveCalls.length, 0, 'auto-start with publicUrl must never resolve cloudflared')
  assert.equal(fakeSpawn.calls.length, 0, 'auto-start with publicUrl must never spawn cloudflared')
})

test('autoStart: false stays off even when a device is paired', async t => {
  const harness = await createPublicUrlHarness(t, { config: { autoStart: false }, seed: true })
  const { gatePort, fakeSpawn } = harness
  const service = requireService(harness)

  await assertStaysOff(service, 300)
  assert.equal(fakeSpawn.calls.length, 0)
  await assert.rejects(
    httpRequest(gatePort, '/pair/health'),
    /ECONNREFUSED|connect/i,
    'autoStart: false must leave the gate closed',
  )
})

test('a failing auto-start does not throw out of the factory and reports an error status', async t => {
  const harness = await createPublicUrlHarness(t, {
    config: { autoStart: true },
    seed: true,
    launchToken: () => null,
  })
  const { gatePort } = harness
  const service = requireService(harness)

  await waitFor(() => service.status().state === 'error', 'the failed auto-start to report error', 2_000)
  const status = service.status()
  assert.equal(status.state, 'error')
  assert.equal(typeof status.message, 'string', 'a failed auto-start must explain itself')
  assert.ok(status.message.length > 0, 'the error message must not be empty')
  await assert.rejects(
    httpRequest(gatePort, '/pair/health'),
    /ECONNREFUSED|connect/i,
    'a failed auto-start must not leave a gate listening',
  )
})
