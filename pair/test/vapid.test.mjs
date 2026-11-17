/**
 * Contract tests for pair/host/vapid.js — the persisted P-256 keypair and the
 * ES256 JWT that authenticates a Web Push POST (S2).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { verify } from 'node:crypto'

import { createVapid, createVapidAuth, publicKeyObject, verifyVapidJwt } from '../host/vapid.js'
import { createClock, makeTempDir, removeTempDir, MINUTE_MS } from './helpers.mjs'

const ENDPOINT = 'https://fcm.googleapis.com/wp/abc123'
const BASE64URL = /^[A-Za-z0-9_-]+$/u
const HOUR_MS = 60 * MINUTE_MS

async function setup(t) {
  const dir = await makeTempDir()
  t.after(async () => {
    await removeTempDir(dir).catch(() => {})
  })
  const clock = createClock()
  const stateFile = join(dir, 'vapid.json')
  return { dir, clock, stateFile }
}

test('the first use generates a 65-byte uncompressed P-256 point and persists it', async t => {
  const { stateFile, clock, dir } = await setup(t)

  const vapid = createVapid({ stateFile, now: clock.now })

  assert.equal(vapid.regenerated, true, 'the first call has to mint the keypair')
  assert.equal(vapid.loadError, null)
  assert.match(vapid.publicKey, BASE64URL)
  const point = Buffer.from(vapid.publicKey, 'base64url')
  assert.equal(point.length, 65, 'an uncompressed P-256 point is 65 bytes')
  assert.equal(point[0], 0x04, 'the point must start with the uncompressed marker')
  assert.equal(Buffer.from(vapid.privateKey, 'base64url').length, 32, 'the private scalar is 32 bytes')
  assert.equal(vapid.createdAt, clock.now())

  const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(parsed.version, 1)
  assert.equal(parsed.publicKey, vapid.publicKey)
  assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.tmp')), [], 'the atomic rename cleans up after itself')
  // The persisted file is the private key: never world readable.
  if (process.platform !== 'win32') {
    const { statSync } = await import('node:fs')
    assert.equal(statSync(stateFile).mode & 0o777, 0o600)
  }
})

test('a reload reuses the persisted keypair instead of minting a new one', async t => {
  const { stateFile } = await setup(t)

  const first = createVapid({ stateFile })
  const second = createVapid({ stateFile })

  assert.equal(second.regenerated, false)
  assert.equal(second.publicKey, first.publicKey)
  assert.equal(second.privateKey, first.privateKey)
  assert.equal(second.createdAt, first.createdAt)
})

test('a corrupt key file is replaced with a fresh keypair', async t => {
  const { stateFile } = await setup(t)
  writeFileSync(stateFile, '{"version":1,"publicKey":"not-a-point","privateKey":"x"}', 'utf8')

  const vapid = createVapid({ stateFile })

  assert.equal(vapid.regenerated, true)
  assert.ok(typeof vapid.loadError === 'string' && vapid.loadError.length > 0, 'the corruption must be reported')
  assert.equal(Buffer.from(vapid.publicKey, 'base64url').length, 65)
  assert.equal(createVapid({ stateFile }).publicKey, vapid.publicKey, 'the fresh keypair is persisted')
})

test('the JWT carries typ/alg, the endpoint origin as aud and an exp at most 24 hours out', async t => {
  const { stateFile, clock } = await setup(t)
  const vapid = createVapid({ stateFile, now: clock.now })

  const auth = vapid.authorization(ENDPOINT)
  const [encodedHeader, encodedClaims, encodedSignature] = auth.jwt.split('.')

  assert.equal(auth.jwt.split('.').length, 3, 'a JWS has three segments')
  const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'))
  assert.deepEqual(header, { typ: 'JWT', alg: 'ES256' })
  const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'))
  assert.equal(claims.aud, 'https://fcm.googleapis.com', 'aud is the endpoint origin, never the full URL')
  assert.equal(claims.sub, 'mailto:dsh-pair@localhost')
  const nowSeconds = Math.floor(clock.now() / 1000)
  assert.ok(claims.exp > nowSeconds, 'the token must not already be expired')
  assert.ok(claims.exp - nowSeconds <= 24 * 3600, 'exp must never exceed 24 hours')
  assert.equal(encodedSignature.length, 86, 'an ES256 signature is 64 bytes / 86 base64url characters')

  // Even a caller asking for a week is capped at the RFC ceiling.
  const capped = createVapidAuth({
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
    endpoint: ENDPOINT,
    now: clock.now,
    lifetimeMs: 7 * 24 * HOUR_MS,
  })
  assert.ok(capped.claims.exp - nowSeconds <= 24 * 3600)
})

test('the ES256 signature verifies with the published key and fails when tampered', async t => {
  const { stateFile, clock } = await setup(t)
  const vapid = createVapid({ stateFile, now: clock.now })

  const auth = vapid.authorization(ENDPOINT)
  assert.equal(verifyVapidJwt(auth.jwt, vapid.publicKey), true)
  assert.equal(auth.authorization, `vapid t=${auth.jwt}, k=${vapid.publicKey}`)
  assert.equal(auth.ttl, '600')

  // A hand-rolled check, so the test does not trust the module's own helper.
  const [header, claims, signature] = auth.jwt.split('.')
  const verified = verify(
    'sha256',
    Buffer.from(`${header}.${claims}`, 'utf8'),
    { key: publicKeyObject(vapid.publicKey), dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  )
  assert.equal(verified, true)

  const tamperedClaims = Buffer.from(
    JSON.stringify({ ...JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')), sub: 'mailto:evil@example.com' }),
  ).toString('base64url')
  assert.equal(verifyVapidJwt(`${header}.${tamperedClaims}.${signature}`, vapid.publicKey), false)
})

test('a non-https endpoint is refused before any token is minted', async t => {
  const { stateFile } = await setup(t)
  const vapid = createVapid({ stateFile })

  assert.throws(() => vapid.authorization('http://fcm.googleapis.com/wp/abc'), /must be https/)
  assert.throws(() => vapid.authorization('not a url'), /not a valid URL/)
})
