/**
 * Shared fakes for the Pair plugin tests.
 *
 * Everything here is deterministic and offline: a manual clock, a manual timer
 * queue, a temp-directory factory, a fake child_process.spawn, and a real
 * loopback mock upstream used as the "DSH listener" stand-in.
 *
 * No helper sleeps or waits on wall-clock time.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter, once } from 'node:events'
import { createServer } from 'node:http'

export const MINUTE_MS = 60_000
export const DAY_MS = 86_400_000

/** Let queued microtasks and one event-loop turn run. */
export function flush() {
  return new Promise(resolve => setImmediate(resolve))
}

/**
 * Manual epoch-millisecond clock. `now` is the injectable function every
 * factory receives; `advance` moves time forward without waiting.
 */
export function createClock(start = Date.UTC(2026, 0, 1, 12, 0, 0)) {
  let current = start
  return {
    now: () => current,
    advance(ms) {
      current += ms
      return current
    },
    set(ms) {
      current = ms
      return current
    },
  }
}

/**
 * Temporary directory under os.tmpdir(). Callers must remove it in `after()`.
 */
export async function makeTempDir(prefix = 'dsh-pair-test-') {
  return mkdtemp(join(tmpdir(), prefix))
}

/** Remove a directory created by {@link makeTempDir}, ignoring absence. */
export async function removeTempDir(dir) {
  await rm(dir, { recursive: true, force: true })
}

/**
 * Manual timer queue that stands in for global setTimeout/clearTimeout.
 *
 * The returned handles expose `unref()`/`ref()` like Node's Timeout object so
 * production code may call them safely. `tick(ms)` runs every callback that
 * became due, in due order, synchronously.
 */
export function createFakeTimers() {
  let elapsed = 0
  let nextId = 1
  const pending = new Map()

  const setTimeoutFn = (callback, delay = 0, ...args) => {
    const id = nextId++
    const handle = {
      id,
      ms: delay,
      unref() {
        return handle
      },
      ref() {
        return handle
      },
      hasRef() {
        return true
      },
    }
    pending.set(id, {
      due: elapsed + delay,
      ms: delay,
      callback: () => callback(...args),
    })
    return handle
  }

  const clearTimeoutFn = handle => {
    const id = handle !== null && typeof handle === 'object' ? handle.id : handle
    pending.delete(id)
  }

  const tick = ms => {
    elapsed += ms
    const due = []
    for (const [id, timer] of pending) {
      if (timer.due <= elapsed) due.push([id, timer])
    }
    due.sort((a, b) => a[1].due - b[1].due)
    for (const [id, timer] of due) {
      pending.delete(id)
      timer.callback()
    }
  }

  return {
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    tick,
    get pendingCount() {
      return pending.size
    },
    pendingDelays() {
      return [...pending.values()].map(timer => timer.ms)
    },
  }
}

/**
 * Fake ChildProcess: EventEmitter with stdout/stderr streams, kill recording,
 * and helpers a test uses to drive the tunnel manager.
 */
export function createFakeChild() {
  const child = new EventEmitter()
  child.stdout = Object.assign(new EventEmitter(), {
    setEncoding() {
      return child.stdout
    },
  })
  child.stderr = Object.assign(new EventEmitter(), {
    setEncoding() {
      return child.stderr
    },
  })
  child.stdio = ['ignore', child.stdout, child.stderr]
  child.pid = 4242
  child.exitCode = null
  child.signalCode = null
  child.killed = false
  child.killCalls = []
  child.kill = signal => {
    child.killCalls.push(signal ?? 'SIGTERM')
    child.killed = true
    return true
  }
  child.emitStdout = text => child.stdout.emit('data', text)
  child.emitStderr = text => child.stderr.emit('data', text)
  child.exitWith = code => {
    child.exitCode = code
    child.emit('exit', code, null)
  }
  child.failWith = error => {
    child.errored = error
    child.emit('error', error)
  }
  return child
}

/**
 * Fake child_process.spawn. Records every call as
 * `{ command, args, options, child }` and returns a controllable child.
 */
export function createFakeSpawn() {
  const calls = []
  const spawn = (command, args, options) => {
    const child = createFakeChild()
    calls.push({ command, args, options, child })
    // Node emits 'spawn' asynchronously after a successful spawn.
    queueMicrotask(() => child.emit('spawn'))
    return child
  }
  return { spawn, calls }
}

/**
 * In-memory ticket store implementing the same public API as
 * pair/host/tickets.js, so gate tests need no filesystem or hashing.
 */
export function createFakeTicketStore({ now, ticketTtlMs = 5 * MINUTE_MS, deviceTtlMs = 30 * DAY_MS } = {}) {
  let sequence = 0
  let tokenSequence = 0
  let liveTicket = null
  const tickets = new Map()
  const devices = new Map()

  const fail = code => {
    const error = new Error(code)
    error.code = code
    throw error
  }

  // Deterministic 32-byte token shape (43 base64url chars); the fake store is
  // not the place to test randomness.
  const nextToken = () => {
    tokenSequence += 1
    const bytes = Buffer.alloc(32)
    bytes.writeUInt32BE(tokenSequence, 0)
    return bytes.toString('base64url')
  }

  return {
    issue({ name = 'phone' } = {}) {
      const ticket = nextToken()
      const expiresAt = now() + ticketTtlMs
      tickets.clear()
      liveTicket = { ticket, name, expiresAt, used: false }
      tickets.set(ticket, liveTicket)
      return { ticket, expiresAt }
    },

    claim(ticket, options = {}) {
      const record = tickets.get(String(ticket ?? ''))
      if (record === undefined) fail('ticket-invalid')
      if (record.used) fail('ticket-used')
      if (now() >= record.expiresAt) fail('ticket-expired')
      record.used = true
      const deviceId = `device-${++sequence}`
      const token = nextToken()
      const createdAt = now()
      devices.set(deviceId, {
        id: deviceId,
        name: options.name ?? record.name,
        token,
        createdAt,
        lastSeenAt: createdAt,
        revoked: false,
        expiresAt: createdAt + deviceTtlMs,
      })
      return { deviceId, token, expiresAt: createdAt + deviceTtlMs }
    },

    verify(token) {
      for (const device of devices.values()) {
        if (device.token === token && !device.revoked && now() < device.expiresAt) {
          return { deviceId: device.id }
        }
      }
      return null
    },

    revoke(deviceId) {
      const device = devices.get(deviceId)
      if (device === undefined) return false
      device.revoked = true
      return true
    },

    listDevices() {
      return [...devices.values()]
        .filter(device => !device.revoked)
        .map(device => ({
          id: device.id,
          name: device.name,
          createdAt: device.createdAt,
          lastSeenAt: device.lastSeenAt,
        }))
    },

    /** Test-only peek used to prove the gate never leaked a ticket. */
    ticketState() {
      return liveTicket
    },
  }
}

/**
 * Loopback HTTP + WebSocket-upgrade mock standing in for the untouched DSH
 * listener. It records every request/upgrade so tests can assert what the gate
 * forwarded, and answers through a replaceable handler.
 */
export function createMockUpstream() {
  const requests = []
  const upgrades = []
  const sockets = new Set()
  let port
  let connectionCount = 0

  let httpHandler = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('upstream-ok')
  }
  let upgradeHandler = (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.write('upstream-ready')
    socket.on('data', chunk => {
      socket.write(Buffer.concat([Buffer.from('echo:'), chunk]))
    })
  }

  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        // Preserved so a test can prove a header was sent exactly once.
        rawHeaders: req.rawHeaders.slice(),
        body: Buffer.concat(chunks).toString('utf8'),
      }
      requests.push(record)
      httpHandler(req, res, record)
    })
  })

  server.on('upgrade', (req, socket, head) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const record = { url: req.url, headers: req.headers }
    upgrades.push(record)
    upgradeHandler(req, socket, head, record)
  })

  server.on('connection', socket => {
    connectionCount += 1
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  return {
    requests,
    upgrades,
    get port() {
      return port
    },
    /** Every TCP connection accepted so far, including aborted requests. */
    get connectionCount() {
      return connectionCount
    },
    respond(handler) {
      const previous = httpHandler
      httpHandler = handler
      return previous
    },
    upgradeWith(handler) {
      upgradeHandler = handler
    },
    async start() {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      port = server.address().port
      return port
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      if (!server.listening) return
      await new Promise(resolve => server.close(resolve))
    },
  }
}
