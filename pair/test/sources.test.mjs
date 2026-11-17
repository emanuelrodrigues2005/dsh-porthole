/**
 * Contract tests for pair/host/sources.js — the push sources (S4).
 *
 * The hooks are observed, never consulted: `session/event` is emitted after the
 * fact, and the question waterfall must always be delegated with `next()`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { registerPushSources, SHORT_TURN_MS } from '../host/sources.js'
import { createClock } from './helpers.mjs'

const ROOT_SESSION = { header: { id: 'session-root' } }
const CHILD_SESSION = { header: { id: 'session-child', parentSession: 'session-root' } }

function createFakeContext() {
  const listeners = new Map()
  const ctx = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(handler)
      return () => {
        listeners.get(event)?.delete(handler)
      }
    },
  }
  return {
    ctx,
    count(event) {
      return listeners.get(event)?.size ?? 0
    },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args)
    },
    handlers(event) {
      return [...(listeners.get(event) ?? [])]
    },
  }
}

function createSources(options = {}) {
  const fake = createFakeContext()
  const clock = createClock()
  const notifications = []
  const resolved = []
  const dispose = registerPushSources(fake.ctx, {
    notify: item => notifications.push(item),
    resolve: key => resolved.push(key),
    now: clock.now,
    ...options,
  })
  return { ...fake, clock, notifications, resolved, dispose }
}

function sessionEvent(sources, session, event) {
  for (const handler of sources.handlers('session/event')) handler(session, event)
}

/* ------------------------------------------------------------------------- *
 * Approvals
 * ------------------------------------------------------------------------- */

test('an asked approval queues one notification carrying the tool call arguments', () => {
  const sources = createSources()

  sessionEvent(sources, ROOT_SESSION, {
    type: 'tool/call',
    turn: 1,
    step: 1,
    callId: 'call-1',
    name: 'bash',
    arguments: '{"command":"git status --short"}',
  })
  sessionEvent(sources, ROOT_SESSION, {
    type: 'approval/asked',
    id: 'approval-1',
    toolName: 'bash',
    callId: 'call-1',
    reason: 'writes to the working tree',
  })

  assert.equal(sources.notifications.length, 1)
  const item = sources.notifications[0]
  assert.equal(item.category, 'approvals')
  assert.match(item.title, /bash/)
  assert.match(item.body, /git status --short/)
  assert.equal(item.dedupeKey, 'approval:approval-1')
  assert.equal(item.url, '/')
})

test('a decided approval resolves the dedupe key and queues nothing more', () => {
  const sources = createSources()

  sessionEvent(sources, ROOT_SESSION, { type: 'approval/asked', id: 'approval-2', toolName: 'edit' })
  sessionEvent(sources, ROOT_SESSION, { type: 'approval/decided', id: 'approval-2', outcome: 'approved' })

  assert.equal(sources.notifications.length, 1, 'the decision itself is not a notification')
  assert.deepEqual(sources.resolved, ['approval:approval-2'])
})

test('an approval without a tool/call still queues a usable notification', () => {
  const sources = createSources()

  sessionEvent(sources, ROOT_SESSION, {
    type: 'approval/asked',
    id: 'approval-3',
    toolName: 'webfetch',
    callId: 'missing-call',
    reason: 'needs network',
  })

  assert.equal(sources.notifications.length, 1)
  assert.equal(sources.notifications[0].body, 'needs network')
})

/* ------------------------------------------------------------------------- *
 * Turn completion
 * ------------------------------------------------------------------------- */

test('a long root turn queues a completion notification', () => {
  const sources = createSources()

  sessionEvent(sources, ROOT_SESSION, { type: 'turn/start', turn: 4 })
  sources.clock.advance(SHORT_TURN_MS + 5_000)
  sessionEvent(sources, ROOT_SESSION, { type: 'turn/end', turn: 4, reason: { kind: 'completed' } })

  assert.equal(sources.notifications.length, 1)
  const item = sources.notifications[0]
  assert.equal(item.category, 'completion')
  assert.equal(item.title, 'Turn completed')
  assert.match(item.body, /25s/)
  assert.equal(item.dedupeKey, 'turn:session-root:4')
})

test('a short turn is ignored', () => {
  const sources = createSources()

  sessionEvent(sources, ROOT_SESSION, { type: 'turn/start', turn: 5 })
  sources.clock.advance(SHORT_TURN_MS - 1)
  sessionEvent(sources, ROOT_SESSION, { type: 'turn/end', turn: 5, reason: { kind: 'completed' } })

  assert.deepEqual(sources.notifications, [])
})

test('a child session turn is ignored even when it is long', () => {
  const sources = createSources()

  sessionEvent(sources, CHILD_SESSION, { type: 'turn/start', turn: 1 })
  sources.clock.advance(SHORT_TURN_MS * 3)
  sessionEvent(sources, CHILD_SESSION, { type: 'turn/end', turn: 1, reason: { kind: 'completed' } })

  assert.deepEqual(sources.notifications, [], 'only the operator’s own root turn is worth a notification')
})

test('an aborted or interrupted turn is ignored, while error/blocked/max-tokens notify', () => {
  const sources = createSources()

  for (const kind of ['aborted', 'interrupted', 'forked']) {
    sessionEvent(sources, ROOT_SESSION, { type: 'turn/start', turn: 7 })
    sources.clock.advance(SHORT_TURN_MS * 2)
    sessionEvent(sources, ROOT_SESSION, { type: 'turn/end', turn: 7, reason: { kind } })
    assert.deepEqual(sources.notifications, [], `${kind} must stay silent`)
  }

  for (const [kind, title] of [
    ['error', 'Turn failed'],
    ['blocked', 'Turn blocked'],
    ['max-tokens', 'Turn hit the token limit'],
  ]) {
    sessionEvent(sources, ROOT_SESSION, { type: 'turn/start', turn: 8 })
    sources.clock.advance(SHORT_TURN_MS * 2)
    sessionEvent(sources, ROOT_SESSION, { type: 'turn/end', turn: 8, reason: { kind } })
    assert.equal(sources.notifications.length, 1, `${kind} must notify`)
    assert.equal(sources.notifications[0].title, title)
    sources.notifications.length = 0
  }
})

test('a turn end without a matching turn/start is ignored', () => {
  const sources = createSources()

  sessionEvent(sources, ROOT_SESSION, { type: 'turn/end', turn: 99, reason: { kind: 'completed' } })

  assert.deepEqual(sources.notifications, [])
})

/* ------------------------------------------------------------------------- *
 * The question waterfall
 * ------------------------------------------------------------------------- */

test('a question queues a truncated notification and calls next exactly once', () => {
  const sources = createSources()
  const handler = sources.handlers('user-questions/request')[0]
  assert.equal(typeof handler, 'function')

  const longQuestion = `Please choose an option: ${'x'.repeat(500)}`
  let nextCalls = 0
  const returned = handler(
    { id: 'question-1', questions: [{ header: 'Pick one', question: longQuestion }] },
    () => {
      nextCalls += 1
      return 'the-answer'
    },
  )

  assert.equal(nextCalls, 1, 'next() must be called exactly once')
  assert.equal(returned, 'the-answer', 'the waterfall must receive the delegated promise/value')
  assert.equal(sources.notifications.length, 1)
  const item = sources.notifications[0]
  assert.equal(item.category, 'questions')
  assert.equal(item.dedupeKey, 'question:question-1')
  assert.ok(item.body.length <= 200, `the body must be truncated, got ${String(item.body.length)} chars`)
  assert.ok(item.body.startsWith('Please choose an option:'), 'the body keeps the start of the question')
})

test('a failing notify still delegates the question', () => {
  const sources = createSources({
    notify: () => {
      throw new Error('queue exploded')
    },
  })
  const handler = sources.handlers('user-questions/request')[0]

  let nextCalls = 0
  assert.doesNotThrow(() => handler({ questions: ['why?'] }, () => {
    nextCalls += 1
  }))
  assert.equal(nextCalls, 1, 'a broken notification must never swallow a question')
})

test('a throwing session listener never escapes into the emitter', () => {
  const sources = createSources({
    notify: () => {
      throw new Error('nope')
    },
  })

  assert.doesNotThrow(() => sessionEvent(sources, ROOT_SESSION, { type: 'approval/asked', id: 'a', toolName: 'bash' }))
  assert.doesNotThrow(() => sessionEvent(sources, ROOT_SESSION, null))
  assert.doesNotThrow(() => sessionEvent(sources, ROOT_SESSION, { type: 'approval/decided', id: 'a' }))
})

/* ------------------------------------------------------------------------- *
 * Lifecycle
 * ------------------------------------------------------------------------- */

test('dispose removes both listeners', () => {
  const sources = createSources()
  assert.equal(sources.count('session/event'), 1)
  assert.equal(sources.count('user-questions/request'), 1)

  sources.dispose()

  assert.equal(sources.count('session/event'), 0)
  assert.equal(sources.count('user-questions/request'), 0)
})

test('a context without on() is tolerated', () => {
  assert.doesNotThrow(() => {
    const dispose = registerPushSources({}, { notify: () => {} })
    dispose()
  })
})
