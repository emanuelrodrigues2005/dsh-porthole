/**
 * Contract tests for the push cards in pair/client/client.js (S3):
 *
 * - the phone card in the non-host view: unsupported / blocked / denied /
 *   default / subscribed, and the enable flow (register worker → ask permission
 *   → subscribe with the gate's VAPID key → POST the subscription);
 * - the operator card in the device list: four category switches per device and
 *   a "Send test" button driving the host-only routes.
 *
 * The bundle is loaded exactly as DSH does. The module is imported with a
 * distinct URL so this file gets its own loader registration even when the whole
 * suite runs in one process (`--test-isolation=none`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const CLIENT_MODULE_URL = new URL('../client/client.js?scope=push-panel', import.meta.url).href
const SW_PATH = '/dsh-pair-sw.js'
const VAPID_PUBLIC_KEY = Buffer.from(
  Uint8Array.from([0x04, ...new Array(64).fill(7)]),
).toString('base64url')

const loads = []
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      loads.push(registration)
    },
  },
}
try {
  await import(CLIENT_MODULE_URL)
} finally {
  delete globalThis.window
}

function createFakeRequire({ stateValues = [] } = {}) {
  const required = []
  let hookIndex = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol.for('react.fragment'),
    useState: initial => {
      const value = hookIndex < stateValues.length
        ? stateValues[hookIndex]
        : typeof initial === 'function'
          ? initial()
          : initial
      hookIndex += 1
      return [value, () => {}]
    },
    useEffect: () => {},
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  }
  const require = id => {
    required.push(id)
    if (id === 'react') return React
    if (id === 'react/jsx-runtime') {
      return { jsx: React.createElement, jsxs: React.createElement, Fragment: React.Fragment }
    }
    throw new Error(`the pair client bundle must not require "${id}" at factory time`)
  }
  require.required = required
  return require
}

function createFakeClientContext() {
  const entries = []
  const cleanups = []
  let currentSlot = null
  const slots = {
    inject(name, callback) {
      const previous = currentSlot
      currentSlot = name
      try {
        const result = callback()
        if (typeof result === 'function') cleanups.push(result)
      } finally {
        currentSlot = previous
      }
      return () => {}
    },
    register(options, component) {
      const entry = { options, component, slot: currentSlot, disposed: false }
      entries.push(entry)
      return () => {
        entry.disposed = true
        const index = entries.indexOf(entry)
        if (index >= 0) entries.splice(index, 1)
      }
    },
  }
  const ctx = {
    slots,
    effect(callback) {
      const result = callback()
      if (typeof result === 'function') cleanups.push(result)
      return result
    },
    on() {
      return () => {}
    },
  }
  return { ctx, entries }
}

function loadExports(options) {
  const registration = loads[0]
  assert.ok(registration, 'the bundle did not call window.__ModuleLoader__.load()')
  return registration.factory(createFakeRequire(options))
}

function collectElements(node, result = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return result
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, result)
    return result
  }
  if (typeof node === 'object' && node.type !== undefined && node.props !== undefined) {
    result.push(node)
    collectElements(node.children, result)
  }
  return result
}

function textContent(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  return textContent(node.children)
}

const PHONE_LOCATION = {
  hostname: 'brave-river-mango.trycloudflare.com',
  origin: 'https://brave-river-mango.trycloudflare.com',
  href: 'https://brave-river-mango.trycloudflare.com/',
}

const SUBSCRIBED_CONFIG = {
  deviceId: 'device-1',
  vapidPublicKey: VAPID_PUBLIC_KEY,
  enabled: true,
  categories: { approvals: true, questions: true, completion: true, reports: false },
  subscription: { host: 'fcm.googleapis.com', createdAt: 1_763_000_000_000 },
}

/**
 * Installs fake globals for one callback and restores every previous value.
 * `undefined` means "delete the global".
 */
async function withGlobals(values, callback) {
  const restores = []
  for (const [name, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    restores.push(() => {
      if (descriptor === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, descriptor)
    })
    if (value === undefined) delete globalThis[name]
    else Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  try {
    return await callback()
  } finally {
    for (const restore of restores.reverse()) restore()
  }
}

/**
 * Renders the panel and returns the phone card's element tree.
 * The state hook order in PairPanel is: status, statusError, actionError,
 * pending, copied, now, hostView, pushConfig, pushError, pushBusy, pushDenied.
 */
function renderPhoneCard({ config = null, denied = false, values = {} } = {}) {
  const exported = loadExports({
    stateValues: [null, null, null, null, false, 0, false, config, null, false, denied],
  })
  const fake = createFakeClientContext()
  exported.apply(fake.ctx)
  const panel = fake.entries.find(entry => entry.options.name === 'main')
  assert.ok(panel, 'no main panel registration')
  const tree = panel.component({})
  const elements = collectElements(tree)
  const card = elements.find(element => typeof element.type === 'function' && element.type.name === 'PhonePushCard')
  assert.ok(card, 'the phone view must render the notifications card')
  return {
    card,
    elements,
    rendered: collectElements(card.type({ ...card.props, ...values })),
    panel,
    fake,
  }
}

function findButton(elements, pattern) {
  return elements.find(element => element.type === 'button' && pattern.test(textContent(element)))
}

function findCheckbox(elements, label) {
  return elements.find(
    element =>
      element.type === 'input' &&
      element.props.type === 'checkbox' &&
      element.props['aria-label'] === label,
  )
}

/* ------------------------------------------------------------------------- *
 * Phone card states
 * ------------------------------------------------------------------------- */

test('the phone card explains an unsupported browser instead of offering a dead button', async () => {
  await withGlobals(
    {
      location: PHONE_LOCATION,
      navigator: { onLine: true },
      Notification: undefined,
      PushManager: undefined,
    },
    async () => {
      const { rendered } = renderPhoneCard()
      const text = textContent({ children: rendered })
      assert.match(text, /Notifications/)
      assert.match(text, /cannot receive push notifications/)
      assert.equal(findButton(rendered, /enable notifications/i), undefined, 'no dead enable button')
    },
  )
})

test('the phone card reports a blocked permission', async () => {
  await withGlobals(
    {
      location: PHONE_LOCATION,
      navigator: { onLine: true, serviceWorker: { register: async () => ({}) } },
      Notification: { permission: 'denied', requestPermission: async () => 'denied' },
      PushManager: function PushManager() {},
    },
    async () => {
      const { rendered } = renderPhoneCard()
      const text = textContent({ children: rendered })
      assert.match(text, /blocked/)
      assert.match(text, /site settings/i)
      assert.equal(findButton(rendered, /enable notifications/i), undefined)
    },
  )
})

test('the phone card offers Enable notifications in the default state', async () => {
  await withGlobals(
    {
      location: PHONE_LOCATION,
      navigator: { onLine: true, serviceWorker: { register: async () => ({}) } },
      Notification: { permission: 'default', requestPermission: async () => 'granted' },
      PushManager: function PushManager() {},
    },
    async () => {
      const { rendered } = renderPhoneCard()
      assert.ok(findButton(rendered, /enable notifications/i), 'the default state must offer the enable button')
      assert.match(textContent({ children: rendered }), /approval, a question or a turn/)
    },
  )
})

test('the subscribed phone card shows its category switches and the test/turn-off controls', async () => {
  await withGlobals(
    {
      location: PHONE_LOCATION,
      navigator: { onLine: true, serviceWorker: { register: async () => ({}) } },
      Notification: { permission: 'granted', requestPermission: async () => 'granted' },
      PushManager: function PushManager() {},
    },
    async () => {
      const { rendered } = renderPhoneCard({ config: SUBSCRIBED_CONFIG })

      assert.match(textContent({ children: rendered }), /Notifications are on/)
      assert.ok(findButton(rendered, /^send test$/i), 'a subscribed phone can send itself a test')
      assert.ok(findButton(rendered, /turn off/i), 'a subscribed phone can turn notifications off')
      assert.equal(findButton(rendered, /enable notifications/i), undefined)

      const checkboxes = rendered.filter(element => element.type === 'input' && element.props.type === 'checkbox')
      assert.equal(checkboxes.length, 4, 'one switch per category')
      assert.deepEqual(
        checkboxes.map(element => element.props.checked),
        [true, true, true, false],
        'the switches mirror the stored categories',
      )
    },
  )
})

test('the enable flow registers the worker, subscribes with a Uint8Array key and posts the endpoint', async () => {
  const calls = []
  const subscription = {
    toJSON() {
      return { endpoint: 'https://fcm.googleapis.com/wp/phone', keys: { p256dh: 'p', auth: 'a' } }
    },
  }
  const subscribeOptions = []
  const registerCalls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url) === '/pair/self/push/config') {
      return { ok: true, status: 200, async json() { return SUBSCRIBED_CONFIG } }
    }
    return { ok: true, status: 200, async json() { return { ok: true } } }
  }
  const navigatorFake = {
    onLine: true,
    serviceWorker: {
      async register(url, options) {
        registerCalls.push({ url, options })
        return {
          pushManager: {
            async subscribe(options2) {
              subscribeOptions.push(options2)
              return subscription
            },
          },
        }
      },
      async ready() {
        return { pushManager: { subscribe: async () => subscription } }
      },
    },
  }

  await withGlobals(
    {
      location: PHONE_LOCATION,
      navigator: navigatorFake,
      Notification: { permission: 'default', requestPermission: async () => 'granted' },
      PushManager: function PushManager() {},
      atob: value => Buffer.from(value, 'base64').toString('binary'),
      fetch: fakeFetch,
    },
    async () => {
      const { rendered } = renderPhoneCard({ config: { ...SUBSCRIBED_CONFIG, subscription: null } })
      assert.equal(calls.length, 0, 'rendering must not perform any request')

      const enable = findButton(rendered, /enable notifications/i)
      assert.ok(enable, 'no enable button to click')
      await enable.props.onClick()

      assert.deepEqual(registerCalls, [{ url: SW_PATH, options: { scope: '/', updateViaCache: 'none' } }])
      assert.equal(subscribeOptions.length, 1)
      assert.equal(subscribeOptions[0].userVisibleOnly, true)
      const key = subscribeOptions[0].applicationServerKey
      assert.ok(key instanceof Uint8Array, 'applicationServerKey must be converted to raw bytes')
      assert.equal(key.length, 65, 'the VAPID key is the 65-byte uncompressed point')
      assert.equal(key[0], 0x04)
      assert.deepEqual([...key.subarray(1, 5)], [7, 7, 7, 7])

      const subscribe = calls.find(call => call.url === '/pair/self/push/subscribe')
      assert.ok(subscribe, 'the subscription must be posted to the gate')
      assert.equal(subscribe.init.method, 'POST')
      const body = JSON.parse(subscribe.init.body)
      assert.equal(body.endpoint, 'https://fcm.googleapis.com/wp/phone')
    },
  )
})

test('a refused permission leaves a denied explanation and does not subscribe', async () => {
  const subscribeCalls = []
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return { ok: true, status: 200, async json() { return { ok: true } } }
  }

  await withGlobals(
    {
      location: PHONE_LOCATION,
      navigator: {
        onLine: true,
        serviceWorker: {
          async register() {
            return {
              pushManager: {
                async subscribe() {
                  subscribeCalls.push('subscribe')
                  return { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/wp/x' }) }
                },
              },
            }
          },
        },
      },
      Notification: { permission: 'default', requestPermission: async () => 'denied' },
      PushManager: function PushManager() {},
      fetch: fakeFetch,
    },
    async () => {
      const { rendered } = renderPhoneCard({ config: { ...SUBSCRIBED_CONFIG, subscription: null } })
      await findButton(rendered, /enable notifications/i).props.onClick()

      assert.deepEqual(subscribeCalls, [], 'a refused prompt must not subscribe')
      assert.deepEqual(calls, [], 'a refused prompt must not post a subscription')
    },
  )
})

test('the denied state renders its own explanation and still offers a retry', async () => {
  await withGlobals(
    {
      location: PHONE_LOCATION,
      navigator: { onLine: true, serviceWorker: { register: async () => ({}) } },
      Notification: { permission: 'default', requestPermission: async () => 'denied' },
      PushManager: function PushManager() {},
    },
    async () => {
      const { rendered } = renderPhoneCard({ config: null, denied: true })
      assert.match(textContent({ children: rendered }), /refused the notification permission/)
      assert.ok(findButton(rendered, /enable notifications/i), 'the retry path stays available')
    },
  )
})

/* ------------------------------------------------------------------------- *
 * Operator card
 * ------------------------------------------------------------------------- */

const STATUS_WITH_DEVICE = {
  state: 'ready',
  url: 'https://brave-river-mango.trycloudflare.com',
  expiresAt: 1_763_000_600_000,
  pairUrl: 'https://brave-river-mango.trycloudflare.com/pair/AAAA',
  matrix: [[true]],
  devices: [
    {
      id: 'device-1',
      name: 'phone',
      createdAt: 1_763_000_000_000,
      lastSeenAt: 1_763_000_100_000,
      notifications: {
        deviceId: 'device-1',
        enabled: true,
        categories: { approvals: true, questions: true, completion: true, reports: true },
        subscription: { host: 'fcm.googleapis.com', createdAt: 1_763_000_000_000 },
        lastPushAt: 0,
        lastPushStatus: 0,
        failureCount: 0,
      },
    },
  ],
}

test('the operator device row carries the four category switches and Send test', async () => {
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      async text() {
        return '{}'
      },
      async json() {
        return STATUS_WITH_DEVICE
      },
    }
  }

  await withGlobals({ fetch: fakeFetch }, async () => {
    const exported = loadExports({ stateValues: [STATUS_WITH_DEVICE] })
    const fake = createFakeClientContext()
    exported.apply(fake.ctx)
    const panel = fake.entries.find(entry => entry.options.name === 'main')
    const elements = collectElements(panel.component({}))

    const labels = ['Approvals', 'Questions', 'Completion', 'Reports']
    const switches = elements.filter(element => element.type === 'input' && element.props.type === 'checkbox')
    assert.equal(switches.length, labels.length, 'one switch per category per device')
    assert.ok(switches.every(element => element.props.checked !== false), 'all categories are on by default')
    assert.match(textContent({ children: elements }), /push · fcm\.googleapis\.com/)

    const test = findButton(elements, /^send test$/i)
    assert.ok(test, 'the operator needs a Send test button')

    await switches[3].props.onChange()
    const toggle = calls.find(call => call.url === '/pair/api/devices/notifications')
    assert.ok(toggle, 'a category switch must call the operator route')
    assert.deepEqual(JSON.parse(toggle.init.body), { deviceId: 'device-1', categories: { reports: false } })

    calls.length = 0
    await test.props.onClick()
    const runTest = calls.find(call => call.url === '/pair/api/push/test')
    assert.ok(runTest, 'Send test must call the operator test route')
    assert.deepEqual(JSON.parse(runTest.init.body), { deviceId: 'device-1' })
  })
})

test('the operator row marks a device without a subscription', async () => {
  const unsubscribed = {
    ...STATUS_WITH_DEVICE,
    devices: [
      {
        ...STATUS_WITH_DEVICE.devices[0],
        notifications: {
          ...STATUS_WITH_DEVICE.devices[0].notifications,
          subscription: null,
          categories: { approvals: false, questions: true, completion: true, reports: true },
        },
      },
    ],
  }
  const exported = loadExports({ stateValues: [unsubscribed] })
  const fake = createFakeClientContext()
  exported.apply(fake.ctx)
  const panel = fake.entries.find(entry => entry.options.name === 'main')
  const elements = collectElements(panel.component({}))

  assert.match(textContent({ children: elements }), /push · not subscribed/)
  const switches = elements.filter(element => element.type === 'input' && element.props.type === 'checkbox')
  assert.deepEqual(switches.map(element => element.props.checked), [false, true, true, true])
})
