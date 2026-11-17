/**
 * dsh-porthole host plugin — the Pair row.
 *
 * Loads the Pair service, registers the five lifecycle operator endpoints plus
 * the two push operator routes and the three Tailscale setup routes on the
 * harness web listener, and subscribes the non-blocking push sources (approvals,
 * questions, turn ends) through the row's effect. It never starts a tunnel at
 * load time; the panel asks.
 *
 * This entry point is deliberately non-throwing: a broken Pair row must never
 * prevent the profile from booting. Every failure is reported once through
 * `ctx.logger.warn('[pair] disabled: …')` and `apply` returns normally.
 */
import { mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createPairService } from './pair/host/index.js'
import { registerNotifyTool, reportToolWhen } from './pair/host/notify-tool.js'
import { registerPairRoutes, registerPushRoutes, registerSetupRoutes } from './pair/host/routes.js'
import { createSetupService } from './pair/host/setup.js'
import { registerSetupTool } from './pair/host/setup-tool.js'
import { registerPushSources } from './pair/host/sources.js'

export const inject = ['webServer', 'connection']

const CONFIG_KEYS = new Set([
  'gatePort',
  'deviceTtlDays',
  'ticketTtlSeconds',
  'cloudflaredPath',
  'publicUrl',
  'autoStart',
])

function requireInteger(value, fallback, label, minimum, maximum) {
  const resolved = value === undefined ? fallback : value
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${label} must be an integer between ${String(minimum)} and ${String(maximum)}`)
  }
  return resolved
}

/** Validates the row config by hand: no schema import, unknown keys reject. */
function normalizeConfig(input) {
  const config = input === undefined || input === null ? {} : input
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('configuration must be an object')
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `unknown configuration key ${JSON.stringify(key)}; expected ${[...CONFIG_KEYS].join(', ')}`,
      )
    }
  }
  const gatePort = requireInteger(config.gatePort, 0, 'gatePort', 0, 65535)
  const deviceTtlDays = requireInteger(config.deviceTtlDays, 30, 'deviceTtlDays', 1, 3650)
  const ticketTtlSeconds = requireInteger(config.ticketTtlSeconds, 300, 'ticketTtlSeconds', 1, 86_400)
  const cloudflaredPath = config.cloudflaredPath === undefined ? '' : config.cloudflaredPath
  if (typeof cloudflaredPath !== 'string') {
    throw new Error('cloudflaredPath must be a string')
  }
  // `publicUrl: ''` (the row default) means quick-tunnel mode; a non-empty value
  // is validated by the service, which owns the https-origin rule.
  const publicUrl = config.publicUrl === undefined ? '' : config.publicUrl
  if (typeof publicUrl !== 'string') {
    throw new Error('publicUrl must be a string')
  }
  const autoStart = config.autoStart === undefined ? true : config.autoStart
  if (typeof autoStart !== 'boolean') {
    throw new Error('autoStart must be a boolean')
  }
  return { gatePort, deviceTtlDays, ticketTtlSeconds, cloudflaredPath, publicUrl, autoStart }
}

/** `$DSH_HOME/pair`, falling back to the default harness home, then the OS temp directory. */
function resolveStateDir() {
  const home = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  if (home.length > 0) return resolve(home, 'pair')
  try {
    return resolve(homedir(), '.dsh', 'pair')
  } catch {
    return join(tmpdir(), 'dsh-pair')
  }
}

function sanitizeMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 500) || 'unknown error'
}

function warn(ctx, detail) {
  const message = `[pair] disabled: ${sanitizeMessage(detail)}`
  try {
    if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message)
    else if (typeof ctx?.logger?.error === 'function') ctx.logger.error(message)
  } catch {
    /* logging must never break boot */
  }
}

/**
 * Reads the process launch token from the connection service without ever
 * logging or persisting it. Resolution is lazy and cached on success so a
 * plugin that loads before `connection` becomes available can still start.
 */
function createLaunchTokenReader(ctx) {
  let cached = null
  return () => {
    if (cached !== null) return cached
    const connection = ctx?.connection
    if (connection === null || typeof connection !== 'object') return null
    if (typeof connection.authenticatedUrl !== 'function') return null
    const authenticated = connection.authenticatedUrl('http://127.0.0.1/')
    if (typeof authenticated !== 'string' || authenticated.length === 0) return null
    const token = new URL(authenticated).searchParams.get('token')
    if (typeof token !== 'string' || token.length === 0) return null
    cached = token
    return cached
  }
}

/**
 * Tool visibility for `pair_notify_report`. With a preset registry the report
 * tool is offered to `equipe` and `reporter` only; without one it stays
 * visible, so a profile that does not use presets behaves as before.
 */
function reportToolOptions(ctx) {
  try {
    const presets = ctx?.agentPresets
    if (presets !== null && typeof presets === 'object' && typeof presets.presetForSession === 'function') {
      return { when: reportToolWhen(presets) }
    }
  } catch {
    /* an optional predicate must not fail registration */
  }
  return {}
}

/**
 * Applies the Pair row.
 * @param {object} ctx - host context (`webServer`, `connection`, `logger`, `effect`).
 * @param {object} [config] - row config: gatePort, deviceTtlDays,
 *   ticketTtlSeconds, cloudflaredPath, publicUrl, autoStart.
 */
export function apply(ctx, config) {
  let disposeRoutes = null
  let disposePushRoutes = null
  let disposeSetupRoutes = null
  let disposeSources = null
  let disposeNotifyTool = null
  let disposeSetupTool = null
  let notifyToolFiber = null
  try {
    if (ctx === null || typeof ctx !== 'object') return
    const webServer = ctx.webServer
    if (webServer === null || typeof webServer !== 'object' || typeof webServer.register !== 'function') {
      warn(ctx, 'webServer is missing; the Pair panel is unavailable')
      return
    }

    const normalized = normalizeConfig(config)
    const stateDir = resolveStateDir()
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })

    // `publicUrl: ''` is the row default (quick-tunnel mode). The service
    // rejects an explicitly empty origin, so an unset key is simply omitted.
    const serviceConfig = {
      gatePort: normalized.gatePort,
      deviceTtlDays: normalized.deviceTtlDays,
      ticketTtlSeconds: normalized.ticketTtlSeconds,
      cloudflaredPath: normalized.cloudflaredPath,
      autoStart: normalized.autoStart,
    }
    if (normalized.publicUrl !== '') serviceConfig.publicUrl = normalized.publicUrl

    const service = createPairService({
      stateDir,
      // The setup panel writes `$DSH_HOME/pair/config.json`; the service merges
      // it over the row config at construction and on every restart.
      configFile: join(stateDir, 'config.json'),
      config: serviceConfig,
      getUpstreamPort: () => {
        try {
          return webServer.port
        } catch {
          return undefined
        }
      },
      getLaunchToken: createLaunchTokenReader(ctx),
    })

    disposeRoutes = registerPairRoutes(ctx, service)
    disposePushRoutes = registerPushRoutes(ctx, service)

    /**
     * Tailscale setup: detection, the guided apply and the one fixed funnel
     * command. It reads the same effective config the service uses and asks the
     * service to restart after a write, so no harness restart is needed.
     */
    const setup = createSetupService({
      stateDir,
      configFile: join(stateDir, 'config.json'),
      getConfig: () => service.config(),
      restart: () => service.restart(),
    })
    disposeSetupRoutes = registerSetupRoutes(ctx, service, setup)

    /**
     * S5: `pair_notify_report` is deployment-level. `tools` is an optional
     * service, so the registration lives in `ctx.inject` and a profile without
     * a tool registry boots untouched. The `when` predicate keeps the tool out
     * of presets that are not expected to talk to the operator.
     */
    const registerReportTool = (toolCtx) => {
      disposeNotifyTool = registerNotifyTool(
        toolCtx,
        { enqueueReport: report => service.notifyReport(report) },
        reportToolOptions(ctx),
      )
      // Same fiber, same registry: `pair_setup_status` / `pair_setup_apply` are
      // deployment-level too, and a profile without tools boots untouched.
      disposeSetupTool = registerSetupTool(toolCtx, setup)
    }
    try {
      if (typeof ctx.inject === 'function') {
        notifyToolFiber = ctx.inject(['tools'], registerReportTool)
      } else {
        registerReportTool(ctx)
      }
    } catch {
      /* the tool is a convenience; the Pair row still loads without it */
    }

    /** Removes the report tool, whether it registered directly or via a fiber. */
    const stopNotifyTool = () => {
      if (notifyToolFiber !== null) {
        const fiber = notifyToolFiber
        notifyToolFiber = null
        try {
          const pending = fiber.dispose()
          if (pending !== null && typeof pending?.catch === 'function') pending.catch(() => {})
        } catch {
          /* the fiber may already be gone */
        }
      } else if (typeof disposeNotifyTool === 'function') {
        try {
          disposeNotifyTool()
        } catch {
          /* the registry may already be disposed */
        }
      }
      if (typeof disposeSetupTool === 'function') {
        try {
          disposeSetupTool()
        } catch {
          /* the registry may already be disposed */
        }
      }
      disposeNotifyTool = null
      disposeSetupTool = null
    }

    /**
     * S4: the push sources are observers, registered inside the row's effect so
     * disposing the plugin removes every listener and no closure survives the
     * service it feeds.
     */
    const startSources = () => registerPushSources(ctx, {
      notify: service.notify,
      resolve: service.resolveNotification,
      logger: ctx.logger,
    })

    let disposed = false
    const cleanup = () => {
      if (disposed) return undefined
      disposed = true
      stopNotifyTool()
      if (disposeSources !== null) {
        try {
          disposeSources()
        } catch {
          /* a half-disposed context is still a disposed context */
        }
      }
      for (const dispose of [disposePushRoutes, disposeRoutes, disposeSetupRoutes]) {
        if (dispose === null) continue
        try {
          dispose()
        } catch {
          /* the web server may already be gone */
        }
      }
      return service.stop()
    }
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        if (disposeSources === null) disposeSources = startSources()
        return cleanup
      }, 'dsh-pair: lifecycle')
    } else if (typeof ctx.on === 'function') {
      if (disposeSources === null) disposeSources = startSources()
      ctx.on('dispose', cleanup)
    } else {
      warn(ctx, 'ctx.effect is missing; Pair will not stop cleanly on dispose')
    }
  } catch (error) {
    try {
      if (notifyToolFiber !== null) {
        const pending = notifyToolFiber.dispose()
        if (pending !== null && typeof pending?.catch === 'function') pending.catch(() => {})
      } else if (typeof disposeNotifyTool === 'function') {
        disposeNotifyTool()
      }
      if (typeof disposeSetupTool === 'function') disposeSetupTool()
    } catch {
      /* already disposed */
    }
    for (const dispose of [disposeSources, disposeSetupRoutes, disposePushRoutes, disposeRoutes]) {
      if (dispose === null) continue
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
    warn(ctx, error)
  }
}
