/**
 * Contract tests for pair/host/cloudflared.js.
 *
 * The resolver never trusts PATH and never executes an unverified download.
 * The network, the child process and the filesystem are all injected, so these
 * tests are offline and deterministic. The oversized-response test streams real
 * bytes only because the cap is measured on the wire.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { ReadableStream } from 'node:stream/web'

import {
  DOWNLOAD_URL,
  PINNED_BYTES,
  PINNED_SHA256,
  PINNED_VERSION,
  resolveCloudflared,
} from '../host/cloudflared.js'
import { makeTempDir, removeTempDir } from './helpers.mjs'

const PINNED_URL = 'https://github.com/cloudflare/cloudflared/releases/download/2026.11.0/cloudflared-windows-amd64.exe'

test('the managed download is pinned to cloudflared 2026.11.0', () => {
  assert.equal(PINNED_VERSION, '2026.11.0')
  assert.equal(DOWNLOAD_URL, PINNED_URL, 'the download URL must follow PINNED_VERSION, not a moving "latest"')
  assert.match(PINNED_SHA256, /^[0-9a-f]{64}$/)
  assert.equal(PINNED_BYTES, 55_397_592)
})

test('a download whose bytes do not match the pinned digest is rejected before execution and leaves no file', async t => {
  const stateDir = await makeTempDir()
  t.after(() => removeTempDir(stateDir))

  const spawned = []
  const fetchImpl = async url => {
    assert.equal(url, PINNED_URL)
    return new Response(Buffer.from('not the pinned cloudflared binary'), { status: 200 })
  }
  const spawnSyncImpl = (...args) => {
    spawned.push(args)
    return { status: 0, stdout: 'cloudflared version 2026.11.0', stderr: '' }
  }

  await assert.rejects(
    resolveCloudflared({ stateDir, platform: 'win32', fetchImpl, spawnSyncImpl }),
    /integrity check failed/,
  )

  assert.deepEqual(spawned, [], 'an unverified download must never be executed')
  assert.deepEqual(await readdir(stateDir), [], 'a rejected download must leave no file behind')
})

test('an oversized download aborts the transfer and leaves no file', async t => {
  const stateDir = await makeTempDir()
  t.after(() => removeTempDir(stateDir))

  const chunk = Buffer.alloc(1024 * 1024, 0x61)
  let produced = 0
  const body = new ReadableStream({
    pull(controller) {
      if (produced >= 58) {
        controller.close()
        return
      }
      produced += 1
      controller.enqueue(chunk)
    },
  })
  const fetchImpl = async () => ({ ok: true, status: 200, body })
  const spawnSyncImpl = () => {
    throw new Error('an oversized download must never be executed')
  }

  await assert.rejects(
    resolveCloudflared({ stateDir, platform: 'win32', fetchImpl, spawnSyncImpl }),
    /exceeded|cap|too large/i,
  )
  assert.ok(produced >= 54, 'the stream must have crossed the pinned size cap')
  assert.ok(produced < 58, 'the download stream must be aborted, not fully consumed')
  assert.deepEqual(await readdir(stateDir), [], 'an aborted download must leave no file behind')
})

test('resolveCloudflared never consults PATH', async t => {
  const stateDir = await makeTempDir()
  const pathDir = await makeTempDir()
  t.after(async () => {
    await removeTempDir(stateDir)
    await removeTempDir(pathDir)
  })

  const planted = join(pathDir, 'cloudflared.exe')
  await writeFile(planted, 'planted-by-an-attacker', 'utf8')
  const originalPath = process.env.PATH
  process.env.PATH = `${pathDir}${delimiter}${originalPath ?? ''}`
  let fetchCalls = 0
  try {
    await assert.rejects(
      resolveCloudflared({
        stateDir,
        platform: 'win32',
        env: { PATH: pathDir },
        fetchImpl: async () => {
          fetchCalls += 1
          return new Response(Buffer.from('wrong bytes'), { status: 200 })
        },
        spawnSyncImpl: () => {
          throw new Error('a PATH binary must never be executed')
        },
      }),
      'the resolver must ignore a planted PATH binary and use the pinned download',
    )
  } finally {
    process.env.PATH = originalPath
  }
  assert.equal(fetchCalls, 1, 'the resolver must fall through to the pinned download instead of PATH')
})

test('an explicit cloudflaredPath that does not exist fails loudly', async t => {
  const stateDir = await makeTempDir()
  t.after(() => removeTempDir(stateDir))
  const missing = join(stateDir, 'missing-cloudflared.exe')

  await assert.rejects(
    resolveCloudflared({ stateDir, platform: 'win32', cloudflaredPath: missing }),
    /does not exist or is not a file/,
  )
})

test('a pre-planted managed binary that does not match the pin is never executed and is removed', async t => {
  const stateDir = await makeTempDir()
  t.after(() => removeTempDir(stateDir))
  const planted = join(stateDir, 'cloudflared.exe')
  await writeFile(planted, 'planted-managed-binary', 'utf8')

  const spawned = []
  await assert.rejects(
    resolveCloudflared({
      stateDir,
      platform: 'win32',
      fetchImpl: async () => new Response(Buffer.from('still wrong bytes'), { status: 200 }),
      spawnSyncImpl: (...args) => {
        spawned.push(args)
        return { status: 0, stdout: 'cloudflared version 2026.11.0', stderr: '' }
      },
    }),
    /integrity check failed/,
  )

  assert.deepEqual(spawned, [], 'a managed binary that fails the pin must never be executed')
  assert.deepEqual(await readdir(stateDir), [], 'the unverified managed copy must be removed')
})

test('an explicit existing cloudflaredPath is returned without downloading', async t => {
  const stateDir = await makeTempDir()
  t.after(() => removeTempDir(stateDir))
  const explicit = join(stateDir, 'custom-cloudflared.exe')
  await writeFile(explicit, 'explicit-binary', 'utf8')

  let fetchCalls = 0
  const resolved = await resolveCloudflared({
    stateDir,
    platform: 'win32',
    cloudflaredPath: explicit,
    fetchImpl: async () => {
      fetchCalls += 1
      return new Response(Buffer.from('wrong bytes'), { status: 200 })
    },
  })

  assert.equal(resolved, explicit)
  assert.equal(fetchCalls, 0)
})
