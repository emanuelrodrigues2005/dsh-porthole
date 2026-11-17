/**
 * Push-notification settings and the in-memory delivery queue for Pair.
 *
 * One record per paired device: whether notifications are enabled, which
 * categories the phone asked for, and at most one Web Push subscription. The
 * settings half is persisted atomically to `$DSH_HOME/pair/notifications.json`
 * (mode 0600); the queue half is memory only and bounded (32 items per device,
 * 256 total, 30 minute TTL) because a notification nobody drained is stale by
 * definition.
 *
 * The file never holds a device token: the key is the `deviceId` the ticket
 * store hands out, which is useless on its own. A subscription endpoint *is*
 * capability material, so it is only ever returned to its own device (the
 * redacted `host` view goes to the operator panel).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The four categories the phone can switch independently. */
export const CATEGORY_NAMES = Object.freeze(['approvals', 'questions', 'completion', 'reports'])

/** Every category starts enabled: a freshly paired phone is a useful phone. */
export const DEFAULT_CATEGORIES = Object.freeze({
  approvals: true,
  questions: true,
  completion: true,
  reports: true,
})

const STATE_VERSION = 1
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
/** Bounds from the accepted design; all three are centrals of the queue's cost. */
const ITEM_TTL_MS = 30 * MINUTE_MS
const MAX_ITEMS_PER_DEVICE = 32
const MAX_ITEMS_TOTAL = 256
/** A repeated dedupe key inside this window is the same event, not a new one. */
const COALESCE_MS = MINUTE_MS
/** Per-device token bucket: burst 5, 20/hour sustained. */
const DEVICE_BURST = 5
const DEVICE_PER_HOUR = 20
/** Global token bucket: 300/hour. */
const GLOBAL_BURST = 300
const GLOBAL_PER_HOUR = 300
const MAX_TITLE_LENGTH = 120
const MAX_BODY_LENGTH = 300
const MAX_URL_LENGTH = 200
const MAX_USER_AGENT_LENGTH = 200
const MAX_DEVICE_ID_LENGTH = 128

function clampText(value, limit, fallback = '') {
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
  if (text.length === 0) return fallback
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Reads the settings file. A missing file is a fresh install; a file that
 * cannot be parsed or that carries an unsupported shape is reported through
 * `loadError` and treated as empty. Push settings are optional convenience
 * data — unlike the pairing secret or the device hashes, losing them must not
 * disable pairing itself, and the next persist rewrites a valid file.
 * @param {string} stateFile
 * @returns {{devices: Map<string, object>, loadError: string|null}}
 */
function readState(stateFile) {
  let text
  try {
    text = readFileSync(stateFile, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { devices: new Map(), loadError: null }
    return { devices: new Map(), loadError: `cannot read ${stateFile}: ${error.message}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { devices: new Map(), loadError: `${stateFile} is not valid JSON; a new one will be written` }
  }
  if (!isPlainObject(parsed) || parsed.version !== STATE_VERSION || !isPlainObject(parsed.devices)) {
    return { devices: new Map(), loadError: `${stateFile} has an unsupported format; a new one will be written` }
  }
  const devices = new Map()
  for (const [deviceId, record] of Object.entries(parsed.devices)) {
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > MAX_DEVICE_ID_LENGTH) continue
    if (!isPlainObject(record)) continue
    const subscription = normalizeSubscription(record.subscription)
    const categories = normalizeCategories(record.categories)
    devices.set(deviceId, {
      enabled: record.enabled === false ? false : true,
      categories,
      subscription,
      createdAt: Number.isSafeInteger(record.createdAt) ? record.createdAt : 0,
      updatedAt: Number.isSafeInteger(record.updatedAt) ? record.updatedAt : 0,
      lastPushAt: Number.isSafeInteger(record.lastPushAt) ? record.lastPushAt : 0,
      lastPushStatus: Number.isSafeInteger(record.lastPushStatus) ? record.lastPushStatus : 0,
      failureCount: Number.isSafeInteger(record.failureCount) && record.failureCount > 0 ? record.failureCount : 0,
    })
  }
  return { devices, loadError: null }
}

function normalizeSubscription(value) {
  if (!isPlainObject(value) || typeof value.endpoint !== 'string' || value.endpoint.length === 0) return null
  return {
    endpoint: value.endpoint,
    createdAt: Number.isSafeInteger(value.createdAt) ? value.createdAt : 0,
    userAgent: typeof value.userAgent === 'string' ? value.userAgent.slice(0, MAX_USER_AGENT_LENGTH) : '',
  }
}

function normalizeCategories(value) {
  const categories = { ...DEFAULT_CATEGORIES }
  if (!isPlainObject(value)) return categories
  for (const name of CATEGORY_NAMES) {
    if (typeof value[name] === 'boolean') categories[name] = value[name]
  }
  return categories
}

/** The operator-facing view of a subscription: host only, never the endpoint. */
function subscriptionView(subscription) {
  if (subscription === null) return null
  let host = ''
  try {
    host = new URL(subscription.endpoint).host
  } catch {
    host = ''
  }
  return { host, createdAt: subscription.createdAt }
}

function deviceView(deviceId, record) {
  return {
    deviceId,
    enabled: record.enabled,
    categories: { ...record.categories },
    subscription: subscriptionView(record.subscription),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastPushAt: record.lastPushAt,
    lastPushStatus: record.lastPushStatus,
    failureCount: record.failureCount,
  }
}

/**
 * Creates the notification store.
 * @param {object} options
 * @param {string} options.stateFile - `$DSH_HOME/pair/notifications.json`.
 * @param {() => number} [options.now] - epoch-millisecond clock.
 */
export function createNotificationStore(options = {}) {
  const { stateFile } = options
  if (typeof stateFile !== 'string' || stateFile.length === 0) {
    throw new Error('pair notifications: stateFile is required')
  }
  const now = typeof options.now === 'function' ? options.now : Date.now
  // The design's bounds are the defaults; they are injectable so an operator (and
  // the tests) can shrink the queue without touching the rate limiter.
  const itemTtlMs = Number.isSafeInteger(options.itemTtlMs) && options.itemTtlMs > 0 ? options.itemTtlMs : ITEM_TTL_MS
  const maxPerDevice =
    Number.isSafeInteger(options.maxPerDevice) && options.maxPerDevice > 0 ? options.maxPerDevice : MAX_ITEMS_PER_DEVICE
  const maxTotal = Number.isSafeInteger(options.maxTotal) && options.maxTotal > 0 ? options.maxTotal : MAX_ITEMS_TOTAL
  const loaded = readState(stateFile)
  const devices = loaded.devices
  const loadError = loaded.loadError
  /** @type {Array<object>} undrained items, oldest first */
  const queue = []
  const lastByDedupe = new Map()
  const deviceBuckets = new Map()

  const globalBucket = { tokens: GLOBAL_BURST, at: now() }

  /** Adds the tokens that elapsed time earned, never above the burst capacity. */
  function refill(bucket, capacity, perHour) {
    const current = now()
    const elapsed = Math.max(0, current - bucket.at)
    bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed / HOUR_MS) * perHour)
    bucket.at = current
    return bucket
  }

  function take(map, key, capacity, perHour) {
    let bucket = map.get(key)
    if (bucket === undefined) {
      bucket = { tokens: capacity, at: now() }
      map.set(key, bucket)
    }
    refill(bucket, capacity, perHour)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  function pruneExpired() {
    const current = now()
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (current - queue[index].createdAt >= itemTtlMs) queue.splice(index, 1)
    }
    for (const [key, at] of lastByDedupe) {
      if (current - at >= COALESCE_MS) lastByDedupe.delete(key)
    }
  }

  function trimPerDevice(deviceId) {
    const mine = queue.filter(item => item.deviceId === deviceId)
    if (mine.length <= maxPerDevice) return
    const excess = new Set(mine.slice(0, mine.length - maxPerDevice).map(item => item.id))
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (excess.has(queue[index].id)) queue.splice(index, 1)
    }
  }

  function trimTotal() {
    if (queue.length <= maxTotal) return
    queue.splice(0, queue.length - maxTotal)
  }

  function ensure(deviceId) {
    if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId.length > MAX_DEVICE_ID_LENGTH) {
      return null
    }
    let record = devices.get(deviceId)
    if (record !== undefined) return record
    const current = now()
    record = {
      enabled: true,
      categories: { ...DEFAULT_CATEGORIES },
      subscription: null,
      createdAt: current,
      updatedAt: current,
      lastPushAt: 0,
      lastPushStatus: 0,
      failureCount: 0,
    }
    devices.set(deviceId, record)
    return record
  }

  function recordFor(deviceId) {
    if (typeof deviceId !== 'string' || deviceId.length === 0) return null
    return devices.get(deviceId) ?? null
  }

  /** Devices that should receive one category right now. */
  function eligibleFor(category) {
    const eligible = []
    for (const [deviceId, record] of devices) {
      if (!record.enabled) continue
      if (record.subscription === null) continue
      if (record.categories[category] !== true) continue
      eligible.push(deviceId)
    }
    return eligible
  }

  /**
   * Queues one item for one device. Returns the queued item, or null when the
   * device is unknown, disabled, unsubscribed, opted out of the category, hit
   * a rate limit, or repeated a dedupe key that is still undrained.
   */
  function enqueueItem({ deviceId, category, title, body, url, dedupeKey } = {}) {
    const record = recordFor(deviceId)
    if (record === null) return null
    if (!record.enabled || record.subscription === null) return null
    if (!CATEGORY_NAMES.includes(category) || record.categories[category] !== true) return null
    pruneExpired()
    const key = typeof dedupeKey === 'string' && dedupeKey.length > 0 ? dedupeKey : null
    if (key !== null) {
      if (queue.some(item => item.deviceId === deviceId && item.dedupeKey === key)) return null
      const last = lastByDedupe.get(`${deviceId}\u0000${key}`)
      if (last !== undefined && now() - last < COALESCE_MS) return null
    }
    if (!take(deviceBuckets, deviceId, DEVICE_BURST, DEVICE_PER_HOUR)) return null
    refill(globalBucket, GLOBAL_BURST, GLOBAL_PER_HOUR)
    if (globalBucket.tokens < 1) return null
    globalBucket.tokens -= 1
    const item = {
      id: randomUUID(),
      deviceId,
      category,
      title: clampText(title, MAX_TITLE_LENGTH, 'DSH'),
      body: clampText(body, MAX_BODY_LENGTH, ''),
      url: clampText(url, MAX_URL_LENGTH, '/') || '/',
      createdAt: now(),
      dedupeKey: key,
      resolved: false,
    }
    queue.push(item)
    if (key !== null) lastByDedupe.set(`${deviceId}\u0000${key}`, item.createdAt)
    trimPerDevice(deviceId)
    trimTotal()
    return { ...item }
  }

  return {
    stateFile,
    /** Why the settings file could not be read, or null when it loaded cleanly. */
    get loadError() {
      return loadError
    },

    /** Creates the default record for a device once; repeated calls are no-ops. */
    ensure(deviceId) {
      const record = ensure(deviceId)
      return record === null ? null : deviceView(deviceId, record)
    },

    /** Operator/phone view of one device, synthesized (not persisted) when absent. */
    view(deviceId) {
      const record = recordFor(deviceId)
      if (record === null) {
        return {
          deviceId: typeof deviceId === 'string' ? deviceId : '',
          enabled: true,
          categories: { ...DEFAULT_CATEGORIES },
          subscription: null,
          createdAt: 0,
          updatedAt: 0,
          lastPushAt: 0,
          lastPushStatus: 0,
          failureCount: 0,
        }
      }
      return deviceView(deviceId, record)
    },

    /** Every device that has a record, for the operator panel. */
    list() {
      return [...devices].map(([deviceId, record]) => deviceView(deviceId, record))
    },

    /** Devices that should receive one category right now. */
    eligibleDevices(category) {
      return eligibleFor(category)
    },

    /**
     * Applies `{enabled?, categories?}`. Unknown categories and non-boolean
     * values throw, so the route can answer 400 instead of silently dropping a
     * preference the phone thinks it changed.
     */
    updateSettings(deviceId, patch = {}) {
      if (!isPlainObject(patch)) throw new Error('settings must be an object')
      const record = ensure(deviceId)
      if (record === null) throw new Error('a device id is required')
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') throw new Error('enabled must be a boolean')
        record.enabled = patch.enabled
      }
      if (patch.categories !== undefined) {
        if (!isPlainObject(patch.categories)) throw new Error('categories must be an object')
        for (const [name, value] of Object.entries(patch.categories)) {
          if (!CATEGORY_NAMES.includes(name)) throw new Error(`unknown notification category ${JSON.stringify(name)}`)
          if (typeof value !== 'boolean') throw new Error(`notification category ${name} must be a boolean`)
        }
        for (const name of CATEGORY_NAMES) {
          if (typeof patch.categories[name] === 'boolean') record.categories[name] = patch.categories[name]
        }
      }
      record.updatedAt = now()
      return deviceView(deviceId, record)
    },

    /** Stores the one subscription a device may have. */
    setSubscription(deviceId, { endpoint, userAgent } = {}) {
      if (typeof endpoint !== 'string' || endpoint.length === 0) {
        throw new Error('a push endpoint is required')
      }
      const record = ensure(deviceId)
      if (record === null) throw new Error('a device id is required')
      record.subscription = {
        endpoint,
        createdAt: now(),
        userAgent: clampText(userAgent, MAX_USER_AGENT_LENGTH, ''),
      }
      record.failureCount = 0
      record.lastPushStatus = 0
      record.updatedAt = now()
      return deviceView(deviceId, record)
    },

    /** Idempotent: removing an absent subscription succeeds. */
    clearSubscription(deviceId) {
      const record = recordFor(deviceId)
      if (record === null) return false
      if (record.subscription === null) return false
      record.subscription = null
      record.updatedAt = now()
      return true
    },

    /** The raw endpoint, only ever read by the sender — never by a view. */
    endpointFor(deviceId) {
      const record = recordFor(deviceId)
      return record === null || record.subscription === null ? null : record.subscription.endpoint
    },

    /** Records one transport outcome and drops a gone subscription. */
    recordPush(deviceId, { status = 0, ok = false, drop = false } = {}) {
      const record = recordFor(deviceId)
      if (record === null) return null
      record.lastPushAt = now()
      record.lastPushStatus = Number.isSafeInteger(status) ? status : 0
      if (ok) record.failureCount = 0
      else record.failureCount += 1
      if (drop) record.subscription = null
      record.updatedAt = now()
      return deviceView(deviceId, record)
    },

    /**
     * Queues one item for one device. Returns the queued item, or null when the
     * device is unknown, disabled, unsubscribed, opted out of the category, hit
     * a rate limit, or repeated a dedupe key that is still undrained.
     */
    enqueue(item = {}) {
      return enqueueItem(item)
    },

    /**
     * Queues one explicit report on every device that asked for the `reports`
     * category. An issue id, when present, is the dedupe key, so a retried
     * report replaces nothing and a repeated one coalesces like any other
     * source. The caller owns delivery: this method only fills the queue and
     * returns how many devices accepted an item.
     * @param {{title?: string, body?: string, issue?: string, url?: string}} report
     * @returns {{queued: boolean, id: string, devices: number}}
     */
    enqueueReport(report = {}) {
      let deviceCount = 0
      let firstId = ''
      try {
        const issue = typeof report.issue === 'string' ? report.issue.replace(/\s+/gu, ' ').trim() : ''
        const dedupeKey = issue.length > 0 ? `report:${issue}` : undefined
        for (const deviceId of eligibleFor('reports')) {
          const item = enqueueItem({
            deviceId,
            category: 'reports',
            title: report.title,
            body: report.body,
            url: report.url,
            dedupeKey,
          })
          if (item === null) continue
          deviceCount += 1
          if (firstId === '') firstId = item.id
        }
      } catch {
        /* a report is a convenience: a broken queue must not surface as an error */
      }
      return { queued: deviceCount > 0, id: firstId, devices: deviceCount }
    },

    /**
     * Drops every undrained item carrying this dedupe key (approval decided).
     * @returns {number} how many items were dropped.
     */
    dropByDedupe(dedupeKey) {
      if (typeof dedupeKey !== 'string' || dedupeKey.length === 0) return 0
      let dropped = 0
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index].dedupeKey !== dedupeKey) continue
        queue.splice(index, 1)
        dropped += 1
      }
      return dropped
    },

    /** Returns this device's items oldest first and clears them. */
    drain(deviceId) {
      if (typeof deviceId !== 'string' || deviceId.length === 0) return []
      pruneExpired()
      const taken = []
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index].deviceId !== deviceId) continue
        taken.unshift(queue[index])
        queue.splice(index, 1)
      }
      return taken
        .slice()
        .sort((left, right) => left.createdAt - right.createdAt)
        .map(item => ({
          id: item.id,
          category: item.category,
          title: item.title,
          body: item.body,
          url: item.url,
          createdAt: item.createdAt,
        }))
    },

    /** Queue size, for logs and tests. */
    pending(deviceId) {
      pruneExpired()
      if (typeof deviceId !== 'string' || deviceId.length === 0) return queue.length
      return queue.filter(item => item.deviceId === deviceId).length
    },

    /** Atomically replaces the settings file; the queue is never written. */
    persist() {
      const payload = { version: STATE_VERSION, devices: {} }
      for (const [deviceId, record] of devices) {
        payload.devices[deviceId] = {
          enabled: record.enabled,
          categories: { ...record.categories },
          subscription:
            record.subscription === null
              ? null
              : {
                  endpoint: record.subscription.endpoint,
                  createdAt: record.subscription.createdAt,
                  userAgent: record.subscription.userAgent,
                },
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          lastPushAt: record.lastPushAt,
          lastPushStatus: record.lastPushStatus,
          failureCount: record.failureCount,
        }
      }
      const text = `${JSON.stringify(payload, null, 2)}\n`
      const directory = dirname(stateFile)
      mkdirSync(directory, { recursive: true })
      const temporary = join(directory, `.${String(process.pid)}-${randomBytes(6).toString('hex')}.tmp`)
      try {
        writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 })
        renameSync(temporary, stateFile)
      } catch (error) {
        rmSync(temporary, { force: true })
        throw new Error(`pair notifications: cannot persist ${stateFile}: ${error.message}`)
      }
    },
  }
}

export default createNotificationStore
