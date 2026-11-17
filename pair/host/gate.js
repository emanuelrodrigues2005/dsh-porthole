/**
 * The Pair gate: a loopback-only HTTP + WebSocket reverse proxy in front of the
 * untouched DSH listener.
 *
 * Fail-closed rules:
 * - only `GET /pair/health`, `GET /pair/<ticket>` and `GET`/`HEAD` of the
 *   install assets listed in {@link PUBLIC_ASSET_PATHS} are public;
 * - every other path needs a valid `dsh_pair` cookie before the upstream is
 *   contacted at all;
 * - if no launch token is available the gate answers 503 and never proxies;
 * - a claim makes the gate perform the launch-token exchange upstream itself,
 *   so the browser only ever receives a relative redirect and Secure cookies;
 * - there is no loopback-operator exemption and no control endpoint here.
 *
 * The gate rewrites `Host`, `Origin` and `Referer` to the loopback upstream so
 * DSH's Host/Origin fence admits the request, and it drops hop-by-hop headers
 * in both directions.
 */
import { createServer, request as httpRequest } from 'node:http'
import { Transform } from 'node:stream'

import { validatePushEndpoint } from './push.js'
import { SERVICE_WORKER_SOURCE } from './sw.js'

const COOKIE_NAME = 'dsh_pair'
const HEALTH_PATH = '/pair/health'
const PAIR_PREFIX = '/pair/'
const API_PREFIX = '/pair/api'
const SELF_PREFIX = '/pair/self/'
/** Gate-owned install surface: the service worker that receives pushes. */
const SERVICE_WORKER_PATH = '/dsh-pair-sw.js'
/**
 * The phone-facing push API. Every route is owned by the gate — it is never
 * proxied upstream — and the device identity always comes from the `dsh_pair`
 * cookie, never from the request body.
 */
const SELF_PUSH_ROUTES = new Map([
  ['/pair/self/push/config', { method: 'GET', action: 'config' }],
  ['/pair/self/push/settings', { method: 'POST', action: 'settings' }],
  ['/pair/self/push/subscribe', { method: 'POST', action: 'subscribe' }],
  ['/pair/self/push/unsubscribe', { method: 'POST', action: 'unsubscribe' }],
  ['/pair/self/push/drain', { method: 'POST', action: 'drain' }],
  ['/pair/self/push/test', { method: 'POST', action: 'test' }],
])
/** A subscription is a single small object; nothing here needs a large body. */
const MAX_SELF_BODY_BYTES = 4 * 1024
/**
 * Installability bytes the shipped web UI links from its HTML head. A browser
 * may fetch them without credentials (and without the device cookie), so they
 * must bypass the pairing rule without weakening it anywhere else. Exact names
 * only: a suffix or prefix match would turn unknown paths into a public surface.
 */
const PUBLIC_ASSET_PATHS = new Set([
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
  '/favicon.svg',
  '/favicon-dark.svg',
])
const MAX_HEADER_BYTES = 64 * 1024
const MAX_BODY_BYTES = 32 * 1024 * 1024
const CLAIM_LIMIT = 5
const CLAIM_WINDOW_MS = 60_000
const EXCHANGE_TIMEOUT_MS = 15_000
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const STATUS_REASONS = new Map([
  [400, 'Bad Request'],
  [401, 'Unauthorized'],
  [404, 'Not Found'],
  [502, 'Bad Gateway'],
  [503, 'Service Unavailable'],
])
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function headerTokens(value) {
  if (typeof value !== 'string') return new Set()
  return new Set(
    value
      .toLowerCase()
      .split(',')
      .map(token => token.trim())
      .filter(token => token.length > 0),
  )
}

/**
 * Tunnels terminate TLS at Cloudflare, so every cookie the phone receives must
 * carry `Secure`. Only the attribute is added; the upstream string is kept
 * byte-for-byte otherwise.
 * @param {string} cookie - a `Set-Cookie` value from the upstream.
 * @returns {string}
 */
function withSecure(cookie) {
  const text = String(cookie)
  return /;\s*Secure(?:;|$)/i.test(text) ? text : `${text}; Secure`
}

function jsonHeaders(body) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, { ...jsonHeaders(body), ...extraHeaders })
    res.end(body)
  } catch {
    res.destroy()
  }
}

/**
 * Human-facing gate failure. A phone that opens a stale or truncated pairing
 * link gets an explanation instead of a JSON body; every other caller keeps the
 * machine-readable response.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} title
 * @param {string} message
 */
function sendPairNotice(req, res, status, title, message) {
  if (res.writableEnded) return
  const accept = String(req?.headers?.accept ?? '')
  if (!accept.includes('text/html')) {
    sendJson(res, status, { error: title.toLowerCase() })
    return
  }
  const escape = value => String(value).replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`)
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8eaed;font:16px/1.6 system-ui,sans-serif}main{max-width:34rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0;color:#b6bcc7}</style></head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`
  try {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    res.end(body)
  } catch {
    res.destroy()
  }
}

function readCookie(headerValue) {
  if (typeof headerValue !== 'string' || headerValue.length === 0) return null
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() !== COOKIE_NAME) continue
    let value = segment.slice(at + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    return value.length > 0 ? value : null
  }
  return null
}

function closeSocket(socket, status = 401) {
  if (socket.destroyed) return
  try {
    if (socket.writable) {
      const reason = STATUS_REASONS.get(status) ?? 'Error'
      socket.write(
        `HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      )
    }
  } catch {
    /* the peer may already be gone */
  }
  socket.end()
  socket.destroy()
}

/**
 * Creates the gate (does not listen until {@link Gate.listen}).
 * @param {object} options
 * @param {number} options.upstreamPort - loopback DSH listener port.
 * @param {{claim: Function, verify: Function}} options.store - ticket/device store.
 * @param {() => number} [options.now] - clock for the claim-rate window and Max-Age.
 * @param {string} [options.launchToken] - DSH process launch token for the exchange.
 * @param {number} [options.port] - gate port; 0 asks the OS.
 * @param {(claim: object) => unknown} [options.onPaired] - persistence hook after a claim.
 */
export function createGate(options = {}) {
  const { upstreamPort, store } = options
  if (!Number.isInteger(upstreamPort) || upstreamPort <= 0 || upstreamPort > 65535) {
    throw new Error('pair gate: upstreamPort must be an integer port')
  }
  if (store === null || typeof store !== 'object' || typeof store.claim !== 'function' || typeof store.verify !== 'function') {
    throw new Error('pair gate: store must expose claim() and verify()')
  }
  const launchToken = typeof options.launchToken === 'string' && options.launchToken.length > 0
    ? options.launchToken
    : null
  const available = launchToken !== null
  const onPaired = typeof options.onPaired === 'function' ? options.onPaired : null
  const now = typeof options.now === 'function' ? options.now : Date.now
  const claimWindows = new Map()
  /**
   * The push facade, assembled by the service: `{store, vapid, send, test}`.
   * Absent when the row could not load its notification state, in which case
   * `/pair/self/push/*` answers 503 instead of pretending to work.
   */
  const push = options.push !== null && typeof options.push === 'object' ? options.push : null
  const pushStore = push !== null && push.store !== null && typeof push.store === 'object' ? push.store : null
  const pushVapid = push !== null && push.vapid !== null && typeof push.vapid === 'object' ? push.vapid : null
  const pushTest = push !== null && typeof push.test === 'function' ? push.test : null
  const pushAvailable =
    pushStore !== null &&
    pushVapid !== null &&
    typeof pushStore.view === 'function' &&
    typeof pushStore.enqueue === 'function' &&
    typeof pushStore.drain === 'function' &&
    typeof pushVapid.publicKey === 'string'
  /** The configured stable origin, when there is one (Tailscale Funnel mode). */
  const publicOrigin = typeof options.publicOrigin === 'string' && options.publicOrigin.length > 0
    ? options.publicOrigin.replace(/\/+$/u, '')
    : null
  const listenPort = options.port === undefined ? 0 : options.port
  if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
    throw new Error('pair gate: port must be an integer between 0 and 65535')
  }

  const upstreamAuthority = `127.0.0.1:${String(upstreamPort)}`
  const upstreamOrigin = `http://${upstreamAuthority}`
  const sockets = new Set()
  const upstreamUpgrades = new Set()
  /** @type {Map<import('node:net').Socket, {deviceId: string, client: import('node:net').Socket}>} */
  const upgradeOwners = new Map()
  let server = null
  let listeningPort = null
  /**
   * The harness session cookie from the launch-token exchange (`name=value`).
   * The phone never needs to carry it: the gate replays it upstream, so a
   * `SameSite=Strict` cookie, a browser that drops it, or a harness restart
   * cannot leave an authenticated device looking at the harness 401 page.
   */
  let harnessCookie = null
  let harnessExchange = null
  let closing = null

  function track(socket) {
    sockets.add(socket)
    socket.once?.('close', () => {
      sockets.delete(socket)
      upstreamUpgrades.delete(socket)
      upgradeOwners.delete(socket)
    })
  }

  function verifyCookie(headers) {
    const token = readCookie(headers.cookie)
    if (token === null || !TOKEN_PATTERN.test(token)) return null
    try {
      const device = store.verify(token)
      return device !== null && typeof device === 'object' ? device : null
    } catch {
      return null
    }
  }

  /**
   * Fixed-window claim limiter: five attempts per address per minute.
   * @param {string|undefined} address - socket remote address.
   * @returns {number} 0 when the attempt is allowed, else Retry-After seconds.
   */
  function claimRetryAfter(address) {
    const key = typeof address === 'string' && address.length > 0 ? address : 'unknown'
    const current = now()
    let window = claimWindows.get(key)
    if (window === undefined || current - window.start >= CLAIM_WINDOW_MS || current < window.start) {
      window = { start: current, count: 0 }
      claimWindows.set(key, window)
    }
    if (window.count >= CLAIM_LIMIT) {
      return Math.max(1, Math.ceil((window.start + CLAIM_WINDOW_MS - current) / 1000))
    }
    window.count += 1
    if (claimWindows.size > 1024) {
      for (const [candidate, entry] of claimWindows) {
        if (current - entry.start >= CLAIM_WINDOW_MS || current < entry.start) claimWindows.delete(candidate)
      }
    }
    return 0
  }

  /**
   * Performs the DSH launch-token exchange itself, against the loopback
   * listener, so the launch token never reaches the browser.
   *
   * The upstream redirect is deliberately not followed: only the status class
   * and the `Set-Cookie` headers matter. A stall is bounded by a timer, and any
   * network error, 4xx or 5xx rejects.
   *
   * @param {string} token - the DSH process launch token.
   * @returns {Promise<{setCookies: string[]}>}
   */
  function exchangeLaunchToken(token) {
    return new Promise((resolve, reject) => {
      let settled = false
      let timer = null
      let exchangeReq = null
      const settle = (callback, value) => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        callback(value)
      }
      try {
        exchangeReq = httpRequest(
          {
            host: '127.0.0.1',
            port: upstreamPort,
            method: 'GET',
            path: `/?token=${encodeURIComponent(token)}`,
            headers: { host: upstreamAuthority },
            agent: false,
          },
          proxyRes => {
            const status = proxyRes.statusCode ?? 0
            const setCookie = proxyRes.headers['set-cookie']
            const setCookies = Array.isArray(setCookie)
              ? setCookie
              : setCookie === undefined
                ? []
                : [setCookie]
            // The body is irrelevant; drain it so the loopback socket closes.
            proxyRes.on('error', () => {})
            proxyRes.resume()
            if (status >= 200 && status < 400) settle(resolve, { setCookies })
            else settle(reject, new Error(`the launch-token exchange answered ${String(status)}`))
          },
        )
      } catch (error) {
        settle(reject, error)
        return
      }
      exchangeReq.on('error', error => settle(reject, error))
      timer = setTimeout(() => {
        try {
          exchangeReq.destroy()
        } catch {
          /* already gone */
        }
        settle(reject, new Error('the launch-token exchange timed out'))
      }, EXCHANGE_TIMEOUT_MS)
      timer?.unref?.()
      exchangeReq.end()
    })
  }

  /**
   * Picks the harness session cookie out of an exchange response.
   * Accepts both the real `dsh-auth-<hash>` name and the shorter test spelling.
   */
  function harnessCookieFrom(setCookies) {
    for (const raw of setCookies) {
      const pair = String(raw).split(';', 1)[0].trim()
      const at = pair.indexOf('=')
      if (at <= 0) continue
      const name = pair.slice(0, at)
      if (/^dsh[-_]auth/i.test(name)) return pair
    }
    return null
  }

  /** Replays the harness session cookie, exchanging the launch token once if needed. */
  function ensureHarnessCookie() {
    if (harnessCookie !== null) return Promise.resolve(harnessCookie)
    if (launchToken === null) return Promise.resolve(null)
    if (harnessExchange !== null) return harnessExchange
    harnessExchange = exchangeLaunchToken(launchToken)
      .then(exchanged => {
        const cookie = harnessCookieFrom(exchanged.setCookies)
        if (cookie !== null) harnessCookie = cookie
        return harnessCookie
      })
      .catch(() => null)
      .finally(() => {
        harnessExchange = null
      })
    return harnessExchange
  }

  /**
   * Builds the upstream header set.
   * @param {object} headers - the browser request headers.
   * @param {{stripCookie?: boolean}} [options] - `stripCookie` drops the
   *   browser cookie and the replayed session cookie (public assets).
   */
  function forwardHeaders(headers, options = {}) {
    const stripCookie = options.stripCookie === true
    const dropped = headerTokens(headers.connection)
    const forwarded = {}
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase()
      if (lower === 'host' || HOP_BY_HOP.has(lower) || dropped.has(lower)) continue
      if (stripCookie && lower === 'cookie') continue
      if (value === undefined) continue
      forwarded[lower] = value
    }
    forwarded.host = upstreamAuthority
    // The phone's cookies are for the gate, not for the harness. Replay the
    // session from the exchange so the harness always sees an owner session.
    // A public asset is served anonymously: no cookie goes upstream at all.
    if (!stripCookie && harnessCookie !== null) forwarded.cookie = harnessCookie
    // The marker is set here and only here: a phone-supplied value (even `0`)
    // must never survive, and the operator routes refuse any presence of it.
    forwarded['x-dsh-pair-proxied'] = '1'
    if (headers.origin !== undefined) forwarded.origin = upstreamOrigin
    if (headers.referer !== undefined) forwarded.referer = upstreamOrigin
    return forwarded
  }

  function responseHeaders(headers) {
    const dropped = headerTokens(headers.connection)
    const forwarded = {}
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase()
      if (HOP_BY_HOP.has(lower) || dropped.has(lower) || value === undefined) continue
      // The client hop is the HTTPS tunnel, so every upstream cookie must be
      // marked Secure before it reaches the browser.
      if (lower === 'set-cookie') {
        forwarded[lower] = Array.isArray(value) ? value.map(withSecure) : withSecure(String(value))
        continue
      }
      forwarded[lower] = value
    }
    return forwarded
  }

  /**
   * Streams one request to the untouched upstream listener.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {{publicAsset?: boolean}} [options] - `publicAsset` serves an install
   *   asset: no launch-token exchange, no cookie upstream.
   */
  async function proxyHttp(req, res, options = {}) {
    const publicAsset = options.publicAsset === true
    // S7(c): refuse an oversized body from the declared length, before any
    // upstream connection is opened. The streaming limiter below stays as the
    // backstop for chunked bodies that declare nothing.
    const declaredLength = req.headers['content-length']
    if (declaredLength !== undefined) {
      const declared = Number(declaredLength)
      if (!Number.isSafeInteger(declared) || declared < 0) {
        sendJson(res, 400, { error: 'invalid content-length' })
        req.resume()
        res.once('finish', () => req.destroy())
        return
      }
      if (declared > MAX_BODY_BYTES) {
        sendJson(res, 413, { error: 'request body too large' })
        req.resume()
        res.once('finish', () => req.destroy())
        return
      }
    }

    let proxyReq
    try {
      if (!publicAsset) await ensureHarnessCookie()
      proxyReq = httpRequest(
        {
          host: '127.0.0.1',
          port: upstreamPort,
          method: req.method,
          path: req.url,
          headers: forwardHeaders(req.headers, { stripCookie: publicAsset }),
          agent: false,
        },
        proxyRes => {
          proxyRes.on('error', () => {
            if (!res.headersSent) sendJson(res, 502, { error: 'upstream response failed' })
            else res.destroy()
          })
          if (res.writableEnded) {
            proxyRes.destroy()
            return
          }
          try {
            res.writeHead(proxyRes.statusCode ?? 502, responseHeaders(proxyRes.headers))
          } catch {
            proxyRes.destroy()
            res.destroy()
            return
          }
          proxyRes.pipe(res)
        },
      )
    } catch {
      sendJson(res, 502, { error: 'upstream unavailable' })
      return
    }

    proxyReq.on('error', () => {
      if (!res.headersSent) sendJson(res, 502, { error: 'upstream unavailable' })
      else res.destroy()
    })
    res.on('close', () => {
      if (!res.writableEnded) proxyReq.destroy()
    })
    req.on('aborted', () => proxyReq.destroy())

    const method = String(req.method ?? 'GET').toUpperCase()
    if (method === 'GET' || method === 'HEAD' || req.readableEnded) {
      proxyReq.end()
      return
    }

    let received = 0
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length
        if (received > MAX_BODY_BYTES) {
          const error = new Error('request body too large')
          error.code = 'BODY_TOO_LARGE'
          callback(error)
          return
        }
        callback(null, chunk)
      },
    })
    limiter.on('error', error => {
      proxyReq.destroy()
      req.unpipe(limiter)
      // Drain and discard the rest so the 413/400 response can be written.
      req.resume()
      if (!res.headersSent) {
        if (error?.code === 'BODY_TOO_LARGE') sendJson(res, 413, { error: 'request body too large' })
        else sendJson(res, 400, { error: 'bad request body' })
      }
      res.once('finish', () => req.destroy())
    })
    req.pipe(limiter).pipe(proxyReq)
  }

  async function claimTicket(req, res, ticket) {
    if (!available) {
      sendJson(res, 503, { error: 'pairing is unavailable: the launch token is missing' })
      return
    }
    let claim
    try {
      claim = store.claim(ticket, {})
    } catch {
      sendJson(res, 401, { error: 'pairing ticket is not valid' })
      return
    }
    if (claim === null || typeof claim !== 'object' || typeof claim.token !== 'string') {
      sendJson(res, 401, { error: 'pairing ticket is not valid' })
      return
    }
    if (onPaired !== null) {
      try {
        await onPaired(claim)
      } catch {
        // Never hand out a credential the plugin could not persist: fail closed.
        sendJson(res, 500, { error: 'pairing could not be saved; create a new ticket and try again' })
        return
      }
    }
    let exchanged
    try {
      exchanged = await exchangeLaunchToken(launchToken)
    } catch {
      // Fail closed: the upstream refused or was unreachable, so the browser
      // gets no device credential and no launch-token material.
      if (!res.writableEnded) sendJson(res, 502, { error: 'the launch-token exchange failed' })
      return
    }
    if (res.writableEnded) return
    const exchangedCookie = harnessCookieFrom(exchanged.setCookies)
    if (exchangedCookie !== null) harnessCookie = exchangedCookie

    // S6: advertise exactly the lifetime the store just claimed (±1 s).
    const expiresAt = Number.isFinite(claim.expiresAt) ? claim.expiresAt : now()
    const maxAge = Math.max(1, Math.floor((expiresAt - now()) / 1000))
    const deviceCookie = `${COOKIE_NAME}=${claim.token}; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=${String(maxAge)}`
    try {
      res.writeHead(303, {
        // Absolute path: a relative "./" would resolve to /pair/ from
        // /pair/<ticket> and land on a 404 instead of the GUI root.
        location: '/',
        'set-cookie': [...exchanged.setCookies.map(withSecure), deviceCookie],
        'cache-control': 'no-store',
        'content-length': '0',
      })
      res.end()
    } catch {
      res.destroy()
    }
  }

  /**
   * Cross-origin guard for the phone API. A browser always sends `Origin` on a
   * `POST`; it must match the configured public origin, or — in quick-tunnel
   * mode, where the URL only exists while the tunnel is up — the host the
   * request itself arrived on. A missing `Origin` is allowed (curl, native
   * fetch), anything else is refused.
   */
  function originAccepted(headers) {
    const origin = headers?.origin
    if (origin === undefined) return true
    if (typeof origin !== 'string' || origin.length === 0) return false
    if (publicOrigin !== null && origin === publicOrigin) return true
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      return false
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
    const host = typeof headers?.host === 'string' ? headers.host : ''
    return host.length > 0 && parsed.host === host
  }

  /**
   * Reads a `/pair/self/*` JSON body under the 4 KiB cap.
   * @returns {Promise<{status: number, value?: unknown}>} `status` is 200 on
   *   success, otherwise the status to answer with.
   */
  async function readSelfBody(req) {
    const declared = req.headers['content-length']
    if (declared !== undefined) {
      const length = Number(declared)
      if (!Number.isSafeInteger(length) || length < 0) return { status: 400 }
      if (length > MAX_SELF_BODY_BYTES) return { status: 413 }
    }
    const chunks = []
    let received = 0
    try {
      for await (const chunk of req) {
        received += chunk.length
        // Over the cap: stop reading and answer, so a slow upload cannot pin a
        // socket. The client sees the 413 immediately.
        if (received > MAX_SELF_BODY_BYTES) return { status: 413 }
        chunks.push(chunk)
      }
    } catch {
      return { status: 400 }
    }
    if (chunks.length === 0) return { status: 200, value: null }
    try {
      return { status: 200, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    } catch {
      return { status: 400 }
    }
  }

  /** Serves the service worker: public, gate-owned, never proxied. */
  function sendServiceWorker(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' })
      return
    }
    if (res.writableEnded) return
    try {
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': String(Buffer.byteLength(SERVICE_WORKER_SOURCE)),
        'cache-control': 'no-cache',
        'service-worker-allowed': '/',
      })
      res.end(req.method === 'HEAD' ? undefined : SERVICE_WORKER_SOURCE)
    } catch {
      res.destroy()
    }
  }

  function sendInvalidBody(res, status) {
    sendJson(res, status, { error: status === 413 ? 'request body too large' : 'bad request body' })
  }

  /** Rejects unknown keys so a typo in the phone never silently does nothing. */
  function onlyKeys(payload, allowed) {
    for (const key of Object.keys(payload)) {
      if (!allowed.has(key)) return key
    }
    return null
  }

  function configPayload(deviceId) {
    const view = pushStore.view(deviceId)
    return {
      deviceId,
      vapidPublicKey: pushVapid.publicKey,
      enabled: view.enabled,
      categories: view.categories,
      subscription: view.subscription === null ? null : { host: view.subscription.host, createdAt: view.subscription.createdAt },
    }
  }

  async function persistPush() {
    try {
      if (typeof pushStore.persist === 'function') await pushStore.persist()
    } catch {
      /* the in-memory state is authoritative for this process */
    }
  }

  /**
   * The `/pair/self/push/*` API.
   *
   * Guard order, fixed by contract: unknown route → 404; wrong method → 405 with
   * `Allow`; a foreign `Origin` → 403; an invalid/revoked cookie → 401; an
   * unavailable push facade → 503; then the body cap (413/400) and the call.
   * The device id always comes from the cookie.
   */
  async function handleSelfPush(req, res, pathname) {
    const spec = SELF_PUSH_ROUTES.get(pathname)
    if (spec === undefined) {
      sendJson(res, 404, { error: 'not found' })
      req.resume()
      return
    }
    if (req.method !== spec.method) {
      sendJson(res, 405, { error: 'method not allowed' }, { allow: spec.method })
      req.resume()
      return
    }
    if (!originAccepted(req.headers)) {
      sendJson(res, 403, { error: 'forbidden' })
      req.resume()
      return
    }
    const device = verifyCookie(req.headers)
    const deviceId = device !== null && typeof device.deviceId === 'string' ? device.deviceId : ''
    if (deviceId.length === 0) {
      sendJson(res, 401, { error: 'pairing required' })
      req.resume()
      return
    }
    if (!pushAvailable) {
      sendJson(res, 503, { error: 'push notifications are unavailable' })
      req.resume()
      return
    }

    if (spec.action === 'config') {
      sendJson(res, 200, configPayload(deviceId))
      return
    }

    const body = await readSelfBody(req)
    if (body.status !== 200) {
      // Drain whatever the client is still sending so the 413/400 can be written.
      req.resume()
      sendInvalidBody(res, body.status)
      return
    }
    const payload = body.value

    if (spec.action === 'settings') {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        sendJson(res, 400, { error: 'settings must be a JSON object' })
        return
      }
      const unknown = onlyKeys(payload, new Set(['enabled', 'categories']))
      if (unknown !== null) {
        sendJson(res, 400, { error: `unknown settings key ${JSON.stringify(unknown)}` })
        return
      }
      let view
      try {
        view = pushStore.updateSettings(deviceId, { enabled: payload.enabled, categories: payload.categories })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'invalid settings' })
        return
      }
      await persistPush()
      sendJson(res, 200, { ok: true, enabled: view.enabled, categories: view.categories })
      return
    }

    if (spec.action === 'subscribe') {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        sendJson(res, 400, { error: 'subscription must be a JSON object' })
        return
      }
      const unknown = onlyKeys(payload, new Set(['endpoint', 'keys']))
      if (unknown !== null) {
        sendJson(res, 400, { error: `unknown subscription key ${JSON.stringify(unknown)}` })
        return
      }
      // The SSRF guard: https only, no credentials, no IP literal, no
      // single-label host, port 443 only.
      const validation = validatePushEndpoint(payload.endpoint)
      if (!validation.ok) {
        sendJson(res, 400, { error: `invalid push endpoint: ${validation.reason}` })
        return
      }
      let view
      try {
        view = pushStore.setSubscription(deviceId, {
          endpoint: payload.endpoint,
          userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : '',
        })
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : 'invalid subscription' })
        return
      }
      await persistPush()
      sendJson(res, 200, {
        ok: true,
        subscription: view.subscription === null ? null : { host: view.subscription.host, createdAt: view.subscription.createdAt },
      })
      return
    }

    if (spec.action === 'unsubscribe') {
      try {
        pushStore.clearSubscription(deviceId)
      } catch {
        /* idempotent by contract */
      }
      await persistPush()
      sendJson(res, 200, { ok: true })
      return
    }

    if (spec.action === 'drain') {
      const items = pushStore.drain(deviceId)
      sendJson(res, 200, { items, count: items.length }, { 'cache-control': 'no-store' })
      return
    }

    // test
    const result = pushTest !== null
      ? pushTest(deviceId)
      : { ok: false, reason: 'unavailable' }
    if (result !== null && result.ok === true) {
      sendJson(res, 200, { ok: true })
      return
    }
    const reason = result !== null && typeof result.reason === 'string' ? result.reason : 'unavailable'
    if (reason === 'cooldown') {
      const retryAfter = result !== null && Number.isFinite(result.retryAfter) ? result.retryAfter : 60
      sendJson(res, 429, { error: 'a test notification was already sent' }, { 'retry-after': String(retryAfter) })
      return
    }
    if (reason === 'no-subscription') {
      sendJson(res, 409, { error: 'this device has no push subscription' })
      return
    }
    sendJson(res, 409, { error: 'notifications are switched off on this device' })
  }

  async function handleRequest(req, res) {
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://gate.invalid').pathname
    } catch {
      sendJson(res, 400, { error: 'bad request' })
      return
    }

    if (pathname === HEALTH_PATH) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
        return
      }
      sendJson(res, 200, { ok: true })
      return
    }

    if (pathname === SERVICE_WORKER_PATH) {
      // Public and gate-owned: a service worker registration carries no cookie
      // on the first fetch, and the script itself has to be readable from the
      // scope root. It is never proxied upstream.
      sendServiceWorker(req, res)
      return
    }

    if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) {
      sendJson(res, 404, { error: 'not found' })
      return
    }

    if (pathname.startsWith(SELF_PREFIX)) {
      // The phone API is gate-owned too: an unknown `/pair/self/` path is a 404,
      // never a proxied request and never a ticket claim.
      await handleSelfPush(req, res, pathname)
      return
    }

    if (pathname.startsWith(PAIR_PREFIX)) {
      const rest = pathname.slice(PAIR_PREFIX.length)
      if (rest.length > 0 && !rest.includes('/')) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
          return
        }
        const retryAfter = claimRetryAfter(req.socket?.remoteAddress)
        if (retryAfter > 0) {
          sendJson(res, 429, { error: 'too many pairing attempts' }, { 'retry-after': String(retryAfter) })
          return
        }
        await claimTicket(req, res, rest)
        return
      }
      sendPairNotice(
        req,
        res,
        404,
        'Pairing link incomplete',
        'This pairing link is incomplete or has already been used. Open the full link shown in the Pair panel on the host, or create a new ticket there. Tickets are single-use and expire after five minutes.',
      )
      return
    }

    // A1: the install assets are public for GET/HEAD only, with no cookie in
    // either direction. `/pair/<name>` never reaches this branch: the ticket
    // claim above is matched first.
    if (PUBLIC_ASSET_PATHS.has(pathname)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' })
        return
      }
      return proxyHttp(req, res, { publicAsset: true })
    }

    if (!available) {
      sendJson(res, 503, { error: 'pairing is unavailable: the launch token is missing' })
      return
    }
    if (verifyCookie(req.headers) === null) {
      // A4: a human who opens the tunnel front door deserves an explanation and
      // the fix, not a bare JSON error. Machine callers keep the JSON shape.
      if (pathname === '/' && req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')) {
        sendPairNotice(
          req,
          res,
          401,
          'Pairing required',
          'This browser is not paired with this harness. Open the pairing link from the Pair panel, or create a new ticket and scan the QR again.',
        )
        return
      }
      sendJson(res, 401, { error: 'pairing required' })
      return
    }
    return proxyHttp(req, res)
  }

  async function handleUpgrade(req, socket, head) {
    socket.on('error', () => {})
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://gate.invalid').pathname
    } catch {
      closeSocket(socket, 400)
      return
    }
    if (pathname.startsWith(PAIR_PREFIX)) {
      closeSocket(socket, pathname === HEALTH_PATH ? 400 : 404)
      return
    }
    if (!available) {
      closeSocket(socket, 503)
      return
    }
    const device = verifyCookie(req.headers)
    if (device === null) {
      closeSocket(socket, 401)
      return
    }
    const deviceId = typeof device.deviceId === 'string' && device.deviceId.length > 0
      ? device.deviceId
      : null

    await ensureHarnessCookie()
    const headers = forwardHeaders(req.headers)
    headers.connection = 'Upgrade'
    headers.upgrade = typeof req.headers.upgrade === 'string' ? req.headers.upgrade : 'websocket'

    let proxyReq
    try {
      proxyReq = httpRequest({
        host: '127.0.0.1',
        port: upstreamPort,
        method: req.method,
        path: req.url,
        headers,
        agent: false,
      })
    } catch {
      closeSocket(socket, 502)
      return
    }

    proxyReq.on('error', () => closeSocket(socket, 502))
    proxyReq.on('response', proxyRes => {
      proxyRes.resume()
      closeSocket(socket, 502)
    })
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      if (socket.destroyed) {
        proxySocket.destroy()
        return
      }
      upstreamUpgrades.add(proxySocket)
      track(proxySocket)
      if (deviceId !== null) upgradeOwners.set(proxySocket, { deviceId, client: socket })
      proxySocket.on('error', () => socket.destroy())
      socket.on('error', () => proxySocket.destroy())
      socket.on('close', () => proxySocket.destroy())
      proxySocket.on('close', () => socket.destroy())

      let response = `HTTP/1.1 ${String(proxyRes.statusCode ?? 101)} ${proxyRes.statusMessage ?? 'Switching Protocols'}\r\n`
      for (const [name, value] of Object.entries(proxyRes.headers)) {
        if (value === undefined) continue
        for (const item of Array.isArray(value) ? value : [value]) response += `${name}: ${item}\r\n`
      }
      response += '\r\n'
      try {
        socket.write(response)
        if (proxyHead.length > 0) socket.write(proxyHead)
      } catch {
        proxySocket.destroy()
        socket.destroy()
        return
      }
      if (head.length > 0) proxySocket.write(head)
      proxySocket.pipe(socket)
      socket.pipe(proxySocket)
    })
    proxyReq.end()
  }

  function ensureServer() {
    if (server !== null) return server
    server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (req, res) => {
      handleRequest(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: 'gate error' })
        else res.destroy()
      })
    })
    server.on('connection', track)
    server.on('upgrade', (req, socket, head) => {
      handleUpgrade(req, socket, head).catch(() => {
        try {
          socket.destroy()
        } catch {
          /* already gone */
        }
      })
    })
    server.on('error', () => {})
    server.headersTimeout = 30_000
    server.requestTimeout = 300_000
    server.keepAliveTimeout = 5_000
    return server
  }

  /** Starts listening on 127.0.0.1 (once) and resolves the actual port. */
  async function listen() {
    if (listeningPort !== null) return { port: listeningPort }
    const target = ensureServer()
    await new Promise((resolve, reject) => {
      const onError = error => {
        target.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        target.off('error', onError)
        listenPortActual(target)
        resolve()
      }
      target.once('error', onError)
      target.once('listening', onListening)
      target.listen(listenPort, '127.0.0.1')
    })
    return { port: listeningPort }
  }

  function listenPortActual(target) {
    const address = target.address()
    listeningPort = address !== null && typeof address === 'object' ? address.port : null
    if (listeningPort === null) throw new Error('pair gate: listener did not report a port')
  }

  /**
   * Destroys every live upgraded session authenticated by one device.
   *
   * Called by the service on revoke: the next HTTP request with that cookie is
   * already refused by `store.verify`, but an established WebSocket never
   * re-authenticates, so it must be torn down here.
   *
   * @param {string} deviceId
   * @returns {number} how many sessions were closed.
   */
  function revokeDeviceSessions(deviceId) {
    if (typeof deviceId !== 'string' || deviceId.length === 0) return 0
    let closed = 0
    for (const [upstreamSocket, session] of [...upgradeOwners]) {
      if (session.deviceId !== deviceId) continue
      upgradeOwners.delete(upstreamSocket)
      upstreamUpgrades.delete(upstreamSocket)
      closed += 1
      try {
        upstreamSocket.destroy()
      } catch {
        /* the upstream peer may already be gone */
      }
      try {
        session.client.destroy()
      } catch {
        /* the phone may already be gone */
      }
    }
    return closed
  }

  /** Idempotently stops listening and destroys every tracked socket. */
  function close() {
    if (closing !== null) return closing
    closing = (async () => {
      for (const socket of [...sockets]) {
        socket.destroy()
      }
      sockets.clear()
      for (const socket of [...upstreamUpgrades]) socket.destroy()
      upstreamUpgrades.clear()
      upgradeOwners.clear()
      const target = server
      server = null
      listeningPort = null
      if (target === null || !target.listening) return
      target.closeAllConnections?.()
      await new Promise(resolve => {
        target.close(() => resolve())
      })
    })()
    return closing
  }

  return {
    listen,
    close,
    revokeDeviceSessions,
    get port() {
      return listeningPort
    },
  }
}

export default createGate
