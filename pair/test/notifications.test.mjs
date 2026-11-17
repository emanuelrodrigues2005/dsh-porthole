/**
 * Contract tests for pair/host/notifications.js — the per-device push settings
 * and the bounded in-memory delivery queue (S1).
 *
 * Offline and deterministic: a manual clock, temp directories, no network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  CATEGORY_NAMES,
  DEFAULT_CATEGORIES,
  createNotificationStore,
} from '../host/notifications.js'
import { createClock, makeTempDir, removeTempDir, MINUTE_MS } from './helpers.mjs'

const HOUR_MS = 60 * MINUTE_MS

const ENDPOINT = 'https://fcm.googleapis.com/wp/abc123'

async function setup(t, options = {}) {
  const dir = await makeTempDir()
  t.after(async () => {
    await removeTempDir(dir).catch(() => {})
  })
  const clock = createClock()
  const stateFile = join(dir, 'notifications.json')
  const store = createNotificationStore({ stateFile, now: clock.now, ...options })
  return { dir, clock, stateFile, store }
}

test('a device with no record starts enabled with every category on', async t => {
  const { store } = await setup(t)

  const view = store.view('device-1')

  assert.equal(view.enabled, true)
  assert.deepEqual(view.categories, DEFAULT_CATEGORIES)
  assert.equal(view.subscription, null)
  assert.deepEqual([...CATEGORY_NAMES], ['approvals', 'questions', 'completion', 'reports'])
  // Reading a device must not create a record behind the operator's back.
  assert.deepEqual(store.list(), [])
})

test('ensure is idempotent and keeps the original createdAt', async t => {
  const { store, clock } = await setup(t)

  const first = store.ensure('device-1')
  const createdAt = first.createdAt
  clock.advance(HOUR_MS)
  const second = store.ensure('device-1')

  assert.equal(second.createdAt, createdAt, 'ensure must not re-create the record')
  assert.equal(store.list().length, 1, 'ensure must not duplicate the record')
  assert.equal(store.list()[0].updatedAt, createdAt)
})

test('persist writes atomically, leaves no temp file, and a reopened store sees the settings', async t => {
  const { store, stateFile, dir, clock } = await setup(t)

  store.updateSettings('device-1', { enabled: false, categories: { questions: false } })
  store.setSubscription('device-1', { endpoint: ENDPOINT, userAgent: 'TestPhone/1.0' })
  store.persist()

  assert.ok(existsSync(stateFile), 'persist must create the settings file')
  const leftovers = readdirSync(dir).filter(name => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], 'the atomic rename must not leave a temp file behind')

  const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(parsed.version, 1)
  assert.equal(parsed.devices['device-1'].enabled, false)
  assert.equal(parsed.devices['device-1'].categories.questions, false)
  assert.equal(parsed.devices['device-1'].subscription.endpoint, ENDPOINT)
  // The queue is memory only: nothing about an undrained item reaches disk.
  store.enqueue({ deviceId: 'device-1', category: 'approvals', title: 't', body: 'b', dedupeKey: 'approval:1' })
  store.persist()
  assert.equal(readFileSync(stateFile, 'utf8').includes('approval:1'), false)

  const reopened = createNotificationStore({ stateFile, now: clock.now })
  const view = reopened.view('device-1')
  assert.equal(view.enabled, false)
  assert.equal(view.categories.questions, false)
  assert.equal(view.subscription.host, 'fcm.googleapis.com', 'the operator view redacts the endpoint to its host')
  assert.equal(reopened.endpointFor('device-1'), ENDPOINT, 'the sender still reads the raw endpoint')
  assert.equal(reopened.loadError, null)
})

test('a corrupted settings file is reported, ignored, and replaced on the next persist', async t => {
  const dir = await makeTempDir()
  t.after(async () => {
    await removeTempDir(dir).catch(() => {})
  })
  const stateFile = join(dir, 'notifications.json')
  writeFileSync(stateFile, '{ this is not json', 'utf8')

  const store = createNotificationStore({ stateFile })

  assert.ok(typeof store.loadError === 'string' && store.loadError.length > 0, 'a corrupt file must be reported')
  assert.deepEqual(store.list(), [], 'a corrupt file must not resurrect partial settings')
  assert.equal(store.view('device-1').enabled, true, 'the defaults still apply')

  store.updateSettings('device-1', { enabled: false })
  store.persist()
  const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(parsed.devices['device-1'].enabled, false, 'the rewrite must produce a valid file')
})

test('settings validation rejects unknown categories and non-boolean values', async t => {
  const { store } = await setup(t)

  assert.throws(() => store.updateSettings('device-1', { categories: { telepathy: true } }), /unknown notification category/)
  assert.throws(() => store.updateSettings('device-1', { categories: { approvals: 'yes' } }), /must be a boolean/)
  assert.throws(() => store.updateSettings('device-1', { enabled: 'yes' }), /enabled must be a boolean/)
  assert.throws(() => store.updateSettings('device-1', 'nope'), /must be an object/)

  const view = store.updateSettings('device-1', { categories: { reports: false } })
  assert.equal(view.categories.reports, false)
  assert.equal(view.categories.approvals, true, 'a partial patch keeps the other categories')
  assert.deepEqual(Object.keys(view.categories).sort(), [...CATEGORY_NAMES].sort())
})

test('enqueue requires an enabled device, a subscription and the category switched on', async t => {
  const { store } = await setup(t)

  // No record at all: nothing to deliver to.
  assert.equal(store.enqueue({ deviceId: 'device-1', category: 'approvals', title: 'x' }), null)

  store.ensure('device-1')
  assert.equal(store.enqueue({ deviceId: 'device-1', category: 'approvals', title: 'x' }), null, 'no subscription yet')

  store.setSubscription('device-1', { endpoint: ENDPOINT })
  const item = store.enqueue({ deviceId: 'device-1', category: 'approvals', title: 'Approve', body: 'bash' })
  assert.ok(item !== null, 'a subscribed, enabled device receives the item')
  assert.equal(item.category, 'approvals')
  assert.equal(item.url, '/')
  assert.equal(item.resolved, false)

  store.updateSettings('device-1', { categories: { reports: false } })
  assert.equal(
    store.enqueue({ deviceId: 'device-1', category: 'reports', title: 'x' }),
    null,
    'a category the phone switched off is never queued',
  )
  store.updateSettings('device-1', { categories: { reports: true } })
  assert.ok(store.enqueue({ deviceId: 'device-1', category: 'reports', title: 'x' }) !== null)

  store.updateSettings('device-1', { enabled: false })
  assert.equal(store.enqueue({ deviceId: 'device-1', category: 'approvals', title: 'x' }), null, 'a disabled device gets nothing')
})

test('the same dedupe key is coalesced while it is undrained, and dropByDedupe removes it', async t => {
  const { store, clock } = await setup(t)
  store.setSubscription('device-1', { endpoint: ENDPOINT })

  assert.ok(store.enqueue({ deviceId: 'device-1', category: 'approvals', title: 'A', dedupeKey: 'approval:7' }) !== null)
  assert.equal(
    store.enqueue({ deviceId: 'device-1', category: 'approvals', title: 'A again', dedupeKey: 'approval:7' }),
    null,
    'a repeated key is the same event',
  )

  // A decided approval drops the undrained item even before the phone drains.
  assert.equal(store.dropByDedupe('approval:7'), 1)
  assert.equal(store.dropByDedupe('approval:7'), 0, 'dropping is idempotent')
  assert.deepEqual(store.drain('device-1'), [])

  // After the coalesce window the same key is allowed again.
  clock.advance(MINUTE_MS + 1)
  assert.ok(store.enqueue({ deviceId: 'device-1', category: 'approvals', title: 'A', dedupeKey: 'approval:7' }) !== null)
})

test('drain returns this device only, oldest first, and is empty the second time', async t => {
  const { store, clock } = await setup(t)
  store.setSubscription('device-1', { endpoint: ENDPOINT })
  store.setSubscription('device-2', { endpoint: 'https://push.example.net/wp/def' })

  store.enqueue({ deviceId: 'device-1', category: 'approvals', title: 'first' })
  clock.advance(1000)
  store.enqueue({ deviceId: 'device-1', category: 'completion', title: 'second' })
  store.enqueue({ deviceId: 'device-2', category: 'approvals', title: 'other device' })

  const drained = store.drain('device-1')
  assert.deepEqual(drained.map(item => item.title), ['first', 'second'])
  assert.ok(drained.every(item => Object.keys(item).sort().join(',') === 'body,category,createdAt,id,title,url'))
  assert.deepEqual(store.drain('device-1'), [], 'the second drain is empty')
  assert.deepEqual(store.drain('device-2').map(item => item.title), ['other device'], 'the other device keeps its items')
})

test('queue limits: per-device cap drops the oldest, and expired items never drain', async t => {
  const { store, clock } = await setup(t, { maxPerDevice: 3 })
  store.setSubscription('device-1', { endpoint: ENDPOINT })

  for (let index = 0; index < 5; index += 1) {
    store.enqueue({ deviceId: 'device-1', category: 'completion', title: `item-${String(index)}` })
    clock.advance(1000)
  }

  assert.equal(store.pending('device-1'), 3, 'the per-device cap is enforced')
  assert.deepEqual(store.drain('device-1').map(item => item.title), ['item-2', 'item-3', 'item-4'])

  // The 30 minute TTL: a notification nobody read is stale by definition.
  store.enqueue({ deviceId: 'device-1', category: 'completion', title: 'stale' })
  clock.advance(30 * MINUTE_MS)
  assert.deepEqual(store.drain('device-1'), [], 'an expired item is dropped instead of delivered')
})

test('the per-device token bucket allows a burst of five and refills over an hour', async t => {
  const { store, clock } = await setup(t, { maxPerDevice: 64 })
  store.setSubscription('device-1', { endpoint: ENDPOINT })

  let accepted = 0
  for (let index = 0; index < 8; index += 1) {
    if (store.enqueue({ deviceId: 'device-1', category: 'completion', title: `item-${String(index)}` }) !== null) {
      accepted += 1
    }
  }
  assert.equal(accepted, 5, 'the burst is five items')

  clock.advance(HOUR_MS / 20)
  assert.ok(store.enqueue({ deviceId: 'device-1', category: 'completion', title: 'later' }) !== null, 'one token refills in three minutes')
  assert.equal(store.enqueue({ deviceId: 'device-1', category: 'completion', title: 'again' }), null)
})

test('recordPush tracks the last status and drops a subscription the push service says is gone', async t => {
  const { store, clock } = await setup(t)
  store.setSubscription('device-1', { endpoint: ENDPOINT })

  const ok = store.recordPush('device-1', { status: 201, ok: true })
  assert.equal(ok.lastPushStatus, 201)
  assert.equal(ok.failureCount, 0)
  assert.equal(ok.lastPushAt, clock.now())

  clock.advance(1000)
  const failed = store.recordPush('device-1', { status: 503, ok: false })
  assert.equal(failed.failureCount, 1)
  assert.equal(failed.lastPushStatus, 503)
  assert.equal(store.endpointFor('device-1'), ENDPOINT, 'a 503 keeps the subscription')

  const gone = store.recordPush('device-1', { status: 410, ok: false, drop: true })
  assert.equal(gone.subscription, null, 'a 410 drops the subscription')
  assert.equal(store.endpointFor('device-1'), null)
})

test('the settings file is written with owner-only permissions', async t => {
  const { store, stateFile } = await setup(t)
  store.ensure('device-1')
  store.persist()

  if (process.platform === 'win32') return
  const mode = statSync(stateFile).mode & 0o777
  assert.equal(mode, 0o600, 'the settings file must be owner-only')
})
