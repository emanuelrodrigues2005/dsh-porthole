/**
 * Contract tests for pair/host/tickets.js.
 *
 * Ticket = 32 random bytes base64url (43 chars), TTL injected, at most one live.
 * Device token = 32 random bytes base64url, stored hashed, TTL 30 days.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import createTicketStore from '../host/tickets.js'
import { createClock, makeTempDir, removeTempDir, MINUTE_MS, DAY_MS } from './helpers.mjs'

const SECRET = 'pair-test-secret-do-not-persist-me'
const TTL_MS = 5 * MINUTE_MS
const DEVICE_TTL_MS = 30 * DAY_MS
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/

async function setup(t, { clock = createClock(), ttlMs = TTL_MS, secret = SECRET } = {}) {
  const dir = await makeTempDir()
  t.after(() => removeTempDir(dir))
  const stateFile = join(dir, 'devices.json')
  const store = createTicketStore({ stateFile, secret, now: clock.now, ttlMs })
  return { dir, stateFile, store, clock }
}

function assertPairError(fn, code) {
  assert.throws(fn, error => {
    assert.equal(error?.name, 'PairError', `expected a PairError, got ${error?.name}: ${error?.message}`)
    assert.equal(error?.code, code)
    return true
  })
}

test('issue returns a 43-character base64url ticket that expires after the injected ttl', async t => {
  const { store, clock } = await setup(t)

  const issued = store.issue({ name: 'phone' })

  assert.match(issued.ticket, TICKET_PATTERN)
  assert.equal(Buffer.from(issued.ticket, 'base64url').length, 32)
  assert.equal(issued.expiresAt, clock.now() + TTL_MS)
  assert.deepEqual(Object.keys(issued).sort(), ['expiresAt', 'ticket'])
})

test('issue replaces the previous live ticket', async t => {
  const { store } = await setup(t)

  const first = store.issue({ name: 'phone' })
  const second = store.issue({ name: 'phone' })

  assert.notEqual(first.ticket, second.ticket)
  assertPairError(() => store.claim(first.ticket, { name: 'phone' }), 'ticket-invalid')

  const claimed = store.claim(second.ticket, { name: 'phone' })
  assert.match(claimed.token, TICKET_PATTERN)
})

test('claim returns a device token once and burns the ticket', async t => {
  const { store, clock } = await setup(t)
  const issued = store.issue({ name: 'phone' })

  const claim = store.claim(issued.ticket, { name: 'phone' })

  assert.equal(typeof claim.deviceId, 'string')
  assert.ok(claim.deviceId.length > 0)
  assert.match(claim.token, TICKET_PATTERN)
  assert.equal(Buffer.from(claim.token, 'base64url').length, 32)
  assert.notEqual(claim.token, issued.ticket)
  assert.equal(claim.expiresAt, clock.now() + DEVICE_TTL_MS)
  assert.deepEqual(Object.keys(claim).sort(), ['deviceId', 'expiresAt', 'token'])

  assertPairError(() => store.claim(issued.ticket, { name: 'phone' }), 'ticket-used')
})

test('claim rejects an expired ticket', async t => {
  const { store, clock } = await setup(t)
  const issued = store.issue({ name: 'phone' })

  clock.advance(TTL_MS + 1)

  assertPairError(() => store.claim(issued.ticket, { name: 'phone' }), 'ticket-expired')
})

test('claim rejects a one-character mutation of a live ticket', async t => {
  const { store } = await setup(t)
  const issued = store.issue({ name: 'phone' })
  const flipLast = issued.ticket.slice(0, -1) + (issued.ticket.endsWith('A') ? 'B' : 'A')
  const flipFirst = (issued.ticket[0] === 'A' ? 'B' : 'A') + issued.ticket.slice(1)

  assert.notEqual(flipLast, issued.ticket)
  assertPairError(() => store.claim(flipLast, { name: 'phone' }), 'ticket-invalid')
  assertPairError(() => store.claim(flipFirst, { name: 'phone' }), 'ticket-invalid')
})

test('claim rejects a ticket that was never issued', async t => {
  const { store } = await setup(t)

  assertPairError(() => store.claim('A'.repeat(43), { name: 'phone' }), 'ticket-invalid')
})

test('verify resolves a live token and returns null for unknown or revoked tokens', async t => {
  const { store } = await setup(t)
  const issued = store.issue({ name: 'phone' })
  const claim = store.claim(issued.ticket, { name: 'phone' })

  assert.deepEqual(store.verify(claim.token), { deviceId: claim.deviceId })
  assert.equal(store.verify('B'.repeat(43)), null)

  assert.equal(store.revoke(claim.deviceId), true)
  assert.equal(store.verify(claim.token), null)
})

test('device tokens expire after 30 days', async t => {
  const { store, clock } = await setup(t)
  const issued = store.issue({ name: 'phone' })
  const claim = store.claim(issued.ticket, { name: 'phone' })

  clock.advance(DEVICE_TTL_MS + 1)

  assert.equal(store.verify(claim.token), null)
})

test('revoke reports whether the device existed', async t => {
  const { store } = await setup(t)
  const issued = store.issue({ name: 'phone' })
  const claim = store.claim(issued.ticket, { name: 'phone' })

  assert.equal(store.revoke('device-that-never-existed'), false)
  assert.equal(store.revoke(claim.deviceId), true)
})

test('listDevices exposes only public device fields', async t => {
  const { store, clock } = await setup(t)
  const issued = store.issue({ name: 'phone' })
  const claim = store.claim(issued.ticket, { name: 'phone' })

  const devices = store.listDevices()

  assert.equal(devices.length, 1)
  assert.deepEqual(Object.keys(devices[0]).sort(), ['createdAt', 'id', 'lastSeenAt', 'name'])
  assert.equal(devices[0].id, claim.deviceId)
  assert.equal(devices[0].name, 'phone')
  assert.equal(devices[0].createdAt, clock.now())
  assert.equal(devices[0].lastSeenAt, clock.now())

  const serialized = JSON.stringify(devices)
  assert.ok(!serialized.includes(claim.token), 'listDevices leaked the raw token')
  assert.ok(!serialized.includes(SECRET), 'listDevices leaked the secret')
})

test('persist writes the state file atomically and a reopened store sees the same devices', async t => {
  const { store, stateFile, clock } = await setup(t)
  const issued = store.issue({ name: 'phone' })
  const claim = store.claim(issued.ticket, { name: 'phone' })

  await store.persist()

  const entries = await readdir(join(stateFile, '..'))
  assert.deepEqual(entries.sort(), ['devices.json'], 'persist left a temporary file behind or wrote another file')

  const reopened = createTicketStore({
    stateFile,
    secret: SECRET,
    now: clock.now,
    ttlMs: TTL_MS,
  })

  assert.deepEqual(reopened.verify(claim.token), { deviceId: claim.deviceId })
  const devices = reopened.listDevices()
  assert.equal(devices.length, 1)
  assert.equal(devices[0].id, claim.deviceId)
  assert.equal(devices[0].name, 'phone')
  assert.equal(devices[0].createdAt, claim.expiresAt - DEVICE_TTL_MS)
})

test('the persisted state file never contains a raw token, a raw ticket, or the secret', async t => {
  const { store, stateFile } = await setup(t)
  const issued = store.issue({ name: 'phone' })
  const claim = store.claim(issued.ticket, { name: 'phone' })

  await store.persist()
  const persisted = await readFile(stateFile, 'utf8')

  assert.doesNotThrow(() => JSON.parse(persisted), 'state file is not valid JSON')
  assert.ok(!persisted.includes(claim.token), 'state file contains the raw device token')
  assert.ok(!persisted.includes(issued.ticket), 'state file contains the raw pairing ticket')
  assert.ok(!persisted.includes(SECRET), 'state file contains the HMAC secret')
  assert.ok(persisted.includes('phone'), 'state file does not contain the device record at all')
})

test('a revoked device stays revoked across a reload', async t => {
  const { store, stateFile, clock } = await setup(t)
  const issued = store.issue({ name: 'phone' })
  const claim = store.claim(issued.ticket, { name: 'phone' })

  assert.equal(store.revoke(claim.deviceId), true)
  await store.persist()

  const reopened = createTicketStore({
    stateFile,
    secret: SECRET,
    now: clock.now,
    ttlMs: TTL_MS,
  })

  assert.equal(reopened.verify(claim.token), null)
})

test('a fresh store works before the state file exists and creates it on persist', async t => {
  const { store, stateFile } = await setup(t)

  const issued = store.issue({ name: 'phone' })
  assert.match(issued.ticket, TICKET_PATTERN)
  assert.equal(store.listDevices().length, 0)

  await store.persist()

  const persisted = await readFile(stateFile, 'utf8')
  assert.doesNotThrow(() => JSON.parse(persisted))
})
