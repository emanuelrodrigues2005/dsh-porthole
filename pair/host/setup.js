/**
 * Tailscale setup: detection, the guided configuration and the one config file
 * the operator (or their agent) may write.
 *
 * The panel, the operator routes and the `pair_setup_*` tools all read the same
 * object produced by `status()`, so the UI never re-implements a rule and an
 * agent never has to guess what "needs" means.
 *
 * What this module may execute is fixed and closed:
 *   tailscale version | status --json | funnel status | funnel --bg <port>
 * plus the existing cloudflared *resolver* (never its download). No argv is ever
 * assembled from a request body or a model argument: `<port>` is an integer and
 * every other argument is a literal in this file.
 *
 * Configuration precedence, lowest to highest:
 *   1. the bundle row config (cordis.patch.yml / profile patch);
 *   2. `$DSH_HOME/pair/config.json` (this module's override file);
 *   3. `DSH_PAIR_*` environment variables, which the bundle patch evaluates into
 *      the row config, so they land at layer 1.
 * The pair service merges 2 over 1 at construction and again on every restart,
 * which is why `apply()` can change the gate port or the public URL without a
 * harness restart.
 */
import { execFile as nodeExecFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'

import { resolveCloudflared } from './cloudflared.js'

/** The override file lives next to the rest of the plugin state. */
export const CONFIG_FILE_NAME = 'config.json'
/** Shape of `config.json`; bump only with a migration. */
export const CONFIG_FILE_VERSION = 1
/** Every `tailscale` probe is fast or it is a failure. */
export const COMMAND_TIMEOUT_MS = 5_000
/** `tailscale funnel --bg` may have to talk to the coordination server. */
export const FUNNEL_TIMEOUT_MS = 15_000
/** A command output shown in the panel is bounded. */
export const MAX_OUTPUT_CHARS = 2_000
/** Funnel targets one fixed loopback port; 0 (ask the OS) cannot be mapped. */
export const DEFAULT_PUBLIC_GATE_PORT = 8791
/** The only keys `config.json` and `POST /pair/api/setup/apply` accept. */
export const PATCH_KEYS = Object.freeze(['publicUrl', 'gatePort', 'autoStart'])

export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download'

/** The ACL block that lets your tailnet use Funnel. Byte-exact on purpose. */
export const FUNNEL_POLICY_JSON = '{"nodeAttrs":[{"target":["autogroup:member"],"attr":["funnel"]}]}'

/**
 * The same `nodeAttrs` block merged into the default ACL sample, so an operator
 * who already has `grants` can paste one document instead of hand-editing.
 */
export const FUNNEL_ACL_JSON = [
  '{',
  '  "grants": [',
  '    {',
  '      "src": "autogroup:member",',
  '      "dst": "autogroup:member",',
  '      "ip": ["*"]',
  '    }',
  '  ],',
  '  "nodeAttrs": [',
  '    {',
  '      "target": ["autogroup:member"],',
  '      "attr": ["funnel"]',
  '    }',
  '  ]',
  '}',
  '',
].join('\n')

/** Documentation entry points the panel links to (all open in a new tab). */
export const SETUP_DOCS = Object.freeze({
  setupUrl: TAILSCALE_DOWNLOAD_URL,
  adminDnsUrl: 'https://login.tailscale.com/admin/dns',
  adminAclUrl: 'https://login.tailscale.com/admin/acls/file',
  funnelDocsUrl: 'https://tailscale.com/kb/1223/funnel',
})

/**
 * Where the `tailscale` CLI may live, in probe order. The bare name first so a
 * normal PATH install wins; the absolute paths cover the Windows installer and
 * the two macOS layouts (Homebrew and the App Store bundle).
 */
export const TAILSCALE_CANDIDATES = Object.freeze([
  'tailscale',
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
])

const VERSION_PATTERN = /(\d+\.\d+\.\d+)/u

const INSTALL_GUIDANCE = {
  win32: {
    id: 'windows',
    label: 'Windows',
    install: [
      { label: 'winget', command: 'winget install --id Tailscale.Tailscale -e', url: TAILSCALE_DOWNLOAD_URL },
      { label: 'Installer', command: '', url: TAILSCALE_DOWNLOAD_URL },
    ],
  },
  darwin: {
    id: 'macos',
    label: 'macOS',
    install: [
      { label: 'Homebrew', command: 'brew install --cask tailscale', url: TAILSCALE_DOWNLOAD_URL },
      { label: 'Mac App Store', command: '', url: 'https://apps.apple.com/app/tailscale/id1475387142' },
    ],
  },
  linux: {
    id: 'linux',
    label: 'Linux',
    install: [
      { label: 'Install script', command: 'curl -fsSL https://tailscale.com/install.sh | sh', url: TAILSCALE_DOWNLOAD_URL },
    ],
  },
}

/** The per-OS install card. Unknown platforms get the portable script. */
export function installGuidance(platform) {
  const key = typeof platform === 'string' ? platform : ''
  const known = INSTALL_GUIDANCE[key]
  if (known !== undefined) return { ...known, install: known.install.map(entry => ({ ...entry })) }
  return {
    id: 'unknown',
    label: key.length > 0 ? key : 'your OS',
    install: [
      { label: 'Install script', command: 'curl -fsSL https://tailscale.com/install.sh | sh', url: TAILSCALE_DOWNLOAD_URL },
      { label: 'Downloads', command: '', url: TAILSCALE_DOWNLOAD_URL },
    ],
  }
}

/**
 * Validates a `publicUrl`: a bare `https://` origin, or `''` when the key is
 * absent (quick-tunnel mode). A trailing slash is normalized away; any other
 * scheme, or a path/query/fragment, is rejected so the value can be published
 * verbatim as `status().url` and used as the `/pair/<ticket>` prefix.
 * @param {unknown} value
 * @returns {string} normalized origin, or `''` for quick-tunnel mode.
 */
export function normalizePublicUrl(value) {
  const problem =
    'pair: publicUrl must be a bare https origin such as https://machine.tailnet.ts.net (no path, query or fragment)'
  if (typeof value !== 'string') throw new Error(problem)
  const text = value.trim()
  if (text.length === 0 || !text.startsWith('https://')) throw new Error(problem)
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new Error(problem)
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname.length === 0 ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(problem)
  }
  return parsed.origin
}

/** An error the routes answer with its own status (400 invalid, 409 conflict). */
function setupError(message, status) {
  const error = new Error(message)
  error.status = status
  return error
}

/**
 * Validates the three writable keys. Absent keys stay absent so a patch merges
 * instead of resetting the rest of the file.
 * @param {unknown} input
 * @returns {{publicUrl?: string, gatePort?: number, autoStart?: boolean}}
 */
export function normalizeSetupPatch(input) {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw setupError('the setup patch must be a JSON object', 400)
  }
  for (const key of Object.keys(input)) {
    if (!PATCH_KEYS.includes(key)) {
      throw setupError(
        `unknown setup key ${JSON.stringify(key)}; expected ${PATCH_KEYS.join(', ')}`,
        400,
      )
    }
  }
  const patch = {}
  if (input.publicUrl !== undefined) {
    let normalized
    try {
      normalized = normalizePublicUrl(input.publicUrl)
    } catch (error) {
      throw setupError(error instanceof Error ? error.message : String(error), 400)
    }
    if (normalized === '') throw setupError('publicUrl must be an https origin', 400)
    patch.publicUrl = normalized
  }
  if (input.gatePort !== undefined) {
    if (!Number.isSafeInteger(input.gatePort) || input.gatePort < 1 || input.gatePort > 65535) {
      throw setupError('gatePort must be an integer between 1 and 65535', 400)
    }
    patch.gatePort = input.gatePort
  }
  if (input.autoStart !== undefined) {
    if (typeof input.autoStart !== 'boolean') throw setupError('autoStart must be a boolean', 400)
    patch.autoStart = input.autoStart
  }
  return patch
}

/**
 * Reads the override file. A missing file is an empty override; a corrupt or
 * unsupported one throws so the row is disabled loudly instead of silently
 * pairing with the wrong origin.
 * @param {string} file
 * @returns {{publicUrl?: string, gatePort?: number, autoStart?: boolean}}
 */
export function readConfigOverride(file) {
  if (typeof file !== 'string' || file.length === 0) return {}
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw new Error(`pair setup: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`pair setup: ${file} is not valid JSON; fix or delete it`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`pair setup: ${file} must contain a JSON object; fix or delete it`)
  }
  if (parsed.version !== CONFIG_FILE_VERSION) {
    throw new Error(`pair setup: ${file} has version ${String(parsed.version)}; expected ${String(CONFIG_FILE_VERSION)}. Delete it to fall back to the row config`)
  }
  const { version, ...values } = parsed
  void version
  try {
    return normalizeSetupPatch(values)
  } catch (error) {
    throw new Error(`pair setup: ${file} is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Writes the override atomically (temp file in the same directory, mode 0600,
 * then a rename) so a crash never leaves a half-written origin behind.
 * @param {string} file
 * @param {{publicUrl?: string, gatePort?: number, autoStart?: boolean}} override
 */
export function writeConfigOverride(file, override) {
  const patch = normalizeSetupPatch(override)
  const payload = { version: CONFIG_FILE_VERSION }
  if (patch.publicUrl !== undefined) payload.publicUrl = patch.publicUrl
  if (patch.gatePort !== undefined) payload.gatePort = patch.gatePort
  if (patch.autoStart !== undefined) payload.autoStart = patch.autoStart
  const temporary = `${file}.${String(process.pid)}.${String(Date.now())}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw new Error(`pair setup: cannot write ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return payload
}

/** A `tailscale` command output is bounded and stripped of key material. */
export function redactOutput(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text
    .replace(/tskey-[A-Za-z0-9_-]+/gu, 'tskey-[redacted]')
    .replace(/([?&]token=)[^&\s]*/giu, '$1[redacted]')
    .replace(/(auth[-_]?key\s*[:=]\s*)\S+/giu, '$1[redacted]')
    .replace(/\u0000/gu, '')
    .trim()
    .slice(0, MAX_OUTPUT_CHARS)
}

/** `1.68.1` out of any `tailscale version` flavour. */
export function parseVersion(output) {
  const match = VERSION_PATTERN.exec(String(output ?? ''))
  return match === null ? null : match[1]
}

/**
 * Parses `tailscale status --json`. Never throws: a stopped backend, an empty
 * answer and a truncated answer all degrade to "not running".
 * @param {string} text
 * @returns {{running: boolean, dnsName: string|null, tailscaleIPs: string[]}}
 */
export function parseTailscaleStatus(text) {
  const empty = { running: false, dnsName: null, tailscaleIPs: [] }
  const raw = String(text ?? '').trim()
  if (raw.length === 0 || !raw.startsWith('{')) return empty
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty
  }
  if (parsed === null || typeof parsed !== 'object') return empty
  const self = parsed.Self !== null && typeof parsed.Self === 'object' ? parsed.Self : null
  const dnsName = self !== null && typeof self.DNSName === 'string' && self.DNSName.replace(/\.$/u, '').length > 0
    ? self.DNSName.replace(/\.$/u, '')
    : null
  const tailscaleIPs = self !== null && Array.isArray(self.TailscaleIPs)
    ? self.TailscaleIPs.filter(value => typeof value === 'string').slice(0, 8)
    : []
  return {
    running: parsed.BackendState === 'Running',
    dnsName,
    tailscaleIPs,
  }
}

/**
 * Parses `tailscale funnel status`. The real output looks like:
 *
 *   # Funnel on:
 *   #     - https://machine.tailnet.ts.net
 *   #     - http://100.64.0.1:8791
 *
 *   https://machine.tailnet.ts.net (Funnel on)
 *   |-- / proxy http://127.0.0.1:8791
 *
 * and prints `No funnel is set up.` when it is off.
 * @param {string} text
 * @returns {{on: boolean, url: string|null, targetPort: number|null}}
 */
export function parseFunnelStatus(text) {
  const raw = typeof text === 'string' ? text : String(text ?? '')
  const on = /\bfunnel on\b/iu.test(raw)
  if (!on) return { on: false, url: null, targetPort: null }
  const urlMatch = /https:\/\/[^\s)]+/iu.exec(raw)
  const portMatch = /proxy\s+https?:\/\/[^\s:]+:(\d+)/iu.exec(raw)
  const targetPort = portMatch === null ? null : Number.parseInt(portMatch[1], 10)
  return {
    on: true,
    url: urlMatch === null ? null : urlMatch[0],
    targetPort: Number.isSafeInteger(targetPort) ? targetPort : null,
  }
}

/**
 * The gate port Funnel must forward to. `0` asks the OS, which a Funnel mapping
 * can never follow — in public-URL mode the service therefore uses the
 * documented fixed default.
 * @param {{gatePort?: number, publicUrl?: string}|null} config
 * @returns {number|null}
 */
export function effectiveGatePort(config) {
  if (config === null || typeof config !== 'object') return null
  const port = config.gatePort
  if (Number.isSafeInteger(port) && port > 0 && port <= 65535) return port
  if (typeof config.publicUrl === 'string' && config.publicUrl !== '') return DEFAULT_PUBLIC_GATE_PORT
  return null
}

/**
 * Runs one fixed command. The timeout, `windowsHide` and `shell: false` are the
 * same for every probe: nothing here may open a console window or a shell.
 * @param {Function} execFileImpl - child_process.execFile-compatible.
 * @param {string} binary
 * @param {string[]} args
 * @param {number} timeout
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, error: string|null}>}
 */
function runCommand(execFileImpl, binary, args, timeout) {
  return new Promise(resolve => {
    let settled = false
    const done = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const options = {
      timeout,
      windowsHide: true,
      shell: false,
      encoding: 'utf8',
      maxBuffer: 1_048_576,
    }
    let callback
    try {
      callback = callbackArgs => {
        const { error, stdout, stderr } = callbackArgs
        done({
          ok: error === null || error === undefined,
          code: error === null || error === undefined ? 0 : (Number.isSafeInteger(error?.code) ? error.code : null),
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
          error: error === null || error === undefined ? null : (error instanceof Error ? error.message : String(error)),
        })
      }
      execFileImpl(binary, args, options, (error, stdout, stderr) => callback({ error, stdout, stderr }))
    } catch (error) {
      done({
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

/** Whether a loopback port can be bound right now (used before a restart). */
function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const server = createServer()
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      try {
        server.close()
      } catch {
        /* the probe never listened */
      }
      resolve(value)
    }
    server.once('error', () => finish(false))
    server.once('listening', () => finish(true))
    try {
      server.listen({ port, host, exclusive: true })
    } catch {
      finish(false)
    }
  })
}

/** The `needs` list is ordered the way an operator reads the steps. */
const NEED_ORDER = Object.freeze(['install', 'up', 'https', 'funnel-policy', 'funnel-run', 'apply', 'done'])

function sortNeeds(needs) {
  return [...new Set(needs)].sort((a, b) => NEED_ORDER.indexOf(a) - NEED_ORDER.indexOf(b))
}

/**
 * The state machine behind the stepper. One entry per incomplete step, and
 * `['done']` when nothing is left.
 * @param {{tailscale: object, funnel: object, config: object}} view
 * @returns {string[]}
 */
export function computeNeeds(view) {
  const needs = []
  if (view.tailscale.installed !== true) {
    return ['install']
  }
  if (view.tailscale.running !== true) {
    needs.push('up')
    return sortNeeds(needs)
  }
  if (view.funnel.on !== true) needs.push('https', 'funnel-policy', 'funnel-run')
  else if (view.funnel.matchesGatePort !== true) needs.push('funnel-run')
  const targetUrl = view.funnel.url ?? view.tailscale.suggestedUrl ?? null
  if (targetUrl !== null && view.config.publicUrl !== targetUrl) needs.push('apply')
  return needs.length === 0 ? ['done'] : sortNeeds(needs)
}

/**
 * Creates the setup service the panel, the routes and the tools share.
 *
 * @param {object} options
 * @param {string} options.stateDir - `$DSH_HOME/pair`.
 * @param {() => object} options.getConfig - the pair service's effective config.
 * @param {() => Promise<object>} [options.restart] - pair service stop+start.
 * @param {string} [options.configFile] - override file (defaults to stateDir/config.json).
 * @param {Function} [options.execFile] - child_process.execFile override.
 * @param {Function} [options.resolveBinary] - cloudflared resolver override.
 * @param {Function} [options.spawnSyncImpl] - injected into the resolver.
 * @param {string} [options.platform] - process.platform override.
 * @param {string[]} [options.candidates] - CLI candidates override.
 * @param {() => number} [options.now] - clock (tests).
 */
export function createSetupService(options = {}) {
  const stateDir = options.stateDir
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    throw new Error('pair setup: stateDir is required')
  }
  if (typeof options.getConfig !== 'function') {
    throw new Error('pair setup: getConfig is required')
  }
  const getConfig = options.getConfig
  const restart = typeof options.restart === 'function' ? options.restart : async () => {}
  const configFile = typeof options.configFile === 'string' && options.configFile.length > 0
    ? options.configFile
    : join(stateDir, CONFIG_FILE_NAME)
  const execFileImpl = typeof options.execFile === 'function' ? options.execFile : nodeExecFile
  const resolveBinary = typeof options.resolveBinary === 'function'
    ? options.resolveBinary
    : context => resolveCloudflared(context)
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const candidates = Array.isArray(options.candidates) && options.candidates.length > 0
    ? options.candidates
    : TAILSCALE_CANDIDATES

  function safeConfig() {
    try {
      const current = getConfig()
      return current !== null && typeof current === 'object' ? { ...current } : null
    } catch {
      return null
    }
  }

  /** Runs one probe per candidate until one answers; never throws. */
  async function detectTailscale() {
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate.length === 0) continue
      const version = await runCommand(execFileImpl, candidate, ['version'], COMMAND_TIMEOUT_MS)
      if (!version.ok) continue
      const binary = candidate
      const parsedVersion = parseVersion(`${version.stdout}\n${version.stderr}`)
      const statusResult = await runCommand(execFileImpl, binary, ['status', '--json'], COMMAND_TIMEOUT_MS)
      // `tailscale status` exits non-zero while the backend is stopped, but it
      // still prints the JSON body; parse it whenever it looks like JSON.
      const parsedStatus = parseTailscaleStatus(statusResult.stdout)
      return {
        installed: true,
        version: parsedVersion,
        running: parsedStatus.running,
        dnsName: parsedStatus.dnsName,
        suggestedUrl: parsedStatus.dnsName === null ? null : `https://${parsedStatus.dnsName}`,
        tailscaleIPs: parsedStatus.tailscaleIPs,
        binary,
      }
    }
    return {
      installed: false,
      version: null,
      running: false,
      dnsName: null,
      suggestedUrl: null,
      tailscaleIPs: [],
      binary: null,
    }
  }

  /** `tailscale funnel status`, parsed; false facts when the CLI is missing. */
  async function detectFunnel(binary, config) {
    if (typeof binary !== 'string' || binary.length === 0) {
      return { on: false, url: null, targetPort: null, matchesGatePort: false, raw: '' }
    }
    const result = await runCommand(execFileImpl, binary, ['funnel', 'status'], COMMAND_TIMEOUT_MS)
    const parsed = parseFunnelStatus(`${result.stdout}\n${result.stderr}`)
    const port = effectiveGatePort(config)
    return {
      on: parsed.on,
      url: parsed.url,
      targetPort: parsed.targetPort,
      matchesGatePort: parsed.targetPort !== null && port !== null && parsed.targetPort === port,
      raw: redactOutput(`${result.stdout}\n${result.stderr}`).slice(0, 600),
    }
  }

  /**
   * cloudflared presence. The real resolver is tried first (so a configured or
   * managed binary is reported as verified), but its download path is disabled:
   * a status read must never start a network transfer.
   */
  async function detectCloudflared(config) {
    const noDownload = () => {
      throw new Error('setup detection never downloads')
    }
    const cloudflaredPath = typeof config?.cloudflaredPath === 'string' ? config.cloudflaredPath : ''
    try {
      const binary = await resolveBinary({
        cloudflaredPath,
        stateDir,
        platform,
        fetchImpl: noDownload,
        spawnSyncImpl: options.spawnSyncImpl,
      })
      return { present: true, path: binary, verified: true }
    } catch {
      const names = platform === 'win32' ? ['cloudflared.exe'] : ['cloudflared']
      if (cloudflaredPath.trim().length > 0 && existsSync(cloudflaredPath.trim())) {
        return { present: true, path: cloudflaredPath.trim(), verified: false }
      }
      for (const name of names) {
        const managed = join(stateDir, name)
        if (existsSync(managed)) return { present: true, path: managed, verified: false }
      }
      return { present: false, path: null, verified: false }
    }
  }

  /**
   * The single object the panel, the routes and the tools consume. Never throws.
   * @returns {Promise<object>}
   */
  async function status() {
    const config = safeConfig()
    const tailscale = await detectTailscale()
    const funnel = await detectFunnel(tailscale.binary, config)
    const cloudflared = await detectCloudflared(config)
    const view = {
      ok: config !== null,
      platform,
      os: installGuidance(platform),
      tailscale: {
        installed: tailscale.installed,
        version: tailscale.version,
        running: tailscale.running,
        dnsName: tailscale.dnsName,
        suggestedUrl: tailscale.suggestedUrl,
        tailscaleIPs: tailscale.tailscaleIPs,
        binary: tailscale.binary,
      },
      funnel: {
        on: funnel.on,
        url: funnel.url,
        targetPort: funnel.targetPort,
        matchesGatePort: funnel.matchesGatePort,
      },
      config: {
        gatePort: config?.gatePort ?? 0,
        effectiveGatePort: effectiveGatePort(config),
        publicUrl: config?.publicUrl ?? '',
        autoStart: config?.autoStart !== false,
        cloudflaredPath: config?.cloudflaredPath ?? '',
        cloudflaredPresent: cloudflared.present,
        cloudflaredVerified: cloudflared.verified,
      },
      needs: [],
      docs: { ...SETUP_DOCS },
      policy: { json: FUNNEL_POLICY_JSON, acl: FUNNEL_ACL_JSON },
    }
    view.needs = computeNeeds(view)
    return view
  }

  /**
   * Validates, writes and applies a patch: one atomic write, then a service
   * restart so the new origin/port is live without a harness restart.
   * @param {{publicUrl?: string, gatePort?: number, autoStart?: boolean}} input
   * @returns {Promise<object>} the fresh detection object.
   */
  async function apply(input) {
    const patch = normalizeSetupPatch(input)
    if (Object.keys(patch).length === 0) return status()
    let existing
    try {
      existing = readConfigOverride(configFile)
    } catch (error) {
      throw setupError(error instanceof Error ? error.message : String(error), 500)
    }
    const next = { ...existing, ...patch }
    const config = safeConfig()
    if (patch.gatePort !== undefined && patch.gatePort !== effectiveGatePort(config)) {
      // Probe before writing: a 409 must not leave a broken file behind. The
      // current effective port is skipped because the gate already owns it.
      const available = await isPortAvailable(patch.gatePort)
      if (!available) {
        throw setupError(`gate port ${String(patch.gatePort)} is already in use on 127.0.0.1`, 409)
      }
    }
    try {
      writeConfigOverride(configFile, next)
    } catch (error) {
      throw setupError(error instanceof Error ? error.message : String(error), 500)
    }
    try {
      await restart()
    } catch {
      /* the pair service records the failure in its own status message */
    }
    return status()
  }

  /**
   * Runs the one command the panel's "Run it for me" button maps to. The argv is
   * fixed here; `<port>` is an integer from configuration, never from a request.
   * @returns {Promise<{ok: boolean, output: string, port: number}>}
   */
  async function runFunnel() {
    const tailscale = await detectTailscale()
    if (tailscale.installed !== true || typeof tailscale.binary !== 'string') {
      throw setupError(
        `Tailscale is not installed or not on PATH. Install it first: ${installGuidance(platform).install.map(entry => entry.command).filter(command => command.length > 0).join(' | ')} (${TAILSCALE_DOWNLOAD_URL})`,
        409,
      )
    }
    const config = safeConfig()
    const port = effectiveGatePort(config)
    if (port === null) {
      throw setupError(
        'the gate port is assigned by the OS; set gatePort (for example 8791) before running the funnel',
        409,
      )
    }
    const result = await runCommand(execFileImpl, tailscale.binary, ['funnel', '--bg', String(port)], FUNNEL_TIMEOUT_MS)
    const output = redactOutput(`${result.stdout}\n${result.stderr}`)
    const payload = { ok: result.ok, output, port }
    if (!result.ok) {
      const error = setupError(
        output.length > 0 ? output : `tailscale funnel exited with code ${String(result.code)}`,
        409,
      )
      error.result = payload
      throw error
    }
    return payload
  }

  return {
    /** The detection object (async: it runs four fixed commands). */
    status,
    apply,
    runFunnel,
    configFile,
    stateDir,
    platform,
  }
}

export default createSetupService
