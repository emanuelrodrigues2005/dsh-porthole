/**
 * Pair service: owns the ticket store, gate, tunnel and the status payload the
 * panel polls. Nothing starts at construction; `start()` is explicit.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveCloudflared } from './cloudflared.js'
import { createGate } from './gate.js'
import { createNotificationStore } from './notifications.js'
import { createPushSender } from './push.js'
import { qrMatrix } from './qr.js'
import { normalizePublicUrl, readConfigOverride } from './setup.js'
import createTicketStore from './tickets.js'
import { createTunnelManager } from './tunnel.js'
import { createVapid } from './vapid.js'

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000
const SECRET_BYTES = 32
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/
const STATE_VERSION = 1
/** Funnel forwards to a fixed local port, so public-URL mode must never ask the OS. */
const DEFAULT_PUBLIC_GATE_PORT = 8791
const CONFIG_KEYS = new Set([
  'gatePort',
  'deviceTtlDays',
  'ticketTtlSeconds',
  'cloudflaredPath',
  'publicUrl',
  'autoStart',
])

/** Strips ticket/token/cookie material from a message shown to the operator. */
export function publicMessage(error) {
  let message = error instanceof Error ? error.message : String(error)
  message = message
    .replace(/([?&]token=)[^&\s]*/gi, '$1[redacted]')
    .replace(/\bdsh_pair=[^;\s]*/g, 'dsh_pair=[redacted]')
    .replace(/\/pair\/[A-Za-z0-9_-]{43}/g, '/pair/[redacted]')
    .replace(/\b[A-Za-z0-9_-]{43}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  return message.length > 500 ? `${message.slice(0, 500)}…` : message || 'pair request failed'
}

function requirePositiveInteger(value, fallback, label, maximum) {
  const resolved = value === undefined ? fallback : value
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new Error(`pair: ${label} must be an integer between 1 and ${String(maximum)}`)
  }
  return resolved
}

function normalizeConfig(input) {
  const source = input === undefined || input === null ? {} : input
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('pair: configuration must be an object')
  }
  for (const key of Object.keys(source)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `pair: unknown configuration key ${JSON.stringify(key)}; expected ${[...CONFIG_KEYS].join(', ')}`,
      )
    }
  }
  const gatePort = source.gatePort === undefined ? 0 : source.gatePort
  if (!Number.isSafeInteger(gatePort) || gatePort < 0 || gatePort > 65535) {
    throw new Error('pair: gatePort must be an integer between 0 and 65535')
  }
  const deviceTtlDays = requirePositiveInteger(source.deviceTtlDays, 30, 'deviceTtlDays', 3650)
  const ticketTtlSeconds = requirePositiveInteger(source.ticketTtlSeconds, 300, 'ticketTtlSeconds', 86_400)
  const cloudflaredPath = source.cloudflaredPath === undefined ? '' : source.cloudflaredPath
  if (typeof cloudflaredPath !== 'string') {
    throw new Error('pair: cloudflaredPath must be a string')
  }
  const publicUrl = source.publicUrl === undefined ? '' : normalizePublicUrl(source.publicUrl)
  const autoStart = source.autoStart === undefined ? true : source.autoStart
  if (typeof autoStart !== 'boolean') {
    throw new Error('pair: autoStart must be a boolean')
  }
  return { gatePort, deviceTtlDays, ticketTtlSeconds, cloudflaredPath, publicUrl, autoStart }
}

function loadOrCreateSecret(stateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, 'pair-state.json')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`pair: cannot read ${file}: ${error.message}`)
    }
    text = null
  }
  if (text !== null) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`pair: ${file} is not valid JSON; delete it to start over`)
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      parsed.version !== STATE_VERSION ||
      typeof parsed.secret !== 'string' ||
      !SECRET_PATTERN.test(parsed.secret) ||
      Buffer.from(parsed.secret, 'base64url').length !== SECRET_BYTES
    ) {
      throw new Error(`pair: ${file} has an unsupported format; delete it to start over`)
    }
    return parsed.secret
  }

  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  const temporary = join(stateDir, `.pair-state-${String(process.pid)}-${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: STATE_VERSION, secret }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw new Error(`pair: cannot create ${file}: ${error.message}`)
  }
  return secret
}

/**
 * Creates the Pair service. Only filesystem reads/writes for the per-home
 * secret and device state happen here; no listener or child process starts.
 * @param {object} options
 * @param {string} options.stateDir - `$DSH_HOME/pair` (or the temp fallback).
 * @param {object} [options.config] - normalized Pair config.
 * @param {string} [options.configFile] - `$DSH_HOME/pair/config.json` override.
 * @param {() => number|undefined} options.getUpstreamPort - DSH web listener port.
 * @param {() => string|null} options.getLaunchToken - in-process launch token.
 * @param {() => number} [options.now] - epoch-millisecond clock.
 * @param {Function} [options.resolveBinary] - cloudflared resolver override.
 * @param {Function} [options.spawn] - tunnel child spawn override.
 * @param {Function} [options.killTree] - process-tree killer override.
 * @param {Function} [options.fetchImpl] - fetch override for the download.
 * @param {Function} [options.spawnSyncImpl] - spawnSync override for `--version`.
 */
export function createPairService(options = {}) {
  const stateDir = options.stateDir
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    throw new Error('pair: stateDir is required')
  }
  if (typeof options.getUpstreamPort !== 'function') {
    throw new Error('pair: getUpstreamPort is required')
  }
  if (typeof options.getLaunchToken !== 'function') {
    throw new Error('pair: getLaunchToken is required')
  }
  const configFile = typeof options.configFile === 'string' && options.configFile.length > 0
    ? options.configFile
    : ''
  /**
   * Configuration precedence (low to high): the row config, then
   * `$DSH_HOME/pair/config.json`. The override file is re-read on construction
   * and on every restart, so the setup service can apply a new origin or gate
   * port without a harness restart. A corrupt file throws, which disables the
   * row loudly instead of pairing with the wrong origin.
   */
  function loadConfig() {
    const rowInput = options.config === undefined || options.config === null ? {} : options.config
    if (configFile === '') return normalizeConfig(rowInput)
    const override = readConfigOverride(configFile)
    return normalizeConfig({ ...rowInput, ...override })
  }
  let config = loadConfig()
  const now = typeof options.now === 'function' ? options.now : Date.now
  const getUpstreamPort = options.getUpstreamPort
  const getLaunchToken = options.getLaunchToken
  const resolveBinary = typeof options.resolveBinary === 'function'
    ? options.resolveBinary
    : (context => resolveCloudflared(context))

  const secret = loadOrCreateSecret(stateDir)
  const store = createTicketStore({
    stateFile: join(stateDir, 'devices.json'),
    secret,
    now,
    ttlMs: config.ticketTtlSeconds * 1000,
    deviceTtlMs: config.deviceTtlDays * DAY_MS,
  })
  // Notification settings and the VAPID keypair live next to the device state.
  // Both files are optional convenience data; a corrupt VAPID file is replaced
  // by a fresh keypair, and the subscriptions signed with the old one are
  // dropped so a stuck device re-subscribes instead of failing forever.
  const notifications = createNotificationStore({ stateFile: join(stateDir, 'notifications.json'), now })
  const vapid = createVapid({ stateFile: join(stateDir, 'vapid.json'), now })
  if (vapid.regenerated) {
    let cleared = false
    try {
      for (const device of notifications.list()) {
        if (notifications.clearSubscription(device.deviceId)) cleared = true
      }
      if (cleared) notifications.persist()
    } catch {
      /* the settings file is best effort; subscriptions re-register anyway */
    }
  }
  const pushSender = createPushSender({ now })

  let state = 'off'
  let message = null
  let ticket = null
  let gate = null
  let tunnel = null
  let generation = 0
  let pipeline = null
  let releasingGate = false
  let qrCache = { pairUrl: null, matrix: null }
  /** Last "Send test" per device, for the one-per-minute rule. */
  const testCooldown = new Map()

  function issueTicket() {
    ticket = store.issue({ name: 'phone' })
    qrCache = { pairUrl: null, matrix: null }
    return ticket
  }

  /** A claimed ticket is burned: it must never be offered as a QR again. */
  function burnTicket() {
    ticket = null
    qrCache = { pairUrl: null, matrix: null }
  }

  function matrixFor(pairUrl) {
    if (typeof pairUrl !== 'string' || pairUrl.length === 0) return null
    if (qrCache.pairUrl === pairUrl) return qrCache.matrix
    try {
      const matrix = qrMatrix(pairUrl)
      qrCache = { pairUrl, matrix }
      return matrix
    } catch {
      return null
    }
  }

  function releaseGateSoon() {
    if (gate === null || releasingGate) return
    const closing = gate
    gate = null
    releasingGate = true
    void closing
      .close()
      .catch(() => {})
      .finally(() => {
        releasingGate = false
      })
  }

  function syncWithTunnel() {
    if (tunnel === null) return null
    let tunnelStatus
    try {
      tunnelStatus = tunnel.status()
    } catch {
      tunnelStatus = { state: 'error', url: null, message: 'Cloudflare tunnel status is unavailable' }
    }
    if (tunnelStatus.state === 'ready' && tunnelStatus.url) {
      if (state !== 'ready') {
        state = 'ready'
        message = null
      }
      return tunnelStatus
    }
    if (tunnelStatus.state === 'error') {
      if (state !== 'error' || message !== tunnelStatus.message) {
        state = 'error'
        message = tunnelStatus.message ?? 'Cloudflare tunnel failed'
        releaseGateSoon()
      }
      return tunnelStatus
    }
    if (tunnelStatus.state === 'off' && state === 'ready') {
      state = 'error'
      message = 'Cloudflare tunnel stopped unexpectedly'
      releaseGateSoon()
    }
    return tunnelStatus
  }

  function status() {
    try {
      const tunnelStatus = syncWithTunnel()
      const tunnelUrl = tunnelStatus !== null && tunnelStatus.state === 'ready' && typeof tunnelStatus.url === 'string'
        ? tunnelStatus.url
        : null
      // B2: in public-URL mode the URL is configuration, not tunnel output, and
      // it only exists while the gate is up.
      const publicMode = config.publicUrl !== ''
      const url = publicMode ? (state === 'ready' ? config.publicUrl : null) : tunnelUrl
      let pairUrl = null
      let matrix = null
      const ticketLive = ticket !== null && now() < ticket.expiresAt
      if (state === 'ready' && url !== null && ticketLive) {
        pairUrl = `${url.replace(/\/+$/u, '')}/pair/${ticket.ticket}`
        matrix = matrixFor(pairUrl)
      }
      const payload = {
        state,
        url,
        expiresAt: ticket === null ? null : ticket.expiresAt,
        // The operator card renders one notification row per device, so the
        // settings travel with the device record instead of a second route.
        devices: store.listDevices().map(device => ({ ...device, notifications: notifications.view(device.id) })),
        pairUrl,
        matrix,
      }
      // B4: the panel renders the stable origin and the install hint when this
      // flag is present; a quick-tunnel result must stay unflagged.
      if (publicMode && state === 'ready') payload.stable = true
      if (typeof message === 'string' && message.length > 0) payload.message = message
      return payload
    } catch (error) {
      return {
        state: 'error',
        url: null,
        expiresAt: null,
        devices: [],
        pairUrl: null,
        matrix: null,
        message: publicMessage(error),
      }
    }
  }

  function safeLaunchToken() {
    try {
      const token = getLaunchToken()
      return typeof token === 'string' && token.length > 0 ? token : null
    } catch {
      return null
    }
  }

  function safeUpstreamPort() {
    try {
      const port = getUpstreamPort()
      return Number.isSafeInteger(port) && port > 0 && port <= 65535 ? port : null
    } catch {
      return null
    }
  }

  /**
   * Sends one empty push to a device and records what the push service said.
   * Never throws: a failed tickle must not break the turn that caused it.
   * @param {string} deviceId
   * @returns {Promise<boolean>}
   */
  async function sendToDevice(deviceId) {
    try {
      // The phone can only drain through the gate, so a tickle while the gate is
      // down is noise (and a guaranteed transport failure).
      if (state !== 'ready') return false
      const endpoint = notifications.endpointFor(deviceId)
      if (endpoint === null) return false
      const result = await pushSender.send({ endpoint, vapid })
      notifications.recordPush(deviceId, result)
      if (result.drop === true) {
        try {
          await notifications.persist()
        } catch {
          /* the in-memory drop already stops further attempts */
        }
      }
      return result.ok === true
    } catch {
      return false
    }
  }

  /**
   * Queues one notification for every eligible device and tickles each of them.
   * @param {object} item - `{category, title, body, url, dedupeKey}`.
   * @returns {number} how many devices were queued.
   */
  function notify(item = {}) {
    try {
      if (state !== 'ready') return 0
      const category = typeof item.category === 'string' ? item.category : ''
      let queued = 0
      for (const deviceId of notifications.eligibleDevices(category)) {
        if (notifications.enqueue({ ...item, deviceId }) === null) continue
        queued += 1
        void sendToDevice(deviceId)
      }
      return queued
    } catch {
      return 0
    }
  }

  /**
   * Queues one explicit report and tickles every device that accepted it.
   * Never throws: the caller is a model-facing tool.
   * @param {{title?: string, body?: string, issue?: string, url?: string}} report
   * @returns {{queued: boolean, id: string, devices: number}}
   */
  function notifyReport(report = {}) {
    try {
      const candidates = notifications.eligibleDevices('reports')
      const result = notifications.enqueueReport(report)
      if (state === 'ready') {
        for (const deviceId of candidates) {
          if (notifications.pending(deviceId) > 0) void sendToDevice(deviceId)
        }
      }
      return result
    } catch {
      return { queued: false, id: '', devices: 0 }
    }
  }

  /** Drops an undrained item by dedupe key (an approval was decided already). */
  function resolveNotification(dedupeKey) {
    try {
      return notifications.dropByDedupe(dedupeKey)
    } catch {
      return 0
    }
  }

  /**
   * Applies the operator's per-device switches (the same settings the phone
   * owns) and persists them. Throws on invalid input so the route answers 400.
   * @param {string} deviceId
   * @param {{enabled?: boolean, categories?: object}} patch
   */
  async function setDeviceNotifications(deviceId, patch) {
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      throw new Error('deviceId is required')
    }
    const view = notifications.updateSettings(deviceId, patch)
    try {
      await notifications.persist()
    } catch {
      /* the settings are applied in memory for this process */
    }
    return view
  }

  /** Queues one test notification; at most one per device per minute. */
  function pushTest(deviceId) {
    try {
      const current = now()
      const last = testCooldown.get(deviceId)
      if (last !== undefined && current - last < MINUTE_MS) {
        return {
          ok: false,
          reason: 'cooldown',
          retryAfter: Math.max(1, Math.ceil((MINUTE_MS - (current - last)) / 1000)),
        }
      }
      if (notifications.endpointFor(deviceId) === null) return { ok: false, reason: 'no-subscription' }
      const item = notifications.enqueue({
        deviceId,
        category: 'completion',
        title: 'Test notification',
        body: 'Push notifications are working. Tap to open DSH.',
        url: '/',
        dedupeKey: `test:${String(current)}`,
      })
      if (item === null) return { ok: false, reason: 'disabled' }
      testCooldown.set(deviceId, current)
      void sendToDevice(deviceId)
      return { ok: true }
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
  }

  /** The gate's view of the push subsystem: one object, one wiring point. */
  const pushFacade = { store: notifications, vapid, send: sendToDevice, test: pushTest }

  /** Gate `onPaired` hook: burn the claimed ticket in status and persist. */
  function pairingHook(claimingTicket) {
    return async () => {
      // S5: the ticket was just burned by the store; drop it from status before
      // the gate answers the phone. Persist the hashed record too.
      if (ticket === claimingTicket) burnTicket()
      await store.persist()
    }
  }

  async function runPipeline(mark, launchToken, upstreamPort) {
    let localGate = null
    let localTunnel = null
    const claimingTicket = ticket
    try {
      const binary = await resolveBinary({
        cloudflaredPath: config.cloudflaredPath,
        stateDir,
        platform: process.platform,
        fetchImpl: options.fetchImpl,
        spawnSyncImpl: options.spawnSyncImpl,
      })
      if (mark !== generation) return

      localGate = createGate({
        upstreamPort,
        store,
        now,
        launchToken,
        port: config.gatePort,
        onPaired: pairingHook(claimingTicket),
        push: pushFacade,
        publicOrigin: config.publicUrl,
      })
      await localGate.listen()
      if (mark !== generation) {
        await localGate.close()
        return
      }
      if (localGate.port === null || localGate.port === undefined) {
        throw new Error('the Pair gate did not report a listening port')
      }
      gate = localGate

      localTunnel = createTunnelManager({
        cloudflaredPath: binary,
        gatePort: localGate.port,
        stateDir,
        now,
        spawn: options.spawn,
        killTree: options.killTree,
      })
      tunnel = localTunnel
      await localTunnel.start()
      if (mark !== generation) {
        await localTunnel.stop()
        await localGate.close()
        return
      }
      const tunnelStatus = localTunnel.status()
      if (tunnelStatus.state === 'error') {
        state = 'error'
        message = tunnelStatus.message ?? 'Cloudflare tunnel failed'
        releaseGateSoon()
      } else if (tunnelStatus.state === 'ready') {
        state = 'ready'
        message = null
      }
    } catch (error) {
      if (localTunnel !== null) {
        if (tunnel === localTunnel) tunnel = null
        await localTunnel.stop().catch(() => {})
      }
      if (localGate !== null) {
        if (gate === localGate) gate = null
        await localGate.close().catch(() => {})
      }
      throw error
    }
  }

  /**
   * B2: public-URL mode. A reverse proxy owned by the operator (Tailscale
   * Funnel) terminates TLS at the tailnet edge and forwards to a fixed local
   * port, so there is no tunnel child to resolve, spawn or parse, and the URL
   * never changes across restarts.
   */
  async function runPublicPipeline(mark, launchToken, upstreamPort) {
    const claimingTicket = ticket
    // Funnel forwards to one fixed port, so 0 (ask the OS) would break it.
    const port = config.gatePort === 0 ? DEFAULT_PUBLIC_GATE_PORT : config.gatePort
    let localGate = null
    try {
      localGate = createGate({
        upstreamPort,
        store,
        now,
        launchToken,
        port,
        onPaired: pairingHook(claimingTicket),
        push: pushFacade,
        publicOrigin: config.publicUrl,
      })
      await localGate.listen()
      if (mark !== generation) {
        await localGate.close()
        return
      }
      if (localGate.port === null || localGate.port === undefined) {
        throw new Error('the Pair gate did not report a listening port')
      }
      gate = localGate
      state = 'ready'
      message = null
    } catch (error) {
      if (localGate !== null) {
        if (gate === localGate) gate = null
        await localGate.close().catch(() => {})
      }
      throw error
    }
  }

  /** Starts the gate and quick tunnel. Idempotent while starting/ready. */
  async function start() {
    if (state === 'starting' || state === 'ready') return status()
    const launchToken = safeLaunchToken()
    if (launchToken === null) {
      state = 'error'
      message = 'The DSH launch token is unavailable, so Pair cannot start. Restart the harness and try again.'
      throw new Error(message)
    }
    let upstreamPort = safeUpstreamPort()
    // Auto-start can run before the web server has bound its port; wait briefly
    // instead of recording a permanent error the operator has to clear by hand.
    for (let attempt = 0; upstreamPort === null && attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 250))
      upstreamPort = safeUpstreamPort()
    }
    if (upstreamPort === null) {
      state = 'error'
      message = 'The DSH web listener is not ready, so Pair cannot start.'
      throw new Error(message)
    }

    issueTicket()
    generation += 1
    const mark = generation
    state = 'starting'
    message = null
    const runner = config.publicUrl !== ''
      ? runPublicPipeline(mark, launchToken, upstreamPort)
      : runPipeline(mark, launchToken, upstreamPort)
    pipeline = runner.catch(error => {
      if (mark !== generation) return
      state = 'error'
      message = publicMessage(error)
    })
    return status()
  }

  /** Stops the tunnel and gate; idempotent. Devices and the secret persist. */
  async function stop() {
    generation += 1
    pipeline = null
    state = 'off'
    message = null
    ticket = null
    qrCache = { pairUrl: null, matrix: null }
    const stoppingTunnel = tunnel
    tunnel = null
    const closingGate = gate
    gate = null
    if (stoppingTunnel !== null) {
      try {
        await stoppingTunnel.stop()
      } catch {
        /* the tunnel is gone either way */
      }
    }
    if (closingGate !== null) {
      try {
        await closingGate.close()
      } catch {
        /* the gate is gone either way */
      }
    }
    // `lastSeenAt` only changes in memory; persist it on shutdown so a restart
    // does not lose it. Best effort: never let this fail shutdown/dispose.
    try {
      await store.persist()
    } catch {
      /* the state file is optional; revocation and pairing already persisted */
    }
    return status()
  }

  /** Issues a fresh pairing ticket; the previous one stops working immediately. */
  async function reissue() {
    const issued = issueTicket()
    return { expiresAt: issued.expiresAt }
  }

  /**
   * Reloads the configuration (row config < `$DSH_HOME/pair/config.json`) and
   * restarts whatever was running. This is what the setup apply route calls, so
   * a new public URL or gate port takes effect without a harness restart. Never
   * throws: a bad file becomes `state: 'error'` with a message, like any other
   * start failure.
   * @returns {Promise<object>} the fresh status payload.
   */
  async function restart() {
    const wasActive = state === 'starting' || state === 'ready'
    await stop()
    try {
      config = loadConfig()
    } catch (error) {
      state = 'error'
      message = publicMessage(error)
      return status()
    }
    // Construction starts public-URL mode when autoStart is on; a restart keeps
    // that promise, and also revives whatever was running before.
    if (wasActive || (config.publicUrl !== '' && config.autoStart)) {
      try {
        await start()
      } catch {
        /* start() records the failure in `state` and `message` */
      }
    }
    return status()
  }

  /** Revokes one device, ends its live sessions and persists the hashed state. */
  async function revoke(deviceId) {
    if (typeof deviceId !== 'string' || deviceId.length === 0) return false
    const existed = store.revoke(deviceId)
    if (existed) {
      // S1: an established WebSocket never re-authenticates, so revoking the
      // cookie alone would leave the phone connected.
      if (gate !== null && typeof gate.revokeDeviceSessions === 'function') {
        gate.revokeDeviceSessions(deviceId)
      }
      try {
        await store.persist()
      } catch (error) {
        throw new Error(`revocation was applied in memory but could not be saved: ${publicMessage(error)}`)
      }
    }
    return existed
  }

  // B3: a stable public URL must stay alive across harness restarts, with or
  // without a paired device: the gate is fail-closed, so an unpaired visitor
  // only sees the pairing-required page, while the operator can issue a fresh
  // ticket from the panel at any time. The gate is started asynchronously so
  // the factory never blocks on a listener, and a failed start is reported,
  // never thrown.
  if (config.autoStart && config.publicUrl !== '') {
    void start().catch(() => {})
  }

  return {
    status,
    start,
    stop,
    restart,
    reissue,
    revoke,
    /** The effective configuration (row config plus the override file). */
    config: () => ({ ...config }),
    /**
     * Queues one notification for every eligible device and sends the push
     * tickle. Non-blocking and non-throwing: the caller is an event listener.
     */
    notify,
    /** Queues one explicit report and tickles every device that accepted it. */
    notifyReport,
    /** Queues one test notification for one device (max one per minute). */
    pushTest,
    /** Applies the operator's per-device notification switches. */
    setDeviceNotifications,
    /** Drops an undrained item whose reason is gone (a decided approval). */
    resolveNotification,
    /** The state directory this service owns (informational). */
    stateDir,
  }
}

export default createPairService
