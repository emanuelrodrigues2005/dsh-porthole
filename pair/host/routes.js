/**
 * Operator control endpoints for Pair, registered on the harness listener
 * (never on the tunnel-facing gate).
 *
 * Every route runs the same guard before touching the service:
 *   0. a request carrying `x-dsh-pair-proxied` is refused with 403 at once —
 *      that marker is only ever set by the gate and a phone must never reach
 *      these routes through it;
 *   1. `ctx.connection.requestRejection(request)` — answer its status verbatim;
 *   2. the socket address must be loopback (missing address = fail closed);
 *   3. `ctx.connection.admit(request)` must yield the owner peer.
 * Only then does the method check and the service call run.
 */
import { Buffer } from 'node:buffer'

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const ROUTES = [
  { path: '/pair/api/status', method: 'GET' },
  { path: '/pair/api/start', method: 'POST' },
  { path: '/pair/api/stop', method: 'POST' },
  { path: '/pair/api/reissue', method: 'POST' },
  { path: '/pair/api/revoke', method: 'POST' },
]
/**
 * The push operator routes run through the same dispatch (and therefore the
 * same guard order) but are registered separately, so `registerPairRoutes`
 * keeps owning exactly the five lifecycle routes it always owned.
 */
const PUSH_ROUTES = [
  { path: '/pair/api/devices/notifications', method: 'POST' },
  { path: '/pair/api/push/test', method: 'POST' },
]
/**
 * The Tailscale setup routes. Same dispatch and therefore the same guard order;
 * they are registered separately so each register function keeps owning exactly
 * the routes it always owned.
 */
const SETUP_ROUTES = [
  { path: '/pair/api/setup', method: 'GET' },
  { path: '/pair/api/setup/apply', method: 'POST' },
  { path: '/pair/api/setup/funnel', method: 'POST' },
]
const MAX_REQUEST_BODY_BYTES = 64 * 1024
/** A setup patch is three small scalars; anything larger is not a patch. */
const MAX_SETUP_BODY_BYTES = 2 * 1024

function json(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return
  const body = JSON.stringify(payload)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'no-store',
      ...extraHeaders,
    })
    res.end(body)
  } catch {
    res.destroy()
  }
}

/**
 * Redacts ticket, token, cookie and launch-URL material from a server error
 * before it is shown in the panel. The message is bounded.
 * @param {unknown} error
 * @returns {string}
 */
export function redactErrorMessage(error) {
  let message = error instanceof Error ? error.message : String(error)
  message = message
    .replace(/([?&]token=)[^&\s]*/gi, '$1[redacted]')
    .replace(/\bdsh_pair=[^;\s]*/g, 'dsh_pair=[redacted]')
    .replace(/\/pair\/[A-Za-z0-9_-]{43}/g, '/pair/[redacted]')
    .replace(/\b[A-Za-z0-9_-]{43}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  return message.length > 500 ? `${message.slice(0, 500)}…` : message || 'pair request failed'
}

async function readJsonBody(request, limit = MAX_REQUEST_BODY_BYTES) {
  const chunks = []
  let received = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    received += buffer.length
    if (received > limit) {
      const error = new Error('request body is too large')
      error.code = 'BODY_TOO_LARGE'
      throw error
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('request body is not valid JSON')
    error.code = 'BODY_INVALID'
    throw error
  }
}

/**
 * Runs the shared admission guard.
 * @returns {{ok: true}|{ok: false, status: number}}
 */
function authorize(ctx, request) {
  // S4 barrier: only the gate sets this marker while proxying. A phone (or
  // anything else) reaching the harness listener with it must never drive an
  // operator route, so its mere presence refuses before any other guard.
  const headers = request?.headers
  if (headers !== null && typeof headers === 'object' && headers['x-dsh-pair-proxied'] !== undefined) {
    return { ok: false, status: 403 }
  }

  let connection
  try {
    connection = ctx?.connection
  } catch {
    return { ok: false, status: 503 }
  }
  if (connection === null || typeof connection !== 'object') {
    return { ok: false, status: 503 }
  }
  if (typeof connection.requestRejection !== 'function' || typeof connection.admit !== 'function') {
    return { ok: false, status: 503 }
  }

  let rejection
  try {
    rejection = connection.requestRejection(request)
  } catch {
    return { ok: false, status: 403 }
  }
  if (typeof rejection === 'number') {
    return { ok: false, status: rejection }
  }

  const address = request?.socket?.remoteAddress
  if (typeof address !== 'string' || !LOOPBACK_ADDRESSES.has(address)) {
    return { ok: false, status: 403 }
  }

  let admission
  try {
    admission = connection.admit(request)
  } catch {
    return { ok: false, status: 403 }
  }
  if (admission === null || typeof admission !== 'object') return { ok: false, status: 403 }
  if (admission.peer?.principal?.kind !== 'owner') return { ok: false, status: 403 }
  return { ok: true }
}

async function dispatch(ctx, service, spec, request, response, setup = null) {
  const guard = authorize(ctx, request)
  if (!guard.ok) {
    json(response, guard.status, { error: guard.status === 403 ? 'forbidden' : 'request rejected' })
    return
  }
  if (request.method !== spec.method) {
    json(response, 405, { error: 'method not allowed' }, { allow: spec.method })
    return
  }

  try {
    switch (spec.path) {
      case '/pair/api/status':
        json(response, 200, service.status())
        return
      case '/pair/api/start':
        await service.start()
        json(response, 200, { ok: true })
        return
      case '/pair/api/stop':
        await service.stop()
        json(response, 200, { ok: true })
        return
      case '/pair/api/reissue':
        await service.reissue()
        json(response, 200, { ok: true })
        return
      case '/pair/api/revoke': {
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 400
          json(response, status, { error: redactErrorMessage(error) })
          return
        }
        if (body === null || typeof body !== 'object' || typeof body.deviceId !== 'string' || body.deviceId.length === 0) {
          json(response, 400, { error: 'deviceId is required' })
          return
        }
        await service.revoke(body.deviceId)
        json(response, 200, { ok: true })
        return
      }
      case '/pair/api/devices/notifications': {
        // Operator switch: the same per-device settings the phone owns, applied
        // from the host. The device id is part of the body here because the
        // caller is the loopback operator, not a paired phone.
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 400
          json(response, status, { error: redactErrorMessage(error) })
          return
        }
        if (body === null || typeof body !== 'object' || typeof body.deviceId !== 'string' || body.deviceId.length === 0) {
          json(response, 400, { error: 'deviceId is required' })
          return
        }
        if (typeof service.setDeviceNotifications !== 'function') {
          json(response, 503, { error: 'push notifications are unavailable' })
          return
        }
        let view
        try {
          view = await service.setDeviceNotifications(body.deviceId, {
            enabled: body.enabled,
            categories: body.categories,
          })
        } catch (error) {
          json(response, 400, { error: redactErrorMessage(error) })
          return
        }
        json(response, 200, { ok: true, notifications: view })
        return
      }
      case '/pair/api/push/test': {
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 400
          json(response, status, { error: redactErrorMessage(error) })
          return
        }
        if (body === null || typeof body !== 'object' || typeof body.deviceId !== 'string' || body.deviceId.length === 0) {
          json(response, 400, { error: 'deviceId is required' })
          return
        }
        if (typeof service.pushTest !== 'function') {
          json(response, 503, { error: 'push notifications are unavailable' })
          return
        }
        const result = service.pushTest(body.deviceId)
        if (result !== null && result.ok === true) {
          json(response, 200, { ok: true })
          return
        }
        const reason = result !== null && typeof result.reason === 'string' ? result.reason : 'unavailable'
        if (reason === 'cooldown') {
          const retryAfter = Number.isFinite(result?.retryAfter) ? result.retryAfter : 60
          json(response, 429, { error: 'a test notification was already sent' }, { 'retry-after': String(retryAfter) })
          return
        }
        if (reason === 'no-subscription') {
          json(response, 409, { error: 'this device has no push subscription' })
          return
        }
        json(response, 409, { error: 'notifications are switched off on this device' })
        return
      }
      case '/pair/api/setup': {
        if (setup === null || typeof setup.status !== 'function') {
          json(response, 503, { error: 'Tailscale setup is unavailable' })
          return
        }
        json(response, 200, await setup.status())
        return
      }
      case '/pair/api/setup/apply': {
        if (setup === null || typeof setup.apply !== 'function') {
          json(response, 503, { error: 'Tailscale setup is unavailable' })
          return
        }
        let body
        try {
          body = await readJsonBody(request, MAX_SETUP_BODY_BYTES)
        } catch (error) {
          const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 400
          json(response, status, { error: redactErrorMessage(error) })
          return
        }
        if (body !== null && (typeof body !== 'object' || Array.isArray(body))) {
          json(response, 400, { error: 'the setup patch must be a JSON object' })
          return
        }
        try {
          json(response, 200, await setup.apply(body ?? {}))
        } catch (error) {
          const status = error?.status === 409 ? 409 : error?.status === 400 ? 400 : 500
          json(response, status, { error: redactErrorMessage(error) })
        }
        return
      }
      case '/pair/api/setup/funnel': {
        if (setup === null || typeof setup.runFunnel !== 'function') {
          json(response, 503, { error: 'Tailscale setup is unavailable' })
          return
        }
        try {
          const result = await setup.runFunnel()
          // Re-detect after the run so the panel can draw the new state from one
          // response instead of racing a second poll.
          const status = typeof setup.status === 'function' ? await setup.status() : null
          json(response, 200, { ...result, status })
        } catch (error) {
          const status = error?.status === 409 ? 409 : 500
          const payload = { error: redactErrorMessage(error) }
          if (error?.result !== undefined && error.result !== null) Object.assign(payload, error.result)
          json(response, status, payload)
        }
        return
      }
      default:
        json(response, 404, { error: 'not found' })
    }
  } catch (error) {
    json(response, 500, { error: redactErrorMessage(error) })
  }
}

/**
 * Registers one route list on the harness web server and returns its disposer.
 * @param {object} ctx - host context with `webServer`.
 * @param {object} service - Pair service.
 * @param {Array<{path: string, method: string}>} specs
 * @param {object|null} [setup] - Tailscale setup service (setup routes only).
 * @returns {() => void}
 */
function registerRoutes(ctx, service, specs, setup = null) {
  if (ctx?.webServer === null || typeof ctx?.webServer !== 'object' || typeof ctx.webServer.register !== 'function') {
    throw new Error('pair routes: ctx.webServer.register is required')
  }
  if (service === null || typeof service !== 'object') {
    throw new Error('pair routes: a pair service is required')
  }
  const disposers = []
  try {
    for (const spec of specs) {
      const dispose = ctx.webServer.register({
        kind: 'exact',
        path: spec.path,
        handler: (request, response) => {
          dispatch(ctx, service, spec, request, response, setup).catch(error => {
            try {
              if (typeof ctx?.logger?.warn === 'function') {
                ctx.logger.warn(`[pair] ${spec.path} failed: ${redactErrorMessage(error)}`)
              }
            } catch {
              /* logging must never break the response */
            }
            json(response, 500, { error: redactErrorMessage(error) })
          })
        },
      })
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* keep disposing the rest */
      }
    }
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* the web server may already be gone */
      }
    }
  }
}

/**
 * Registers the five lifecycle operator routes on the harness web server.
 * @param {object} ctx - host context with `connection` and `webServer`.
 * @param {object} service - Pair service (`status`, `start`, `stop`, `reissue`, `revoke`).
 * @returns {() => void} disposer removing every registered route.
 */
export function registerPairRoutes(ctx, service) {
  return registerRoutes(ctx, service, ROUTES)
}

/**
 * Registers the two push operator routes. They share `dispatch`, so the guard
 * order (proxied marker → requestRejection → loopback → owner) is identical to
 * the lifecycle routes.
 * @param {object} ctx - host context with `connection` and `webServer`.
 * @param {object} service - Pair service (`setDeviceNotifications`, `pushTest`).
 * @returns {() => void} disposer removing both routes.
 */
export function registerPushRoutes(ctx, service) {
  return registerRoutes(ctx, service, PUSH_ROUTES)
}

/**
 * Registers the three Tailscale setup operator routes. They share `dispatch`, so
 * the guard order (proxied marker → requestRejection → loopback → owner) is
 * identical to the lifecycle routes, and `/pair/api/*` stays unreachable through
 * the tunnel: the gate answers 404 there.
 * @param {object} ctx - host context with `connection` and `webServer`.
 * @param {object} service - Pair service (kept for the shared dispatcher).
 * @param {{status: Function, apply: Function, runFunnel: Function}} setup - setup service.
 * @returns {() => void} disposer removing all three routes.
 */
export function registerSetupRoutes(ctx, service, setup) {
  return registerRoutes(ctx, service, SETUP_ROUTES, setup ?? null)
}

export default registerPairRoutes
