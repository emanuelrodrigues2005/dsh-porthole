/**
 * VAPID (RFC 8292) keys and the ES256 JWT that authenticates a Web Push POST.
 *
 * The keypair is generated once per home, persisted atomically to
 * `$DSH_HOME/pair/vapid.json` (mode 0600) and reused forever, so a subscription
 * the phone registered months ago keeps working across harness restarts.
 *
 * Only the 65-byte uncompressed P-256 point is stored for the public key — the
 * shape `PushManager.subscribe({ applicationServerKey })` expects — plus the
 * private scalar `d`. Nothing here is exported to a browser except the public
 * point, which is public by definition.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const STATE_VERSION = 1
const HOUR_MS = 3_600_000
/** 12 hours: comfortably under the 24 h ceiling RFC 8292 asks for. */
const JWT_LIFETIME_MS = 12 * HOUR_MS
const MAX_JWT_LIFETIME_MS = 24 * HOUR_MS
const PUBLIC_KEY_BYTES = 65
const PRIVATE_KEY_BYTES = 32
const DEFAULT_SUBJECT = 'mailto:dsh-pair@localhost'

/** base64url encode bytes, without padding (the JWT/VAPID alphabet). */
export function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * base64url decode with a strict length/shape check.
 * @returns {Buffer|null} null when the text is not canonical base64url.
 */
export function fromBase64url(text) {
  if (typeof text !== 'string' || text.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(text)) return null
  const bytes = Buffer.from(text, 'base64url')
  return bytes.toString('base64url') === text ? bytes : null
}

/** The uncompressed P-256 point (`0x04 || X || Y`) of a public KeyObject. */
function pointOf(publicKey) {
  const der = publicKey.export({ format: 'der', type: 'spki' })
  const point = der.subarray(der.length - PUBLIC_KEY_BYTES)
  if (point.length !== PUBLIC_KEY_BYTES || point[0] !== 0x04) {
    throw new Error('pair vapid: the generated public key is not an uncompressed P-256 point')
  }
  return Buffer.from(point)
}

/** Rebuilds a private KeyObject from the stored point + scalar. */
function privateKeyObject(publicKey, privateKey) {
  const point = fromBase64url(publicKey)
  if (point === null || point.length !== PUBLIC_KEY_BYTES || point[0] !== 0x04) {
    throw new Error('pair vapid: the stored public key is not an uncompressed P-256 point')
  }
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: privateKey,
      x: base64url(point.subarray(1, 33)),
      y: base64url(point.subarray(33, 65)),
    },
    format: 'jwk',
  })
}

/**
 * The public KeyObject for a stored base64url point, used to verify a JWT.
 * @param {string} publicKey - base64url, 65 bytes.
 * @returns {import('node:crypto').KeyObject}
 */
export function publicKeyObject(publicKey) {
  const point = fromBase64url(publicKey)
  if (point === null || point.length !== PUBLIC_KEY_BYTES || point[0] !== 0x04) {
    throw new Error('pair vapid: not an uncompressed P-256 public key')
  }
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: base64url(point.subarray(1, 33)),
      y: base64url(point.subarray(33, 65)),
    },
    format: 'jwk',
  })
}

function generate() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' })
  return {
    version: STATE_VERSION,
    publicKey: base64url(pointOf(publicKey)),
    privateKey: String(jwk.d),
    createdAt: 0,
  }
}

function parseState(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== STATE_VERSION) return null
  const point = fromBase64url(parsed.publicKey)
  const scalar = fromBase64url(parsed.privateKey)
  if (point === null || point.length !== PUBLIC_KEY_BYTES || point[0] !== 0x04) return null
  if (scalar === null || scalar.length !== PRIVATE_KEY_BYTES) return null
  return {
    version: STATE_VERSION,
    publicKey: parsed.publicKey,
    privateKey: parsed.privateKey,
    createdAt: Number.isSafeInteger(parsed.createdAt) ? parsed.createdAt : 0,
  }
}

function writeState(stateFile, payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`
  const directory = dirname(stateFile)
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.${String(process.pid)}-${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, stateFile)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw new Error(`pair vapid: cannot persist ${stateFile}: ${error.message}`)
  }
}

/**
 * Builds the ES256 JWT plus the `Authorization` header a push POST carries.
 *
 * `exp` is capped at 24 hours from `now` even if a caller asks for more; the
 * audience is always the endpoint's origin, so a token minted for one push
 * service cannot be replayed against another.
 *
 * @param {object} options
 * @param {string} options.publicKey - base64url, 65-byte uncompressed point.
 * @param {string} options.privateKey - base64url, 32-byte scalar.
 * @param {string} options.endpoint - the subscription endpoint.
 * @param {() => number} [options.now]
 * @param {number} [options.lifetimeMs]
 * @param {string} [options.subject]
 */
export function createVapidAuth(options = {}) {
  const { publicKey, privateKey, endpoint } = options
  const now = typeof options.now === 'function' ? options.now : Date.now
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new Error('pair vapid: an endpoint is required to mint a token')
  }
  let audience
  try {
    audience = new URL(endpoint).origin
  } catch {
    throw new Error('pair vapid: the endpoint is not a valid URL')
  }
  if (!audience.startsWith('https://')) throw new Error('pair vapid: the endpoint must be https')
  const requested = Number.isSafeInteger(options.lifetimeMs) && options.lifetimeMs > 0 ? options.lifetimeMs : JWT_LIFETIME_MS
  const lifetime = Math.min(requested, MAX_JWT_LIFETIME_MS)
  const exp = Math.floor((now() + lifetime) / 1000)
  const header = { typ: 'JWT', alg: 'ES256' }
  const claims = { aud: audience, exp, sub: options.subject ?? DEFAULT_SUBJECT }
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: privateKeyObject(publicKey, privateKey),
    dsaEncoding: 'ieee-p1363',
  })
  const jwt = `${signingInput}.${base64url(signature)}`
  return {
    header,
    claims,
    jwt,
    signingInput,
    signature: base64url(signature),
    /** Exactly the header value a push POST sends. */
    authorization: `vapid t=${jwt}, k=${publicKey}`,
    ttl: '600',
  }
}

/** Verifies a JWT this module minted; used by tests and by support tooling. */
export function verifyVapidJwt(jwt, publicKey) {
  const parts = String(jwt).split('.')
  if (parts.length !== 3) return false
  const signature = fromBase64url(parts[2])
  if (signature === null) return false
  try {
    return verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
      { key: publicKeyObject(publicKey), dsaEncoding: 'ieee-p1363' },
      signature,
    )
  } catch {
    return false
  }
}

/**
 * Loads the per-home VAPID keypair, generating and persisting it on first use.
 * A corrupt or unreadable file is replaced by a fresh keypair and reported via
 * `regenerated`, because a stale half-file can never sign anything.
 * @param {object} options
 * @param {string} options.stateFile - `$DSH_HOME/pair/vapid.json`.
 * @param {() => number} [options.now]
 */
export function createVapid(options = {}) {
  const { stateFile } = options
  if (typeof stateFile !== 'string' || stateFile.length === 0) {
    throw new Error('pair vapid: stateFile is required')
  }
  const now = typeof options.now === 'function' ? options.now : Date.now

  let state = null
  let regenerated = false
  let loadError = null
  try {
    state = parseState(readFileSync(stateFile, 'utf8'))
    if (state === null) loadError = `${stateFile} has an unsupported format; a new keypair was generated`
  } catch (error) {
    if (error?.code !== 'ENOENT') loadError = `cannot read ${stateFile}: ${error.message}`
  }
  if (state === null) {
    regenerated = true
    state = generate()
    state.createdAt = now()
    writeState(stateFile, state)
  }

  return {
    stateFile,
    publicKey: state.publicKey,
    privateKey: state.privateKey,
    createdAt: state.createdAt,
    /** True when this process had to mint (or re-mint) the keypair. */
    regenerated,
    loadError,
    /** The header value for a push POST to `endpoint`. */
    authorization(endpoint) {
      return createVapidAuth({ publicKey: state.publicKey, privateKey: state.privateKey, endpoint, now })
    },
  }
}

export default createVapid
