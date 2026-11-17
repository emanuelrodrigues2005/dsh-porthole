/**
 * `pair_setup_status` and `pair_setup_apply` — the model-facing half of the
 * guided Tailscale setup.
 *
 * The two tools are the only way an agent may touch the setup: one read and one
 * validated write. Neither can run a command. The write is rate limited, and the
 * commands that *are* run (detection and `tailscale funnel --bg <port>`) are
 * fixed in `pair/host/setup.js` — this file never builds an argv.
 *
 * Registration is deployment-level (`ctx.inject(['tools'], …)` in the bundle
 * entry) and optional on both ends: without a tool registry there is simply no
 * tool, and a registry that rejects the row is reported as `null` instead of
 * thrown, so the profile still boots.
 */

const STATUS_TOOL = 'pair_setup_status'
const APPLY_TOOL = 'pair_setup_apply'
/** One write per ten seconds: an applier loop must not rewrite the config. */
export const APPLY_RATE_LIMIT_MS = 10_000

const STATUS_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
})

const APPLY_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    publicUrl: {
      type: 'string',
      description:
        'Bare https origin to publish, such as https://machine.tailnet.ts.net (no path, query or fragment).',
    },
    gatePort: {
      type: 'integer',
      description: 'Fixed loopback gate port Funnel forwards to, between 1 and 65535 (usually 8791).',
    },
    autoStart: {
      type: 'boolean',
      description: 'Start the gate on load once a public URL is configured.',
    },
  },
  required: [],
  additionalProperties: false,
})

const STATUS_OUTPUT = Object.freeze({
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    needs: { type: 'array', items: { type: 'string' } },
    suggestedUrl: { type: 'string' },
    publicUrl: { type: 'string' },
  },
  required: ['ok', 'needs'],
  additionalProperties: true,
})

const APPLY_OUTPUT = Object.freeze({
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    needs: { type: 'array', items: { type: 'string' } },
    error: { type: 'string' },
  },
  required: ['ok'],
  additionalProperties: true,
})

/** One readable sentence for the operator, from the detection object. */
function statusSummary(value) {
  if (value === null || typeof value !== 'object') return 'setup status is unavailable'
  const needs = Array.isArray(value.needs) ? value.needs.join(', ') : 'unknown'
  const tailscale = value.tailscale !== null && typeof value.tailscale === 'object' ? value.tailscale : {}
  const funnel = value.funnel !== null && typeof value.funnel === 'object' ? value.funnel : {}
  const config = value.config !== null && typeof value.config === 'object' ? value.config : {}
  const parts = [
    `needs: ${needs}`,
    tailscale.installed === true
      ? `tailscale ${String(tailscale.version ?? 'installed')} (${tailscale.running === true ? 'running' : 'not running'})`
      : 'tailscale is not installed',
    funnel.on === true ? `funnel on ${String(funnel.url ?? 'unknown')}` : 'funnel is off',
    `publicUrl: ${String(config.publicUrl === '' ? '(not set)' : config.publicUrl)}`,
  ]
  return parts.join(' | ')
}

/**
 * Bounds what the model receives: the detection object is already small, but a
 * path or an error string must never grow without a limit.
 */
function boundStatus(value) {
  if (value === null || typeof value !== 'object') return { ok: false, needs: ['install'] }
  const bounded = JSON.parse(JSON.stringify(value))
  const binary = bounded?.tailscale?.binary
  if (typeof binary === 'string' && binary.length > 260) bounded.tailscale.binary = `${binary.slice(0, 259)}…`
  return bounded
}

/**
 * Registers both setup tools.
 * @param {object} ctx - context carrying `tools`.
 * @param {{status: Function, apply: Function}} setup - the setup service.
 * @param {{now?: () => number, rateLimitMs?: number}} [options]
 * @returns {(() => void) | null} disposer when registered.
 */
export function registerSetupTool(ctx, setup, options = {}) {
  if (ctx === null || typeof ctx !== 'object') return null
  const tools = ctx.tools
  if (tools === null || typeof tools !== 'object' || typeof tools.register !== 'function') return null
  if (setup === null || typeof setup !== 'object') return null
  if (typeof setup.status !== 'function' || typeof setup.apply !== 'function') return null

  const now = typeof options.now === 'function' ? options.now : Date.now
  const rateLimitMs = Number.isSafeInteger(options.rateLimitMs) && options.rateLimitMs >= 0
    ? options.rateLimitMs
    : APPLY_RATE_LIMIT_MS
  let lastApplyAt = Number.NEGATIVE_INFINITY

  const statusDefinition = {
    name: STATUS_TOOL,
    description:
      'Read the Tailscale setup state for this harness: whether Tailscale is installed and running, the detected https://<machine>.<tailnet>.ts.net URL, whether Funnel is on and forwards to the gate port, the configured public URL and the ordered list of remaining steps (`needs`). Read-only; runs only fixed `tailscale` probes.',
    parameters: STATUS_PARAMETERS,
    output: {
      schema: STATUS_OUTPUT,
      render(_args, value) {
        return [{ type: 'text', text: statusSummary(value) }]
      },
    },
    async execute() {
      try {
        return boundStatus(await setup.status())
      } catch (error) {
        return {
          ok: false,
          needs: ['install'],
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }

  const applyDefinition = {
    name: APPLY_TOOL,
    description:
      'Apply a validated Tailscale public URL / gate port / autoStart patch to this harness. Writes $DSH_HOME/pair/config.json atomically and restarts the Pair gate so the change is live without restarting the harness. Requires the operator route to be reachable; returns the fresh setup status. Rate limited to one call per 10 seconds.',
    parameters: APPLY_PARAMETERS,
    output: {
      schema: APPLY_OUTPUT,
      render(_args, value) {
        if (value === null || typeof value !== 'object') return [{ type: 'text', text: 'apply failed' }]
        if (value.ok !== true) {
          return [{ type: 'text', text: `apply rejected: ${String(value.error ?? value.reason ?? 'unknown reason')}` }]
        }
        return [{ type: 'text', text: `applied — ${statusSummary(value)}` }]
      },
    },
    async execute(args) {
      const current = now()
      if (current - lastApplyAt < rateLimitMs) {
        const retryAfter = Math.max(1, Math.ceil((rateLimitMs - (current - lastApplyAt)) / 1000))
        return {
          ok: false,
          reason: 'rate-limited',
          retryAfter,
          error: `another apply ran less than ${String(Math.round(rateLimitMs / 1000))}s ago; retry in ${String(retryAfter)}s`,
        }
      }
      lastApplyAt = current
      try {
        const status = boundStatus(await setup.apply(args ?? {}))
        return { ...status, ok: true }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }

  const disposers = []
  try {
    for (const definition of [statusDefinition, applyDefinition]) {
      const dispose = tools.register(definition)
      if (typeof dispose === 'function') disposers.push(dispose)
    }
  } catch {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* keep disposing */
      }
    }
    return null
  }
  if (disposers.length === 0) return null
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* the registry may already be gone */
      }
    }
  }
}

export default registerSetupTool
