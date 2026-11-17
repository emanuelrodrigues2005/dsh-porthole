/**
 * Contract tests for the push wiring inside pair/host/index.js (S1/S2):
 * the service owns the notification store and the VAPID keypair, queues test
 * notifications with a one-per-minute rule, and clears subscriptions when the
 * VAPID keypair had to be regenerated.
 *
 * Nothing listens and nothing is spawned: the service stays `off`, so no push
 * is ever sent and no network is touched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createPairService } from '../host/index.js'
import { createVapid } from '../host/vapid.js'
import { createClock, makeTempDir, removeTempDir } from './helpers.mjs'

const ENDPOINT = 'https://fcm.googleapis.com/wp/service-device'

function deviceRecord() {
  return {
    version: 1,
    devices: {
      'device-1': {
        enabled: true,
        categories: { approvals: true, questions: true, completion: true, reports: true },
        subscription: { endpoint: ENDPOINT, createdAt: 1_763_000_000_000, userAgent: 'TestPhone/1.0' },
        createdAt: 1_763_000_000_000,
        updatedAt: 1_763_000_000_000,
        lastPushAt: 0,
        lastPushStatus: 0,
        failureCount: 0,
      },
    },
  }
}

async function setup(t, { notifications = deviceRecord(), vapid = null } = {}) {
  const dir = await makeTempDir()
  const clock = createClock()
  const notificationsFile = join(dir, 'notifications.json')
  writeFileSync(notificationsFile, `${JSON.stringify(notifications, null, 2)}\n`, 'utf8')
  if (vapid !== null) {
    writeFileSync(join(dir, 'vapid.json'), vapid, 'utf8')
  } else {
    // A pre-existing, valid keypair: the service must not regenerate it (and so
    // must not drop the subscription seeded above).
    createVapid({ stateFile: join(dir, 'vapid.json'), now: clock.now })
  }

  const service = createPairService({
    stateDir: dir,
    config: { autoStart: false },
    getUpstreamPort: () => 8791,
    getLaunchToken: () => 'launch-token-for-tests',
    now: clock.now,
  })

  t.after(async () => {
    await service.stop()
    await removeTempDir(dir).catch(() => {})
  })

  return { service, dir, clock, notificationsFile }
}

test('the service owns the notification file and the VAPID keypair next to the device state', async t => {
  const { service, dir } = await setup(t)

  const vapid = JSON.parse(readFileSync(join(dir, 'vapid.json'), 'utf8'))
  assert.equal(Buffer.from(vapid.publicKey, 'base64url').length, 65, 'a VAPID keypair is created on load')
  assert.ok(Buffer.from(vapid.privateKey, 'base64url').length === 32)
  // `off` means no gate: nothing can be delivered, so every hook is a quiet no-op.
  assert.equal(service.notify({ category: 'approvals', title: 'x' }), 0)
  assert.equal(service.status().state, 'off')
})

test('pushTest queues one test per minute and reports why it cannot', async t => {
  const { service, clock } = await setup(t)

  assert.equal(service.pushTest('device-1').ok, true, 'a subscribed device gets a test')

  const cooling = service.pushTest('device-1')
  assert.equal(cooling.ok, false)
  assert.equal(cooling.reason, 'cooldown')
  assert.ok(cooling.retryAfter > 0 && cooling.retryAfter <= 60)

  clock.advance(61_000)
  assert.equal(service.pushTest('device-1').ok, true, 'after a minute the test is allowed again')

  assert.deepEqual(service.pushTest('device-9'), { ok: false, reason: 'no-subscription' })
})

test('an operator switch persists the per-device settings without touching the subscription', async t => {
  const { service, notificationsFile } = await setup(t)

  const view = await service.setDeviceNotifications('device-1', { categories: { reports: false } })

  assert.equal(view.categories.reports, false)
  assert.deepEqual(view.subscription, { host: 'fcm.googleapis.com', createdAt: 1_763_000_000_000 })
  const persisted = JSON.parse(readFileSync(notificationsFile, 'utf8'))
  assert.equal(persisted.devices['device-1'].categories.reports, false)
  assert.equal(persisted.devices['device-1'].subscription.endpoint, ENDPOINT)

  await assert.rejects(async () => service.setDeviceNotifications('device-1', { categories: { telepathy: true } }), /unknown notification category/)
})

test('a regenerated VAPID keypair clears the subscriptions signed with the old one', async t => {
  const { service, notificationsFile } = await setup(t, { vapid: '{"version":1,"publicKey":"bad","privateKey":"bad"}' })

  const persisted = JSON.parse(readFileSync(notificationsFile, 'utf8'))
  assert.equal(persisted.devices['device-1'].subscription, null, 'the stale subscription must be dropped')
  assert.equal(persisted.devices['device-1'].enabled, true, 'the settings themselves are kept')
  assert.deepEqual(service.pushTest('device-1'), { ok: false, reason: 'no-subscription' })
})

test('a corrupted notification file does not stop the Pair service from starting', async t => {
  const dir = await makeTempDir()
  writeFileSync(join(dir, 'notifications.json'), 'not json at all', 'utf8')
  const service = createPairService({
    stateDir: dir,
    config: { autoStart: false },
    getUpstreamPort: () => 8791,
    getLaunchToken: () => 'launch-token-for-tests',
  })
  t.after(async () => {
    await service.stop()
    await removeTempDir(dir).catch(() => {})
  })

  assert.equal(service.status().state, 'off', 'a corrupt optional file must not disable pairing')
  assert.deepEqual(service.pushTest('device-1'), { ok: false, reason: 'no-subscription' })
})

test('one device cannot see another device’s notification settings in status()', async t => {
  const { service } = await setup(t)

  const view = service.status().devices
  assert.deepEqual(view, [], 'status only lists devices the ticket store knows')
})
