/**
 * Push sources: the non-blocking observation of harness events.
 *
 * Every hook here is an observer, never a participant:
 * - approvals and turn ends arrive through `session/event`, which is emitted
 *   after the fact, so a listener cannot approve, deny or delay anything;
 * - the question hook is a waterfall, so the handler queues and then delegates
 *   with `return next()` — the phone notification never answers for the user;
 * - every body is wrapped in try/catch and every failure is swallowed, because
 *   a broken notification must not break a turn.
 *
 * The listener also keeps two small bounded maps: `tool/call` arguments (so an
 * approval notification can name what is being approved) and `turn/start`
 * timestamps (so a sub-second turn does not buzz the phone).
 */
const MINUTE_MS = 60_000
/** A completion notification is only worth a buzz for a turn that took real time. */
export const SHORT_TURN_MS = 20_000
const TITLE_LIMIT = 120
const BODY_LIMIT = 300
const QUESTION_LIMIT = 200
const MAX_CALLS = 128
const MAX_SESSIONS = 256
/** Turn endings worth a notification. `aborted`/`interrupted`/`forked` are not. */
const COMPLETION_KINDS = new Map([
  ['completed', { title: 'Turn completed', verb: 'finished' }],
  ['error', { title: 'Turn failed', verb: 'failed' }],
  ['blocked', { title: 'Turn blocked', verb: 'was blocked' }],
  ['max-tokens', { title: 'Turn hit the token limit', verb: 'stopped at the token limit' }],
])

function clampText(value, limit) {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
  if (text.length === 0) return ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function compact(value) {
  if (typeof value === 'string') return clampText(value, BODY_LIMIT)
  if (value === null || value === undefined) return ''
  try {
    return clampText(JSON.stringify(value), BODY_LIMIT)
  } catch {
    return ''
  }
}

function sessionIdOf(session) {
  try {
    const id = session?.header?.id ?? session?.id
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    return null
  }
}

/** Only a root session is the operator's own turn; a child is noise. */
function isRootSession(session) {
  try {
    const parent = session?.header?.parentSession
    return parent === undefined || parent === null
  } catch {
    return false
  }
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(rest)}s`
}

function questionText(request) {
  const questions = Array.isArray(request?.questions) ? request.questions : []
  for (const entry of questions) {
    if (typeof entry === 'string' && entry.trim().length > 0) return entry
    if (entry === null || typeof entry !== 'object') continue
    for (const key of ['question', 'text', 'prompt', 'header', 'label']) {
      if (typeof entry[key] === 'string' && entry[key].trim().length > 0) return entry[key]
    }
  }
  return ''
}

/**
 * Registers the push sources on the host context.
 *
 * @param {object} ctx - host context with `on`.
 * @param {object} options
 * @param {(item: object) => unknown} options.notify - queues one notification.
 * @param {(dedupeKey: string) => unknown} [options.resolve] - drops an undrained
 *   item whose reason disappeared.
 * @param {() => number} [options.now]
 * @param {{warn?: Function}} [options.logger]
 * @returns {() => void} disposer removing every listener this call added.
 */
export function registerPushSources(ctx, options = {}) {
  const notify = typeof options.notify === 'function' ? options.notify : () => 0
  const resolve = typeof options.resolve === 'function' ? options.resolve : () => 0
  const now = typeof options.now === 'function' ? options.now : Date.now

  /** @type {Array<() => void>} */
  const disposers = []
  /** callId -> {name, arguments}, so an approval can show what is being run. */
  const calls = new Map()
  /** sessionId -> turn start time, for the short-turn rule. */
  const turnStarts = new Map()

  function warn(error) {
    try {
      if (typeof options.logger?.warn === 'function') {
        const message = error instanceof Error ? error.message : String(error)
        options.logger.warn(`[pair] notification source failed: ${message}`)
      }
    } catch {
      /* logging must never break the listener */
    }
  }

  function safeNotify(item) {
    try {
      notify(item)
    } catch (error) {
      warn(error)
    }
  }

  function safeResolve(dedupeKey) {
    try {
      resolve(dedupeKey)
    } catch (error) {
      warn(error)
    }
  }

  function rememberCall(event) {
    const callId = typeof event.callId === 'string' ? event.callId : ''
    if (callId.length === 0) return
    calls.set(callId, {
      name: typeof event.name === 'string' ? event.name : '',
      arguments: event.arguments,
    })
    if (calls.size > MAX_CALLS) {
      for (const key of calls.keys()) {
        calls.delete(key)
        if (calls.size <= MAX_CALLS) break
      }
    }
  }

  function handleApprovalAsked(event) {
    const id = typeof event.id === 'string' ? event.id : ''
    if (id.length === 0) return
    const toolName = clampText(event.toolName, TITLE_LIMIT) || 'a tool'
    const call = typeof event.callId === 'string' ? calls.get(event.callId) : undefined
    const summary = call === undefined ? '' : compact(call.arguments)
    const reason = clampText(event.reason, BODY_LIMIT)
    const detail = summary.length > 0 ? summary : reason
    const body = detail.length > 0 ? detail : 'Open DSH to approve or deny.'
    safeNotify({
      category: 'approvals',
      title: clampText(`Approval needed: ${toolName}`, TITLE_LIMIT),
      body: clampText(body, BODY_LIMIT),
      url: '/',
      dedupeKey: `approval:${id}`,
    })
  }

  function handleApprovalDecided(event) {
    const id = typeof event.id === 'string' ? event.id : ''
    if (id.length === 0) return
    // The reason is gone: an undrained notification would open an approval that
    // no longer exists.
    safeResolve(`approval:${id}`)
  }

  function handleTurnEnd(session, event) {
    const sessionId = sessionIdOf(session)
    const startedAt = sessionId === null ? undefined : turnStarts.get(sessionId)
    if (sessionId !== null) turnStarts.delete(sessionId)
    if (!isRootSession(session)) return
    const kind = typeof event.reason?.kind === 'string' ? event.reason.kind : ''
    const known = COMPLETION_KINDS.get(kind)
    if (known === undefined) return
    if (startedAt === undefined) return
    const elapsed = now() - startedAt
    if (!(elapsed >= SHORT_TURN_MS)) return
    const turn = Number.isSafeInteger(event.turn) ? event.turn : null
    const detail = typeof event.reason?.error?.message === 'string' ? clampText(event.reason.error.message, BODY_LIMIT) : ''
    const head = turn === null ? `A turn ${known.verb}` : `Turn ${String(turn)} ${known.verb}`
    const body = detail.length > 0
      ? `${head} after ${formatDuration(elapsed)}: ${detail}`
      : `${head} after ${formatDuration(elapsed)}.`
    safeNotify({
      category: 'completion',
      title: known.title,
      body: clampText(body, BODY_LIMIT),
      url: '/',
      dedupeKey: `turn:${sessionId ?? 'root'}:${turn === null ? String(startedAt) : String(turn)}`,
    })
  }

  function onSessionEvent(session, event) {
    try {
      if (event === null || typeof event !== 'object') return
      const type = event.type
      if (type === 'tool/call') {
        rememberCall(event)
        return
      }
      if (type === 'turn/start') {
        const sessionId = sessionIdOf(session)
        if (sessionId === null) return
        turnStarts.set(sessionId, now())
        if (turnStarts.size > MAX_SESSIONS) {
          for (const key of turnStarts.keys()) {
            turnStarts.delete(key)
            if (turnStarts.size <= MAX_SESSIONS) break
          }
        }
        return
      }
      if (type === 'turn/end') {
        handleTurnEnd(session, event)
        return
      }
      if (type === 'approval/asked') {
        handleApprovalAsked(event)
        return
      }
      if (type === 'approval/decided') {
        handleApprovalDecided(event)
      }
    } catch (error) {
      warn(error)
    }
  }

  /**
   * The question waterfall: queue a notification, then always delegate. The
   * `next()` call is unconditional and happens exactly once, even when queueing
   * throws, because the plugin must never answer a question.
   */
  function onUserQuestions(request, next) {
    try {
      const text = questionText(request)
      const id = typeof request?.id === 'string' && request.id.length > 0 ? request.id : null
      safeNotify({
        category: 'questions',
        title: 'Question from DSH',
        body: clampText(text, QUESTION_LIMIT) || 'Open DSH to answer the question.',
        url: '/',
        dedupeKey: id === null ? `question:${clampText(text, 60)}` : `question:${id}`,
      })
    } catch (error) {
      warn(error)
    }
    return typeof next === 'function' ? next() : undefined
  }

  function register(event, listener) {
    try {
      if (typeof ctx?.on !== 'function') return false
      const dispose = ctx.on(event, listener)
      if (typeof dispose === 'function') disposers.push(dispose)
      return true
    } catch (error) {
      warn(error)
      return false
    }
  }

  register('session/event', onSessionEvent)
  register('user-questions/request', onUserQuestions)

  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        /* the context may already be disposed */
      }
    }
  }
}

export default registerPushSources
