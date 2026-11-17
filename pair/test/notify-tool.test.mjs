/**
 * Contract tests for pair/host/notify-tool.js — the `pair_notify_report` host
 * tool (S5).
 *
 * Offline and deterministic: a manual clock, a temp directory, and a fake
 * tools registry that records the definition instead of booting Cordis.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { createNotificationStore } from '../host/notifications.js'
import { registerNotifyTool, reportToolWhen } from '../host/notify-tool.js'
import { createClock, makeTempDir, removeTempDir } from './helpers.mjs'

const ENDPOINT = 'https://fcm.googleapis.com/wp/report-abc'

/** Fake registry: records each registration and exposes its disposer. */
function captureTools(agentPresets) {
  const registrations = []
  const ctx = {
    tools: {
      register(definition, options = {}) {
        const entry = { definition, options, disposed: false }
        registrations.push(entry)
        return () => {
          entry.disposed = true
        }
      },
    },
  }
  if (agentPresets !== undefined) ctx.agentPresets = agentPresets
  return { ctx, registrations }
}

/** Real store plus `devices` subscribed records, in a removable temp dir. */
async function setupStore(t, devices = 0) {
  const dir = await makeTempDir()
  t.after(async () => {
    await removeTempDir(dir).catch(() => {})
  })
  const clock = createClock()
  const store = createNotificationStore({ stateFile: join(dir, 'notifications.json'), now: clock.now })
  for (let index = 0; index < devices; index += 1) {
    const deviceId = `device-${index + 1}`
    store.ensure(deviceId)
    store.setSubscription(deviceId, { endpoint: `${ENDPOINT}/${index}` })
  }
  return { store, clock }
}

test('the tool declares the bounded schema, registers once and unregisters on dispose', async t => {
  const { store } = await setupStore(t)
  const { ctx, registrations } = captureTools()

  const dispose = registerNotifyTool(ctx, store)
  assert.equal(typeof dispose, 'function')
  assert.equal(registrations.length, 1)

  const { definition } = registrations[0]
  assert.equal(definition.name, 'pair_notify_report')
  assert.equal(typeof definition.description, 'string')
  assert.equal(definition.parameters.type, 'object')
  assert.deepEqual(definition.parameters.required, ['title', 'body'])
  assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ['body', 'issue', 'severity', 'title'])
  assert.deepEqual(definition.parameters.properties.severity.enum, ['info', 'warn', 'error'])
  assert.equal(definition.parameters.properties.title.type, 'string')
  assert.equal(definition.parameters.properties.body.type, 'string')
  assert.equal(definition.parameters.properties.issue.type, 'string')

  assert.equal(definition.output.schema.type, 'object')
  assert.equal(definition.output.schema.additionalProperties, false)
  assert.deepEqual(definition.output.schema.required, ['queued', 'id', 'devices'])
  assert.deepEqual(Object.keys(definition.output.schema.properties).sort(), ['devices', 'id', 'queued'])

  const content = definition.output.render({}, { queued: true, id: 'id-1', devices: 2 })
  assert.deepEqual(content, [{ type: 'text', text: 'queued report id-1 for 2 device(s)' }])

  dispose()
  assert.equal(registrations[0].disposed, true)
})

test('a missing tools service or a store without enqueueReport skips registration', async t => {
  const { store } = await setupStore(t)

  assert.equal(registerNotifyTool({}, store), null)
  assert.equal(registerNotifyTool({ tools: {} }, store), null)
  const { ctx } = captureTools()
  assert.equal(registerNotifyTool(ctx, {}), null)
  assert.equal(registerNotifyTool(null, store), null)
})

test('execute queues one reports item per subscribed device and returns the count', async t => {
  const { store } = await setupStore(t, 2)
  const { ctx, registrations } = captureTools()
  registerNotifyTool(ctx, store)
  const { definition } = registrations[0]

  const result = await definition.execute({
    title: 'Closed DSH-42',
    body: 'Outcome: shipped.\nFiles: index.js\nEvidence: node --test (green).\nRisk: none.',
    issue: 'DSH-42',
    severity: 'info',
  })

  assert.equal(result.queued, true)
  assert.equal(result.devices, 2)
  assert.equal(typeof result.id, 'string')
  assert.ok(result.id.length > 0)
  assert.deepEqual(Object.keys(result).sort(), ['devices', 'id', 'queued'])

  for (const deviceId of ['device-1', 'device-2']) {
    const drained = store.drain(deviceId)
    assert.equal(drained.length, 1)
    assert.equal(drained[0].category, 'reports')
    assert.equal(drained[0].title, 'Closed DSH-42')
    // The store's one-line body rule still applies: the tool bounds the input to
    // ten lines, the queue collapses it for the notification card.
    assert.equal(
      drained[0].body,
      'Outcome: shipped. Files: index.js Evidence: node --test (green). Risk: none.',
    )
  }
})

test('a repeated issue coalesces instead of queuing a second report', async t => {
  const { store } = await setupStore(t, 1)
  const { ctx, registrations } = captureTools()
  registerNotifyTool(ctx, store)
  const { definition } = registrations[0]

  const first = await definition.execute({ title: 'Closed DSH-7', body: 'done', issue: 'DSH-7' })
  const second = await definition.execute({ title: 'Closed DSH-7', body: 'done again', issue: 'DSH-7' })

  assert.equal(first.queued, true)
  assert.equal(second.queued, false)
  assert.equal(second.devices, 0)
  assert.equal(store.pending('device-1'), 1)
})

test('an empty device bucket returns queued false without throwing', async t => {
  const { store } = await setupStore(t, 0)
  const { ctx, registrations } = captureTools()
  registerNotifyTool(ctx, store)
  const { definition } = registrations[0]

  const result = await definition.execute({ title: 'Closed DSH-1', body: 'done' })
  assert.deepEqual(result, { queued: false, id: '', devices: 0 })

  const { ctx: throwingCtx, registrations: throwingRegistrations } = captureTools()
  registerNotifyTool(throwingCtx, { enqueueReport: () => { throw new Error('queue exploded') } })
  const throwing = await throwingRegistrations[0].definition.execute({ title: 'x', body: 'y' })
  assert.deepEqual(throwing, { queued: false, id: '', devices: 0 })
})

test('the visibility predicate hides the tool from coder and shows it to reporter and equipe', async t => {
  const { store } = await setupStore(t)
  const coder = captureTools({ presetForSession: () => 'coder' })
  const reporter = captureTools({ presetForSession: () => 'reporter' })
  const equipe = captureTools({ presetForSession: () => 'equipe' })
  const withoutPresets = captureTools()

  registerNotifyTool(coder.ctx, store)
  registerNotifyTool(reporter.ctx, store)
  registerNotifyTool(equipe.ctx, store)
  registerNotifyTool(withoutPresets.ctx, store)

  assert.equal(coder.registrations[0].options.when({ agent: { session: {} } }), false)
  assert.equal(reporter.registrations[0].options.when({ agent: { session: {} } }), true)
  assert.equal(equipe.registrations[0].options.when({ agent: { session: {} } }), true)
  assert.equal(withoutPresets.registrations[0].options.when, undefined, 'no registry keeps the tool visible')

  assert.equal(reportToolWhen({ presetForSession: () => 'coder' })({ agent: {} }), false)
  assert.equal(reportToolWhen({ presetForSession: () => 'reporter' })({ agent: {} }), true)
  assert.equal(reportToolWhen({ presetForSession: () => null })({ agent: {} }), false)
  assert.equal(reportToolWhen({ presetForSession: () => { throw new Error('unbound') } })({ agent: {} }), true)
})

test('a rate-limited report still truncates title and body before enqueue', async t => {
  let captured = null
  const { ctx, registrations } = captureTools()
  registerNotifyTool(ctx, {
    enqueueReport(report) {
      captured = report
      return { queued: false, id: '', devices: 0 }
    },
  })
  const { definition } = registrations[0]

  const longTitle = `DSH-99 ${'headline '.repeat(20)}`
  const longBody = Array.from({ length: 15 }, (_value, index) => `line ${index + 1} ${'x'.repeat(80)}`).join('\n')
  const result = await definition.execute({ title: longTitle, body: longBody, issue: '  DSH-99  ', severity: 'error' })

  assert.equal(result.queued, false)
  assert.equal(result.devices, 0)
  assert.ok(captured.title.length <= 80, `title is ${captured.title.length} characters`)
  assert.ok(captured.title.startsWith('[error] DSH-99'), captured.title)
  assert.ok(captured.body.length <= 700, `body is ${captured.body.length} characters`)
  assert.ok(captured.body.split('\n').length <= 10, `body has ${captured.body.split('\n').length} lines`)
  assert.equal(captured.issue, 'DSH-99')
  assert.equal(captured.url, '/')
})
