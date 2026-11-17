/**
 * cloudflared binary resolution.
 *
 * Order (first wins):
 *   1. `config.cloudflaredPath` — must exist and be a file;
 *   2. `$DSH_HOME/pair/cloudflared.exe` (the plugin's managed binary);
 *   3. a **pinned and hash-verified** download of Cloudflare's official Windows
 *      amd64 release. `PATH` is deliberately never consulted: the tunnel binary
 *      is executed with the user's privilege, so a planted `cloudflared.exe` on
 *      a writable `PATH` entry must not be able to hijack it.
 *
 * A download is streamed to `<target>.part` while its SHA-256 is computed and a
 * size cap is enforced, moved to a temporary `.exe` only after the digest
 * matches, checked with `--version`, and only then renamed to the managed path.
 * Any failure removes the temporary files, so a half-written or unexpected
 * binary is never executed.
 */
import { spawnSync as nodeSpawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { chmod, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Pinned release: update these three values together, never one alone. */
export const PINNED_VERSION = '2026.11.0'
export const PINNED_SHA256 = 'd5c1d82031da6253dcdcff64c944cd0fe063016edeb2e4fd088075fc9bd52d0a'
export const PINNED_BYTES = 55_397_592
/** Hard cap: a response larger than this is refused while streaming. */
const MAX_DOWNLOAD_BYTES = PINNED_BYTES + 1_048_576

export const DOWNLOAD_URL =
  `https://github.com/cloudflare/cloudflared/releases/download/${PINNED_VERSION}/cloudflared-windows-amd64.exe`

const VERSION_PATTERN = /\b\d+\.\d+\.\d+\b/

function executableName(platform) {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function versionOf(output) {
  const match = VERSION_PATTERN.exec(String(output))
  return match === null ? null : match[0]
}

/**
 * Runs `cloudflared --version` and returns the parsed version.
 * @param {string} binary - executable path.
 * @param {Function} [spawnSyncImpl] - injectable child_process.spawnSync.
 * @returns {{version: string, binary: string}}
 */
export function inspectCloudflared(binary, spawnSyncImpl = nodeSpawnSync) {
  let result
  try {
    result = spawnSyncImpl(binary, ['--version'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20_000,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw new Error(`cloudflared could not be executed at ${binary}: ${error.message}`)
  }
  if (result?.error !== undefined && result.error !== null) {
    throw new Error(`cloudflared could not be executed at ${binary}: ${result.error.message}`)
  }
  if (result?.status !== 0) {
    const detail = String(result?.stderr ?? result?.stdout ?? '').trim().split(/\r?\n/u)[0] ?? ''
    throw new Error(
      `cloudflared at ${binary} did not run successfully (exit code ${String(result?.status ?? 'unknown')})${detail.length > 0 ? `: ${detail.slice(0, 200)}` : ''}`,
    )
  }
  const output = `${String(result?.stdout ?? '')}\n${String(result?.stderr ?? '')}`
  const version = versionOf(output)
  if (version === null) {
    throw new Error(`cloudflared at ${binary} did not print a version to stdout or stderr`)
  }
  return { version, binary }
}

/** A size-capped, hashing pass-through that aborts on an oversized body. */
function verifiedSink() {
  const hash = createHash('sha256')
  let bytes = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length
      if (bytes > MAX_DOWNLOAD_BYTES) {
        callback(new Error(`the download exceeded the ${String(MAX_DOWNLOAD_BYTES)} byte cap`))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  return {
    meter,
    digest: () => ({ sha256: hash.digest('hex'), bytes }),
  }
}

/** Hashes an existing file so a managed copy is verified before it is executed. */
async function hashFile(file) {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length
    if (bytes > MAX_DOWNLOAD_BYTES) return { sha256: '', bytes }
    hash.update(chunk)
  }
  return { sha256: hash.digest('hex'), bytes }
}

/**
 * Downloads and verifies cloudflared into the managed state directory.
 * @param {object} options
 * @param {string} options.stateDir - plugin state directory (holds the binary).
 * @param {string} [options.platform] - process.platform override.
 * @param {Function} [options.fetchImpl] - injectable global fetch.
 * @param {Function} [options.spawnSyncImpl] - injectable child_process.spawnSync.
 * @returns {Promise<string>} the managed binary path.
 */
export async function downloadCloudflared(options = {}) {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    throw new Error(
      'cloudflared is missing and this build downloads only the Windows amd64 binary; set dsh.bundle config cloudflaredPath to a local cloudflared executable',
    )
  }
  const stateDir = options.stateDir
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    throw new Error('pair cloudflared: stateDir is required to download cloudflared')
  }
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      `cloudflared is missing and global fetch is unavailable; install cloudflared and set config.cloudflaredPath, or download ${DOWNLOAD_URL} manually and check sha256 ${PINNED_SHA256}`,
    )
  }

  const target = join(stateDir, executableName(platform))
  const part = `${target}.part`
  const verifyPath = `${target}.verify-${String(process.pid)}-${String(Date.now())}.exe`
  mkdirSync(stateDir, { recursive: true })

  try {
    const response = await fetchImpl(DOWNLOAD_URL, { redirect: 'follow' })
    if (response === null || typeof response !== 'object' || !response.ok) {
      throw new Error(`the server answered HTTP ${String(response?.status ?? 'unknown')}`)
    }
    if (response.body === null || response.body === undefined) {
      throw new Error('the response had no body')
    }
    const sink = verifiedSink()
    await pipeline(Readable.fromWeb(response.body), sink.meter, createWriteStream(part, { mode: 0o700 }))
    const { sha256, bytes } = sink.digest()
    if (bytes !== PINNED_BYTES || sha256 !== PINNED_SHA256) {
      throw new Error(
        `integrity check failed for cloudflared ${PINNED_VERSION}: got ${String(bytes)} bytes sha256 ${sha256}, expected ${String(PINNED_BYTES)} bytes sha256 ${PINNED_SHA256}`,
      )
    }
    await rename(part, verifyPath)
    const inspected = inspectCloudflared(verifyPath, options.spawnSyncImpl)
    if (inspected.version !== PINNED_VERSION) {
      throw new Error(
        `the downloaded cloudflared reports version ${inspected.version}, expected ${PINNED_VERSION}`,
      )
    }
    if (platform !== 'win32') await chmod(verifyPath, 0o755).catch(() => {})
    await rename(verifyPath, target)
    return target
  } catch (error) {
    await rm(part, { force: true }).catch(() => {})
    await rm(verifyPath, { force: true }).catch(() => {})
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `cloudflared download failed (${detail}). Install cloudflared yourself and set config.cloudflaredPath, or download ${DOWNLOAD_URL} manually and verify sha256 ${PINNED_SHA256}.`,
    )
  }
}

/**
 * Resolves a usable cloudflared binary, downloading it only as a last resort.
 * @param {object} options
 * @param {string} [options.cloudflaredPath] - configured explicit binary.
 * @param {string} options.stateDir - managed state directory.
 * @param {string} [options.platform] - process.platform override.
 * @param {object} [options.env] - environment override.
 * @param {Function} [options.fetchImpl] - injectable fetch.
 * @param {Function} [options.spawnSyncImpl] - injectable spawnSync.
 * @returns {Promise<string>}
 */
export async function resolveCloudflared(options = {}) {
  const { cloudflaredPath } = options
  const platform = options.platform ?? process.platform
  const stateDir = options.stateDir
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    throw new Error('pair cloudflared: stateDir is required')
  }
  if (typeof cloudflaredPath === 'string' && cloudflaredPath.trim().length > 0) {
    const explicit = cloudflaredPath.trim()
    if (!existsSync(explicit) || !isFile(explicit)) {
      throw new Error(
        `config.cloudflaredPath points to ${explicit}, which does not exist or is not a file`,
      )
    }
    return explicit
  }
  const managed = join(stateDir, executableName(platform))
  if (isFile(managed)) {
    // Never execute a pre-planted file: the managed copy is trusted only when it
    // matches the pinned digest and size, exactly like a fresh download.
    const digest = await hashFile(managed)
    if (digest.bytes === PINNED_BYTES && digest.sha256 === PINNED_SHA256) {
      const inspected = inspectCloudflared(managed, options.spawnSyncImpl)
      if (inspected.version === PINNED_VERSION) return inspected.binary
    }
    await rm(managed, { force: true }).catch(() => {})
  }

  return downloadCloudflared({
    stateDir,
    platform,
    fetchImpl: options.fetchImpl,
    spawnSyncImpl: options.spawnSyncImpl,
  })
}

export default resolveCloudflared
