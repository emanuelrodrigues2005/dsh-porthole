/**
 * `pair_notify_report` — the model-facing report source for Pair (S5).
 *
 * A reporter subagent (or Equipe itself) hands one finished unit of work to
 * this tool; it queues a `reports`-category notification on every device that
 * subscribed and left the category on, then returns immediately. Delivery is
 * the service's problem: the tool never awaits a push and never surfaces a
 * transport or rate-limit failure.
 *
 * Registration is deployment-level (`ctx.inject(['tools'], …)` in the bundle
 * entry) and optional on both ends: without a tool registry or without a
 * notification store there is simply no tool. The registration also carries a
 * visibility predicate so only `equipe` and `reporter` sessions are offered a
 * tool whose only job is to talk to an operator.
 */

/** Presets allowed to see the report tool. */
export const REPORT_PRESETS = Object.freeze(['equipe', 'reporter'])

const TOOL_NAME = 'pair_notify_report'
const MAX_TITLE_LENGTH = 80
const MAX_BODY_LENGTH = 700
const MAX_BODY_LINES = 10
const MAX_ISSUE_LENGTH = 120
const SEVERITIES = new Set(['info', 'warn', 'error'])

/** Collapses whitespace (a notification is one line per field) and clamps. */
function clampText(value, limit) {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
  if (text.length === 0) return ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** At most ten lines and 700 characters, newlines preserved. */
function clampBody(value) {
  const text = typeof value === 'string' ? value.replace(/\r\n?/gu, '\n').trim() : ''
  const joined = text.split('\n').slice(0, MAX_BODY_LINES).join('\n').trim()
  if (joined.length <= MAX_BODY_LENGTH) return joined
  return `${joined.slice(0, MAX_BODY_LENGTH - 1)}…`
}

/**
 * Normalizes model arguments into the queue's report shape. Never throws: a
 * malformed call degrades to an empty report the store can still clamp.
 */
function normalizeReport(args) {
  const input = args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const severity = typeof input.severity === 'string' && SEVERITIES.has(input.severity) ? input.severity : 'info'
  const issue = clampText(input.issue, MAX_ISSUE_LENGTH)
  const title = clampText(input.title, MAX_TITLE_LENGTH) || 'DSH report'
  const prefix = severity === 'info' ? '' : `[${severity}] `
  return {
    title: clampText(`${prefix}${title}`, MAX_TITLE_LENGTH),
    body: clampBody(input.body),
    issue,
    url: '/',
  }
}

/** The JSON Schema the model sees; the tool validates the bounds itself. */
const PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Headline of 80 characters or fewer; lead with the issue key when there is one.',
    },
    body: {
      type: 'string',
      description: 'Report body: at most ten lines and 700 characters (issue, outcome, files, evidence, top risk).',
    },
    issue: {
      type: 'string',
      description: 'Optional tracker key; a repeated issue coalesces instead of buzzing twice.',
    },
    severity: {
      type: 'string',
      enum: ['info', 'warn', 'error'],
      description: 'How the phone should flag the report; warn and error prefix the title.',
    },
  },
  required: ['title', 'body'],
  additionalProperties: false,
})

const OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    queued: { type: 'boolean' },
    id: { type: 'string' },
    devices: { type: 'integer' },
  },
  required: ['queued', 'id', 'devices'],
  additionalProperties: false,
})

/**
 * Builds the visibility predicate for the report tool: visible to `equipe`
 * and `reporter`, hidden from every other preset. Without a preset registry the
 * tool stays visible, so a profile that does not use presets is unchanged.
 * @param {{presetForSession?: (session: unknown) => (string | null)}} presets
 * @returns {(context?: {agent?: {session?: unknown}}) => boolean}
 */
export function reportToolWhen(presets) {
  if (presets === null || typeof presets !== 'object' || typeof presets.presetForSession !== 'function') {
    return () => true
  }
  return (context = {}) => {
    try {
      const preset = presets.presetForSession(context.agent?.session)
      return preset === 'equipe' || preset === 'reporter'
    } catch {
      // A predicate must not fail step preparation; keep the tool available.
      return true
    }
  }
}

/** The registered definition; the store is captured, never mutated. */
function createDefinition(notifications) {
  return {
    name: TOOL_NAME,
    description:
      'Report one finished piece of work to the operator\'s paired phone. Queues a short notification for every subscribed device and returns immediately; it never blocks the turn. Use it after closing an issue, then continue.',
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        const queued = value !== null && typeof value === 'object' && value.queued === true
        const devices = value !== null && typeof value === 'object' ? value.devices : 0
        const text = queued
          ? `queued report ${String(value.id)} for ${String(devices)} device(s)`
          : 'no subscribed device accepted the report'
        return [{ type: 'text', text }]
      },
    },
    async execute(args) {
      const report = normalizeReport(args)
      try {
        const outcome = notifications.enqueueReport(report)
        const devices = Number.isSafeInteger(outcome?.devices) && outcome.devices > 0 ? outcome.devices : 0
        return {
          queued: outcome?.queued === true && devices > 0,
          id: typeof outcome?.id === 'string' ? outcome.id : '',
          devices,
        }
      } catch {
        /* a report must never break the turn that produced it */
        return { queued: false, id: '', devices: 0 }
      }
    },
  }
}

/**
 * Registers `pair_notify_report` on a context that has the tools service.
 *
 * Optional by contract: a missing registry or notification store means no
 * registration, and a registry that rejects the row is reported as `null`
 * rather than thrown, so a profile still boots.
 *
 * @param {object} ctx - context carrying `tools` and optionally `agentPresets`.
 * @param {{enqueueReport: (report: object) => ({queued: boolean, id: string, devices: number})}} notifications
 * @param {{when?: (context: object) => boolean | Promise<boolean>}} [options]
 * @returns {(() => void) | null} the tool disposer when registered.
 */
export function registerNotifyTool(ctx, notifications, options = {}) {
  if (ctx === null || typeof ctx !== 'object') return null
  const tools = ctx.tools
  if (tools === null || typeof tools !== 'object' || typeof tools.register !== 'function') return null
  if (notifications === null || typeof notifications !== 'object') return null
  if (typeof notifications.enqueueReport !== 'function') return null

  const presets = ctx.agentPresets
  const when = typeof options.when === 'function'
    ? options.when
    : presets !== null && typeof presets === 'object' && typeof presets.presetForSession === 'function'
      ? reportToolWhen(presets)
      : null

  try {
    const dispose = tools.register(createDefinition(notifications), when === null ? {} : { when })
    return typeof dispose === 'function' ? dispose : null
  } catch {
    return null
  }
}

export default registerNotifyTool
