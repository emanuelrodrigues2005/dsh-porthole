/**
 * Cloudflare quick-tunnel child-process manager.
 *
 * The manager is fully injectable (spawn, clock, timers) so the contract tests
 * run offline. Nothing here logs; error messages never include a tunnel URL's
 * query string because quick-tunnel URLs carry none.
 */
import { spawn as nodeSpawn } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 64 * 1024
const QUICK_TUNNEL_URL = /https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.trycloudflare\.com(?![A-Za-z0-9.:@-])/g

/**
 * Extracts the first `https://<label>.trycloudflare.com` URL from process output.
 * Rejects plain HTTP, partial hosts, the apex domain, ports and lookalikes.
 * @param {string} output - combined stdout/stderr text.
 * @returns {string|null} the URL without decoration, or null.
 */
export function parseTunnelUrl(output) {
  if (typeof output !== 'string' || output.length === 0) return null
  QUICK_TUNNEL_URL.lastIndex = 0
  const match = QUICK_TUNNEL_URL.exec(output)
  if (match === null) return null
  return `https://${match[1]}.trycloudflare.com`
}

/**
 * Kills a cloudflared process and its children. Windows uses `taskkill /T`,
 * POSIX sends SIGTERM then SIGKILL. Failures are swallowed: the caller only
 * needs the tunnel to go away, and the process may already be gone.
 * @param {import('node:child_process').ChildProcess} child
 */
export function killProcessTree(child) {
  if (child === null || typeof child !== 'object') return
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    try {
      const killer = nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false,
      })
      const fallback = () => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }
      killer.on('error', fallback)
      killer.on('exit', code => {
        if (code !== 0) fallback()
      })
      killer.unref?.()
    } catch {
      /* the process may already be gone */
    }
    return
  }
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }, 5_000)
  timer.unref?.()
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').slice(0, 300)
}

/**
 * Creates the tunnel manager.
 * @param {object} options
 * @param {Function} [options.spawn] - child_process.spawn-compatible function.
 * @param {string} options.cloudflaredPath - resolved cloudflared executable.
 * @param {number} options.gatePort - gate listener port to expose.
 * @param {string} [options.stateDir] - accepted for future logs/state; unused.
 * @param {Function} [options.setTimeout] - injectable timer.
 * @param {Function} [options.clearTimeout] - injectable timer canceller.
 * @param {number} [options.timeoutMs] - URL discovery timeout.
 * @param {Function} [options.killTree] - overrides the child killer.
 */
export function createTunnelManager(options = {}) {
  const spawn = typeof options.spawn === 'function' ? options.spawn : nodeSpawn
  const { cloudflaredPath, gatePort } = options
  if (typeof cloudflaredPath !== 'string' || cloudflaredPath.length === 0) {
    throw new Error('pair tunnel: cloudflaredPath is required')
  }
  if (!Number.isInteger(gatePort) || gatePort < 0 || gatePort > 65535) {
    throw new Error('pair tunnel: gatePort must be an integer port')
  }
  const setTimeoutFn = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout
  const clearTimeoutFn = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS
  // With a caller-injected spawn, process creation belongs to the caller:
  // fall back to `child.kill()` rather than spawning a hidden taskkill.
  const killTree = typeof options.killTree === 'function'
    ? options.killTree
    : spawn === nodeSpawn
      ? killProcessTree
      : null

  let state = 'off'
  let url = null
  let message = null
  let child = null
  let timeoutHandle = null
  let output = ''

  function currentStatus() {
    if (state === 'error') return { state, url: null, message }
    return { state, url }
  }

  function clearTimer() {
    if (timeoutHandle === null) return
    clearTimeoutFn(timeoutHandle)
    timeoutHandle = null
  }

  function killChild(proc) {
    if (proc === null || proc === undefined) return
    try {
      if (killTree !== null) killTree(proc)
      else if (!proc.killed) proc.kill()
    } catch {
      /* the process may already be gone */
    }
  }

  function fail(reason, proc) {
    if (state === 'error' || state === 'off') return
    state = 'error'
    url = null
    message = reason
    clearTimer()
    if (child === proc) child = null
  }

  function handleOutput(chunk) {
    if (state !== 'starting' || chunk.length === 0) return
    output = (output + chunk).slice(-MAX_OUTPUT_BYTES)
    const found = parseTunnelUrl(output)
    if (found === null) return
    state = 'ready'
    url = found
    message = null
    output = ''
    clearTimer()
  }

  /**
   * Spawns cloudflared and resolves once the child exists (state `starting`).
   * Readiness is observed through {@link status}; the URL timeout starts here.
   */
  async function start() {
    if (state === 'starting' || state === 'ready') return currentStatus()
    state = 'starting'
    url = null
    message = null
    output = ''
    child = null
    clearTimer()

    let proc
    try {
      proc = spawn(cloudflaredPath, ['tunnel', '--url', `http://127.0.0.1:${String(gatePort)}`, '--no-autoupdate'], {
        windowsHide: true,
        stdio: 'pipe',
        shell: false,
      })
    } catch (error) {
      state = 'error'
      message = `Cloudflare tunnel could not start: ${errorMessage(error)}`
      return currentStatus()
    }
    child = proc

    const onData = stream => chunk => {
      if (child !== proc) return
      handleOutput(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    }
    proc.stdout?.on?.('data', onData('stdout'))
    proc.stderr?.on?.('data', onData('stderr'))
    proc.on?.('error', error => {
      if (child !== proc) return
      fail(`Cloudflare tunnel failed: ${errorMessage(error)}`, proc)
      child = null
    })
    proc.on?.('exit', code => {
      if (child !== proc) return
      if (state === 'ready') {
        fail(`Cloudflare tunnel exited (exit code ${String(code ?? 'unknown')})`, proc)
      } else if (state === 'starting') {
        fail(`Cloudflare tunnel exited with code ${String(code ?? 'unknown')} before it was ready`, proc)
      }
      child = null
    })

    timeoutHandle = setTimeoutFn(() => {
      timeoutHandle = null
      if (state !== 'starting' || child !== proc) return
      fail(`Cloudflare tunnel start timed out after ${String(Math.round(timeoutMs / 1000))} seconds`, proc)
      killChild(proc)
    }, timeoutMs)
    timeoutHandle?.unref?.()

    return currentStatus()
  }

  /** Kills the child (and its tree) and returns to `off`; idempotent. */
  async function stop() {
    const proc = child
    child = null
    clearTimer()
    output = ''
    state = 'off'
    url = null
    message = null
    if (proc !== null) killChild(proc)
  }

  return { start, stop, status: currentStatus }
}

export default createTunnelManager
