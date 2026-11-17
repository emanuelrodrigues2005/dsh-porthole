/**
 * Web Push transport: one zero-length POST per notification tickle.
 *
 * The payload is deliberately empty. RFC 8291 encryption is not implemented,
 * so the push service only relays "something happened"; the service worker then
 * fetches the actual text from the gate under the device cookie. That keeps the
 * content on the host and removes any dependency on a push library.
 *
 * Security rules enforced here:
 * - the endpoint must be `https:`, on port 443, without credentials, an IP
 *   literal or a single-label host — a subscription is attacker-controlled
 *   input and this is the only place Pair opens an outbound connection;
 * - redirects are never followed;
 * - a 2xx means delivered, 404/410 mean the subscription is gone and is
 *   dropped, every other answer keeps it for a later attempt.
 */
import { request as httpsRequest } from 'node:https'

/** RFC 8030 asks for a TTL in seconds; ten minutes outlives a phone waking up. */
export const PUSH_TTL_SECONDS = '600'
export const PUSH_TIMEOUT_MS = 10_000
const MAX_ENDPOINT_LENGTH = 2048
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/u

/**
 * Validates a Web Push subscription endpoint.
 * @param {string} endpoint
 * @returns {{ok: true, url: URL}|{ok: false, reason: string}}
 */
export function validatePushEndpoint(endpoint) {
  const reject = reason => ({ ok: false, reason })
  if (typeof endpoint !== 'string' || endpoint.length === 0) return reject('endpoint must be a non-empty string')
  if (endpoint.length > MAX_ENDPOINT_LENGTH) return reject('endpoint is too long')
  let url
  try {
    url = new URL(endpoint)
  } catch {
    return reject('endpoint is not a valid URL')
  }
  if (url.protocol !== 'https:') return reject('endpoint must use https')
  if (url.username !== '' || url.password !== '') return reject('endpoint must not carry credentials')
  const host = url.hostname
  if (host.length === 0) return reject('endpoint has no host')
  // `[::1]` keeps its brackets in URL.hostname; an IPv6 literal never has one.
  if (host.startsWith('[') || host.includes(':')) return reject('endpoint must not be an IP literal')
  if (IPV4_LITERAL.test(host)) return reject('endpoint must not be an IP literal')
  if (!host.includes('.')) return reject('endpoint must be a fully qualified host')
  if (host.endsWith('.')) return reject('endpoint host must not end with a dot')
  // `new URL` normalizes an explicit :443 to '', so anything left is another port.
  if (url.port !== '') return reject('endpoint must use port 443')
  if (url.pathname.length <= 1) return reject('endpoint must carry a path')
  return { ok: true, url }
}

/**
 * Creates the sender. `request` and `timers` are injectable so the transport is
 * testable offline; production always uses node:https and the real clock.
 * @param {object} [options]
 * @param {Function} [options.request] - `https.request` stand-in.
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers]
 * @param {() => number} [options.now]
 */
export function createPushSender(options = {}) {
  const request = typeof options.request === 'function' ? options.request : httpsRequest
  const timers = options.timers !== null && typeof options.timers === 'object'
    ? options.timers
    : { setTimeout, clearTimeout }
  const now = typeof options.now === 'function' ? options.now : Date.now

  /**
   * Sends one empty push.
   * @param {object} options
   * @param {string} options.endpoint
   * @param {{authorization: (endpoint: string) => {authorization: string, ttl: string}}} options.vapid
   * @param {string} [options.userAgent]
   * @returns {Promise<{ok: boolean, status: number, drop: boolean, error?: string}>}
   */
  function send({ endpoint, vapid } = {}) {
    const validation = validatePushEndpoint(endpoint)
    // An endpoint that can never be valid is equivalent to a gone subscription.
    if (!validation.ok) return Promise.resolve({ ok: false, status: 0, drop: true, error: validation.reason })
    let auth
    try {
      auth = vapid.authorization(endpoint)
    } catch (error) {
      return Promise.resolve({
        ok: false,
        status: 0,
        drop: false,
        error: error instanceof Error ? error.message : 'vapid signing failed',
      })
    }

    return new Promise(resolve => {
      let settled = false
      let timer = null
      const finish = result => {
        if (settled) return
        settled = true
        if (timer !== null) timers.clearTimeout(timer)
        resolve(result)
      }

      let outgoing
      try {
        outgoing = request(
          validation.url,
          {
            method: 'POST',
            headers: {
              authorization: auth.authorization,
              ttl: auth.ttl ?? PUSH_TTL_SECONDS,
              'content-length': '0',
              'user-agent': 'dsh-pair-push/1',
            },
            agent: false,
          },
          response => {
            const status = response.statusCode ?? 0
            // The body is irrelevant; drain it so the socket is released.
            response.on?.('error', () => {})
            response.resume?.()
            const ok = status >= 200 && status < 300
            finish({ ok, status, drop: status === 404 || status === 410 })
          },
        )
      } catch (error) {
        finish({ ok: false, status: 0, drop: false, error: error instanceof Error ? error.message : 'request failed' })
        return
      }

      outgoing.on('error', error => {
        finish({ ok: false, status: 0, drop: false, error: error instanceof Error ? error.message : 'request failed' })
      })
      timer = timers.setTimeout(() => {
        try {
          outgoing.destroy()
        } catch {
          /* the socket may already be gone */
        }
        finish({ ok: false, status: 0, drop: false, error: 'the push request timed out' })
      }, PUSH_TIMEOUT_MS)
      timer?.unref?.()
      // Zero-length payload: `end()` with no argument sends no body at all.
      outgoing.end()
    })
  }

  return {
    send,
    validate: validatePushEndpoint,
    /** Exposed so the operator panel can show when a device last failed. */
    now,
  }
}

export default createPushSender
