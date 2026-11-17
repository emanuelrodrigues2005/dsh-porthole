/**
 * Pairing tickets and paired devices.
 *
 * Security rules enforced here:
 * - tickets live only in memory; at most one is live and it is single use;
 * - device tokens are never written to disk, only HMAC-SHA256(token) keyed by
 *   the per-home secret;
 * - every ticket and token comparison is constant time.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
const DEFAULT_TICKET_TTL_MS = 5 * MINUTE_MS
const DEFAULT_DEVICE_TTL_MS = 30 * DAY_MS
const TOKEN_BYTES = 32
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const STATE_VERSION = 1
const MAX_NAME_LENGTH = 64

/** A pairing failure with a stable machine-readable code. */
export class PairError extends Error {
  constructor(code, message) {
    super(message ?? code)
    this.name = 'PairError'
    this.code = code
  }
}

function invalid(code, message) {
  throw new PairError(code, message)
}

function newToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

function hashToken(secret, token) {
  return createHmac('sha256', secret).update(String(token)).digest()
}

function equalBuffers(left, right) {
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Constant-time equality for two same-length base64url hash strings. */
function equalHashes(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function normalizeName(value, fallback) {
  const name = typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
  return name.slice(0, MAX_NAME_LENGTH)
}

function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`pair tickets: ${label} must be a positive integer`)
  }
  return value
}

function readState(stateFile) {
  let text
  try {
    text = readFileSync(stateFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw new Error(`pair tickets: cannot read ${stateFile}: ${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`pair tickets: ${stateFile} is not valid JSON; delete it to start over`)
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== STATE_VERSION || !Array.isArray(parsed.devices)) {
    throw new Error(`pair tickets: ${stateFile} has an unsupported format; delete it to start over`)
  }
  const devices = []
  for (const record of parsed.devices) {
    if (
      record === null ||
      typeof record !== 'object' ||
      typeof record.id !== 'string' || record.id.length === 0 ||
      typeof record.name !== 'string' ||
      typeof record.hash !== 'string' || !TOKEN_PATTERN.test(record.hash) ||
      typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) ||
      typeof record.lastSeenAt !== 'number' || !Number.isSafeInteger(record.lastSeenAt) ||
      typeof record.expiresAt !== 'number' || !Number.isSafeInteger(record.expiresAt) ||
      typeof record.revoked !== 'boolean'
    ) {
      throw new Error(`pair tickets: ${stateFile} contains an invalid device record; delete it to start over`)
    }
    devices.push({
      id: record.id,
      name: record.name.slice(0, MAX_NAME_LENGTH),
      hash: record.hash,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
      expiresAt: record.expiresAt,
      revoked: record.revoked,
    })
  }
  return devices
}

/**
 * Creates the synchronous ticket/device store.
 * @param {object} options
 * @param {string} options.stateFile - JSON file holding hashed device records.
 * @param {string|Buffer} options.secret - per-home HMAC key (never persisted here).
 * @param {() => number} [options.now] - clock returning epoch milliseconds.
 * @param {number} [options.ttlMs] - ticket lifetime in milliseconds.
 * @param {number} [options.deviceTtlMs] - device-token lifetime in milliseconds.
 */
export default function createTicketStore(options = {}) {
  const { stateFile } = options
  if (typeof stateFile !== 'string' || stateFile.length === 0) {
    throw new Error('pair tickets: stateFile is required')
  }
  const secret = typeof options.secret === 'string' ? Buffer.from(options.secret, 'utf8') : options.secret
  if (!Buffer.isBuffer(secret) || secret.length < 16) {
    throw new Error('pair tickets: secret must be a string or Buffer of at least 16 bytes')
  }
  const now = typeof options.now === 'function' ? options.now : Date.now
  const ttlMs = positiveInteger(options.ttlMs, DEFAULT_TICKET_TTL_MS, 'ttlMs')
  const deviceTtlMs = positiveInteger(options.deviceTtlMs, DEFAULT_DEVICE_TTL_MS, 'deviceTtlMs')

  const devices = readState(stateFile)
  /** @type {{hash: string, expiresAt: number, used: boolean, name: string}|null} */
  let liveTicket = null

  function deviceView(device) {
    return {
      id: device.id,
      name: device.name,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
    }
  }

  return {
    /** Mints a new single-use ticket, replacing any previous live ticket. */
    issue({ name = 'phone' } = {}) {
      const ticket = newToken()
      const expiresAt = now() + ttlMs
      liveTicket = {
        hash: hashToken(secret, ticket).toString('base64url'),
        expiresAt,
        used: false,
        name: normalizeName(name, 'phone'),
      }
      return { ticket, expiresAt }
    },

    /** Burns a live ticket and returns the one-time device token. */
    claim(ticket, { name } = {}) {
      if (liveTicket === null) invalid('ticket-invalid', 'pair ticket is not valid')
      const presented = typeof ticket === 'string' && TOKEN_PATTERN.test(ticket)
        ? hashToken(secret, ticket).toString('base64url')
        : ''
      if (presented.length === 0 || !equalHashes(presented, liveTicket.hash)) {
        invalid('ticket-invalid', 'pair ticket is not valid')
      }
      if (liveTicket.used) invalid('ticket-used', 'pair ticket was already used')
      if (now() >= liveTicket.expiresAt) invalid('ticket-expired', 'pair ticket expired')
      liveTicket.used = true

      const token = newToken()
      const createdAt = now()
      const device = {
        id: randomUUID(),
        name: normalizeName(name, liveTicket.name),
        hash: hashToken(secret, token).toString('base64url'),
        createdAt,
        lastSeenAt: createdAt,
        expiresAt: createdAt + deviceTtlMs,
        revoked: false,
      }
      devices.push(device)
      return { deviceId: device.id, token, expiresAt: device.expiresAt }
    },

    /** Resolves a live device token to its device id, or null. */
    verify(token) {
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null
      const presented = hashToken(secret, token).toString('base64url')
      const current = now()
      for (const device of devices) {
        if (device.revoked || current >= device.expiresAt) continue
        if (!equalHashes(presented, device.hash)) continue
        device.lastSeenAt = current
        return { deviceId: device.id }
      }
      return null
    },

    /** Revokes a device permanently; returns whether it existed. */
    revoke(deviceId) {
      const device = devices.find(candidate => candidate.id === deviceId)
      if (device === undefined) return false
      device.revoked = true
      return true
    },

    /** Public fields of paired, unrevoked, unexpired devices. */
    listDevices() {
      const current = now()
      return devices
        .filter(device => !device.revoked && current < device.expiresAt)
        .map(deviceView)
    },

    /** Atomically replaces the state file; it never contains raw tokens. */
    persist() {
      const payload = {
        version: STATE_VERSION,
        devices: devices.map(device => ({
          id: device.id,
          name: device.name,
          hash: device.hash,
          createdAt: device.createdAt,
          lastSeenAt: device.lastSeenAt,
          expiresAt: device.expiresAt,
          revoked: device.revoked,
        })),
      }
      const text = `${JSON.stringify(payload, null, 2)}\n`
      const directory = dirname(stateFile)
      mkdirSync(directory, { recursive: true })
      const temporary = join(
        directory,
        `.${String(process.pid)}-${randomBytes(6).toString('hex')}.tmp`,
      )
      try {
        writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
        renameSync(temporary, stateFile)
      } catch (error) {
        rmSync(temporary, { force: true })
        throw new Error(`pair tickets: cannot persist ${stateFile}: ${error.message}`)
      }
    },
  }
}
