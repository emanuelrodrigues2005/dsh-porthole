/**
 * Contract tests for pair/client/client.js — the browser half.
 *
 * The bundle is loaded exactly like DSH loads its own client bundles:
 * window.__ModuleLoader__.load({ id, factory }). The factory must be pure (no
 * window/document) and `apply` must contribute through the injected `slots`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const CLIENT_MODULE_URL = new URL('../client/client.js', import.meta.url).href
const BUNDLE_ID = 'dsh-porthole'
const PANEL_ID = 'pair'

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
  // Nothing below may depend on `window`: the factory and apply must be pure
  // apart from the services handed to them.
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

function createFakeClientContext({ connection } = {}) {
  const entries = []
  const injectCalls = []
  const cleanups = []
  const disposeCallbacks = []
  let currentSlot = null

  const slots = {
    inject(name, callback) {
      injectCalls.push(name)
      const previous = currentSlot
      currentSlot = name
      let result
      try {
        result = callback()
      } finally {
        currentSlot = previous
      }
      if (typeof result === 'function') cleanups.push(result)
      return () => {}
    },
    register(options, component) {
      const entry = { options, component, slot: currentSlot, disposed: false }
      entries.push(entry)
      return () => {
        if (entry.disposed) return
        entry.disposed = true
        const index = entries.indexOf(entry)
        if (index >= 0) entries.splice(index, 1)
      }
    },
  }

  const ctx = {
    slots,
    ...(connection === undefined ? {} : { connection }),
    effect(callback) {
      const result = callback()
      if (typeof result === 'function') cleanups.push(result)
      return result
    },
    on(event, callback) {
      if (event === 'dispose') disposeCallbacks.push(callback)
      return () => {}
    },
  }

  return {
    ctx,
    entries,
    injectCalls,
    dispose() {
      while (cleanups.length > 0) cleanups.pop()()
      while (disposeCallbacks.length > 0) disposeCallbacks.shift()()
    },
  }
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

const TUNNEL_URL = 'https://brave-river-mango.trycloudflare.com'
const PAIR_URL = `${TUNNEL_URL}/pair/${'A'.repeat(43)}`
const READY_STATUS = {
  state: 'ready',
  url: TUNNEL_URL,
  pairUrl: PAIR_URL,
  matrix: [[true]],
  expiresAt: Date.now() + 60_000,
  devices: [],
}

test('the bundle registers dsh-porthole through window.__ModuleLoader__.load', () => {
  assert.equal(loads.length, 1)
  assert.equal(loads[0].id, BUNDLE_ID)
  assert.equal(typeof loads[0].factory, 'function')
})

test('the factory returns inject and apply without touching window or document', () => {
  const exported = loadExports()

  assert.ok(exported && typeof exported === 'object')
  assert.ok(Array.isArray(exported.inject), 'the bundle must export an inject array')
  for (const service of exported.inject) assert.equal(typeof service, 'string')
  assert.ok(exported.inject.includes('slots'))
  assert.equal(typeof exported.apply, 'function')
})

test('apply registers the pair icon in sidebar.panellist and the pair panel in main', () => {
  const exported = loadExports()
  const fake = createFakeClientContext()

  const result = exported.apply(fake.ctx)

  assert.equal(result, undefined, 'apply must return nothing; slot lifetimes own disposal')
  assert.equal(fake.entries.length, 2)

  const icon = fake.entries.find(entry => entry.options.name === 'sidebar.panellist')
  assert.ok(icon, 'no sidebar.panellist registration')
  assert.deepEqual(Object.keys(icon.options).sort(), ['id', 'label', 'name', 'order'])
  assert.equal(icon.options.id, PANEL_ID)
  assert.equal(typeof icon.options.order, 'number')
  const labelIsText = typeof icon.options.label === 'string' && icon.options.label.length > 0
  assert.ok(labelIsText || typeof icon.options.label === 'function', 'label must be text or a locale-aware function')
  assert.equal(typeof icon.component, 'function')
  assert.equal(icon.slot, 'sidebar.panellist')

  const panel = fake.entries.find(entry => entry.options.name === 'main')
  assert.ok(panel, 'no main panel registration')
  assert.deepEqual(Object.keys(panel.options).sort(), ['key', 'name'])
  assert.equal(panel.options.key, PANEL_ID)
  assert.equal(typeof panel.component, 'function')
  assert.equal(panel.slot, 'main')

  assert.deepEqual([...fake.injectCalls].sort(), ['main', 'sidebar.panellist'])
})

test('disposing the client context unregisters both slots', () => {
  const exported = loadExports()
  const fake = createFakeClientContext()
  exported.apply(fake.ctx)
  assert.equal(fake.entries.length, 2)

  fake.dispose()

  assert.equal(fake.entries.length, 0, 'disposal must remove both registrations')
})

test('apply performs no network calls', () => {
  const exported = loadExports()
  const fake = createFakeClientContext()
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = () => {
    fetchCalls += 1
    throw new Error('apply must not fetch')
  }

  try {
    exported.apply(fake.ctx)
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(fetchCalls, 0)
})

test('the ready panel shows the ticketed pairUrl and copies that exact URL', async () => {
  const exported = loadExports({ stateValues: [READY_STATUS] })
  const fake = createFakeClientContext()
  exported.apply(fake.ctx)
  const panel = fake.entries.find(entry => entry.options.name === 'main')
  assert.ok(panel, 'no main panel registration')

  const elements = collectElements(panel.component({}))

  const displayed = elements.filter(element => textContent(element) === PAIR_URL)
  assert.ok(displayed.length > 0, 'the panel must render status.pairUrl as selectable text')

  const copyButton = elements.find(element => element.type === 'button' && /copy/i.test(textContent(element)))
  assert.ok(copyButton, 'the panel must render a copy control')
  assert.equal(typeof copyButton.props.onClick, 'function', 'the copy control must have a click handler')

  const copied = []
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originalSetTimeout = globalThis.setTimeout
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        async writeText(value) {
          copied.push(value)
        },
      },
    },
  })
  // The "Copied" badge reset timer is irrelevant to this contract and would
  // keep the process alive for 1.5 s.
  globalThis.setTimeout = () => 0
  try {
    copyButton.props.onClick()
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    globalThis.setTimeout = originalSetTimeout
    if (originalNavigator === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', originalNavigator)
  }

  assert.deepEqual(copied, [PAIR_URL], 'copying must yield status.pairUrl, not the bare tunnel root')
})

/**
 * A stable public URL (Tailscale Funnel) is flagged in the status payload, so
 * the panel can tell it apart from a throwaway quick-tunnel URL.
 */
const STABLE_READY_STATUS = { ...READY_STATUS, stable: true }

test('the ready panel shows the stable public URL and an install hint', () => {
  const exported = loadExports({ stateValues: [STABLE_READY_STATUS] })
  const fake = createFakeClientContext()
  exported.apply(fake.ctx)
  const panel = fake.entries.find(entry => entry.options.name === 'main')
  assert.ok(panel, 'no main panel registration')

  const elements = collectElements(panel.component({}))

  // The stable URL is its own text: the pairing link is a different string
  // (it ends in /pair/<ticket>), and operators need the bare origin to configure
  // Tailscale Funnel against it.
  const stableUrl = elements.find(element => textContent(element) === TUNNEL_URL)
  assert.ok(stableUrl, `a stable ready panel must render status.url (${TUNNEL_URL}) as text`)

  const installHint = elements.find(element => /install app/i.test(textContent(element)))
  assert.ok(installHint, 'a stable ready panel must show an "Install app" hint next to the stable URL')
})

/* ------------------------------------------------------------------------- *
 * C1: reconnect when the installed app is resumed.
 *
 * A phone that keeps the DSH GUI in the background loses its WebSocket; coming
 * back from the app switcher must rebuild it without a manual reload. The
 * module must stay DOM-free at factory time and degrade when the host has no
 * `connection` service.
 * ------------------------------------------------------------------------- */

/** Minimal EventTarget double for `document` and `window`. */
function createFakeEventTarget() {
  const listeners = new Map()
  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(handler)
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler)
    },
    dispatch(type, event = {}) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler({ type, ...event })
    },
    count(type) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

function createFakeDom() {
  const document = createFakeEventTarget()
  document.visibilityState = 'visible'
  document.hidden = false
  const window = createFakeEventTarget()
  window.document = document
  return {
    document,
    window,
    setVisible(visible) {
      document.visibilityState = visible ? 'visible' : 'hidden'
      document.hidden = !visible
    },
  }
}

/** Installs fake document/window/navigator globals for the duration of a test. */
async function withFakeDom(dom, { online = true } = {}, callback) {
  const restores = []
  const install = (name, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    restores.push(() => {
      if (descriptor === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, descriptor)
    })
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  install('document', dom.document)
  install('window', dom.window)
  install('navigator', { onLine: online })
  try {
    return await callback()
  } finally {
    for (const restore of restores.reverse()) restore()
  }
}

test('apply reconnects once per hidden -> visible transition', async () => {
  const exported = loadExports()
  assert.ok(exported.inject.includes('connection'), "the plugin must inject the 'connection' service")

  const reconnectCalls = []
  const fake = createFakeClientContext({ connection: { reconnect: () => reconnectCalls.push('reconnect') } })
  const dom = createFakeDom()

  await withFakeDom(dom, { online: true }, async () => {
    exported.apply(fake.ctx)
    assert.ok(dom.document.count('visibilitychange') > 0, 'apply must listen for visibilitychange on document')
    assert.ok(dom.window.count('pageshow') > 0, 'apply must listen for pageshow on window')

    dom.setVisible(false)
    dom.document.dispatch('visibilitychange')
    assert.equal(reconnectCalls.length, 0, 'hiding the app must not reconnect')

    dom.setVisible(true)
    dom.document.dispatch('visibilitychange')
    assert.equal(reconnectCalls.length, 1, 'becoming visible must reconnect once')

    dom.document.dispatch('visibilitychange')
    assert.equal(reconnectCalls.length, 1, 'staying visible must not reconnect again')

    dom.setVisible(false)
    dom.document.dispatch('visibilitychange')
    dom.setVisible(true)
    dom.document.dispatch('visibilitychange')
    assert.equal(reconnectCalls.length, 2, 'each hidden -> visible transition must reconnect once')
  })
})

test('apply reconnects on pageshow when the browser is online', async () => {
  const exported = loadExports()
  const reconnectCalls = []
  const fake = createFakeClientContext({ connection: { reconnect: () => reconnectCalls.push('reconnect') } })
  const dom = createFakeDom()

  await withFakeDom(dom, { online: true }, async () => {
    exported.apply(fake.ctx)
    dom.window.dispatch('pageshow', { persisted: true })
    assert.equal(reconnectCalls.length, 1, 'a pageshow resume must reconnect once')
  })
})

test('a healthy connection is left alone on resume', async () => {
  const exported = loadExports()
  const reconnectCalls = []
  const fake = createFakeClientContext({
    connection: {
      reconnect: () => reconnectCalls.push('reconnect'),
      state: { getSnapshot: () => 'connected' },
    },
  })
  const dom = createFakeDom()

  await withFakeDom(dom, { online: true }, async () => {
    exported.apply(fake.ctx)
    dom.setVisible(false)
    dom.document.dispatch('visibilitychange')
    dom.setVisible(true)
    dom.document.dispatch('visibilitychange')
    assert.equal(reconnectCalls.length, 0, 'a connected page must not reset its transport on every resume')
  })
})

test('a disconnected connection reconnects on resume', async () => {
  const exported = loadExports()
  const reconnectCalls = []
  const fake = createFakeClientContext({
    connection: {
      reconnect: () => reconnectCalls.push('reconnect'),
      state: { getSnapshot: () => 'disconnected' },
    },
  })
  const dom = createFakeDom()

  await withFakeDom(dom, { online: true }, async () => {
    exported.apply(fake.ctx)
    dom.setVisible(false)
    dom.document.dispatch('visibilitychange')
    dom.setVisible(true)
    dom.document.dispatch('visibilitychange')
    assert.equal(reconnectCalls.length, 1, 'a stale connection must be reset when the app resumes')
  })
})

test('no reconnect happens while navigator.onLine is false', async () => {
  const exported = loadExports()
  const reconnectCalls = []
  const fake = createFakeClientContext({ connection: { reconnect: () => reconnectCalls.push('reconnect') } })
  const dom = createFakeDom()

  await withFakeDom(dom, { online: false }, async () => {
    exported.apply(fake.ctx)

    dom.setVisible(false)
    dom.document.dispatch('visibilitychange')
    dom.setVisible(true)
    dom.document.dispatch('visibilitychange')
    assert.equal(reconnectCalls.length, 0, 'an offline app must not reconnect on resume')

    dom.window.dispatch('pageshow')
    assert.equal(reconnectCalls.length, 0, 'an offline app must not reconnect on pageshow')
  })
})

test('dispose removes the resume listeners', async () => {
  const exported = loadExports()
  const reconnectCalls = []
  const fake = createFakeClientContext({ connection: { reconnect: () => reconnectCalls.push('reconnect') } })
  const dom = createFakeDom()

  await withFakeDom(dom, { online: true }, async () => {
    exported.apply(fake.ctx)
    fake.dispose()

    assert.equal(dom.document.count('visibilitychange'), 0, 'dispose must remove the visibilitychange listener')
    assert.equal(dom.window.count('pageshow'), 0, 'dispose must remove the pageshow listener')

    dom.setVisible(false)
    dom.document.dispatch('visibilitychange')
    dom.setVisible(true)
    dom.document.dispatch('visibilitychange')
    dom.window.dispatch('pageshow')
    assert.equal(reconnectCalls.length, 0, 'a disposed plugin must never reconnect')
  })
})

test('a missing connection service is tolerated', async () => {
  const exported = loadExports()
  const fake = createFakeClientContext()
  const dom = createFakeDom()

  await withFakeDom(dom, { online: true }, async () => {
    assert.doesNotThrow(() => exported.apply(fake.ctx), 'apply must not require the connection service')

    dom.setVisible(false)
    dom.document.dispatch('visibilitychange')
    dom.setVisible(true)
    dom.document.dispatch('visibilitychange')
    dom.window.dispatch('pageshow')
  })
})
