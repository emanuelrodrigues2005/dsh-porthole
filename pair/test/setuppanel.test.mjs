/**
 * Contract tests for the Tailscale setup card in pair/client/client.js.
 *
 * The bundle is loaded exactly as DSH does (a distinct URL so this file gets its
 * own loader registration under `--test-isolation=none`). The panel is rendered
 * with a hand-built detection object that comes from the server's own constants
 * (`installGuidance`, `FUNNEL_POLICY_JSON`), so the card cannot drift from
 * `pair/host/setup.js`.
 *
 * Pinned here:
 *   - the stepper renders for every `needs` state, with the OS-specific install
 *     command, the admin links, the exact funnel command and the detected URL;
 *   - the copy controls copy byte-exact text (the policy JSON is compared with
 *     the server constant);
 *   - the mount read and the "Run it for me", "Use this URL" and "Check again"
 *     actions call exactly the three endpoints, with no argument of their own
 *     invention;
 *   - the four steps are cards in a responsive grid, each command is a
 *     monospace block with its own copy control, and the policy JSON is folded
 *     into a collapsed `<details>`;
 *   - a 404 from `/pair/api/setup` is a stale host process (an inline warning)
 *     while a 404 from `/pair/api/status` keeps the panel-wide message;
 *   - a fully configured machine collapses to one line and can be expanded.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_PUBLIC_GATE_PORT, FUNNEL_POLICY_JSON, installGuidance } from '../host/setup.js'
import { flush } from './helpers.mjs'

const CLIENT_MODULE_URL = new URL('../client/client.js?scope=setup-panel', import.meta.url).href
const TS_HOST = 'studio.tailnet-abc.ts.net'
const TS_URL = `https://${TS_HOST}`
/** The two absences the card must tell apart. */
const HOST_ROUTE_MISSING =
  'Pair host routes are not registered on this DSH listener. Restart the harness so the Pair plugin can load.'
const SETUP_SERVICE_MISSING =
  'The setup service is not loaded in the running host. Quit and reopen the DeepSeek Harness app (a window reload is not enough) to load it.'

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

/**
 * The panel's hook order, so a test can inject one state by position:
 *   0 status, 1 statusError, 2 actionError, 3 pending, 4 copiedKey, 5 now,
 *   6 hostView, 7 pushConfig, 8 pushError, 9 pushBusy, 10 pushDenied,
 *   11 setup, 12 setupError, 13 setupBusy, 14 setupOutput, 15 setupExpanded
 */
const HOOK_COUNT = 16

function createFakeRequire(stateValues, { runEffects = false, cleanups = [], setterCalls = [] } = {}) {
  const required = []
  let hookIndex = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol.for('react.fragment'),
    useState: initial => {
      const index = hookIndex
      const value = hookIndex < stateValues.length
        ? stateValues[hookIndex]
        : typeof initial === 'function'
          ? initial()
          : initial
      hookIndex += 1
      return [value, next => setterCalls.push({ index, value: next })]
    },
    useEffect: effect => {
      if (!runEffects) return
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
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
  let currentSlot = null
  const slots = {
    inject(name, callback) {
      const previous = currentSlot
      currentSlot = name
      try {
        callback()
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
        entries.splice(entries.indexOf(entry), 1)
      }
    },
  }
  return { ctx: { slots, effect: callback => callback(), on: () => () => {} }, entries }
}

const READY_STATUS = {
  state: 'ready',
  url: TS_URL,
  pairUrl: `${TS_URL}/pair/${'A'.repeat(43)}`,
  matrix: [[true]],
  expiresAt: Date.now() + 60_000,
  devices: [],
  stable: true,
}

const DOCS = {
  setupUrl: 'https://tailscale.com/download',
  adminDnsUrl: 'https://login.tailscale.com/admin/dns',
  adminAclUrl: 'https://login.tailscale.com/admin/acls/file',
  funnelDocsUrl: 'https://tailscale.com/kb/1223/funnel',
}

/** A detection object built from the server's own install table. */
function detection(overrides = {}) {
  const platform = overrides.platform ?? 'win32'
  const installed = overrides.installed ?? false
  const running = overrides.running ?? installed
  const funnelOn = overrides.funnelOn ?? false
  const matched = overrides.matched ?? false
  const publicUrl = overrides.publicUrl ?? ''
  const port = overrides.port ?? DEFAULT_PUBLIC_GATE_PORT
  const suggestedUrl = overrides.suggestedUrl === undefined ? TS_URL : overrides.suggestedUrl
  return {
    ok: true,
    platform,
    os: installGuidance(platform),
    tailscale: {
      installed,
      version: installed ? '1.68.1' : null,
      running,
      dnsName: suggestedUrl === null ? null : TS_HOST,
      suggestedUrl,
      tailscaleIPs: installed ? ['100.101.102.103'] : [],
      binary: installed ? 'tailscale' : null,
    },
    funnel: {
      on: funnelOn,
      url: funnelOn ? TS_URL : null,
      targetPort: funnelOn ? port : null,
      matchesGatePort: matched,
    },
    config: {
      gatePort: overrides.gatePort ?? port,
      effectiveGatePort: port,
      publicUrl,
      autoStart: true,
      cloudflaredPath: '',
      cloudflaredPresent: false,
      cloudflaredVerified: false,
    },
    needs: overrides.needs ?? ['install'],
    docs: DOCS,
    policy: { json: FUNNEL_POLICY_JSON, acl: '{"grants":[]}\n' },
  }
}

function stateValuesFor({ setup, status = READY_STATUS, expanded = false, setupError = null, setupBusy = null, setupOutput = null, statusError = null, hostView = true } = {}) {
  const values = new Array(HOOK_COUNT).fill(null)
  values[0] = status
  values[1] = statusError
  values[4] = null
  values[5] = 0
  values[6] = hostView
  values[9] = false
  values[10] = false
  values[11] = setup ?? null
  values[12] = setupError
  values[13] = setupBusy
  values[14] = setupOutput
  values[15] = expanded
  return values
}

function renderPanel(options, { runEffects = false } = {}) {
  const registration = loads[0]
  assert.ok(registration, 'the bundle did not call window.__ModuleLoader__.load()')
  const cleanups = []
  const setterCalls = []
  const exported = registration.factory(createFakeRequire(stateValuesFor(options), { runEffects, cleanups, setterCalls }))
  const fake = createFakeClientContext()
  exported.apply(fake.ctx)
  const panel = fake.entries.find(entry => entry.options.name === 'main')
  assert.ok(panel, 'no main panel registration')
  const element = panel.component({})
  return {
    element,
    setterCalls,
    dispose() {
      while (cleanups.length > 0) {
        const cleanup = cleanups.pop()
        try {
          cleanup()
        } catch {
          /* a half-mounted panel is still a mounted panel */
        }
      }
    },
  }
}

/** Renders the panel and returns only its element tree. */
function panelElement(options, extras) {
  return renderPanel(options, extras).element
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

function texts(node) {
  return collectElements(node).map(element => textContent(element))
}

function buttons(node) {
  return collectElements(node).filter(element => element.type === 'button')
}

function links(node) {
  return collectElements(node).filter(element => element.type === 'a')
}

/** Installs a fetch double and a clipboard double for the duration of a test. */
async function withBrowser(handlers, callback) {
  const restores = []
  const install = (name, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    restores.push(() => {
      if (descriptor === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, descriptor)
    })
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  const calls = []
  const copied = []
  install('fetch', async (url, init) => {
    calls.push({ url, init })
    return handlers(url, init)
  })
  install('navigator', {
    clipboard: {
      async writeText(value) {
        copied.push(value)
      },
    },
    onLine: true,
  })
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => 0
  try {
    return await callback({ calls, copied })
  } finally {
    globalThis.setTimeout = originalSetTimeout
    for (const restore of restores.reverse()) restore()
  }
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    },
    async text() {
      return JSON.stringify(payload)
    },
  }
}

/** Awaits every queued microtask and immediate handler the panel may start. */
async function settle() {
  await flush()
  await flush()
  await flush()
}

/* ------------------------------------------------------------------------- *
 * The stepper, per OS and per state
 * ------------------------------------------------------------------------- */

test('the install step renders the Windows winget command with a copy control and a download link', () => {
  const panel = panelElement({ setup: detection({ platform: 'win32' }) })
  const all = texts(panel)
  const elements = collectElements(panel)

  assert.ok(all.some(text => text.includes('winget install --id Tailscale.Tailscale -e')), 'the winget command must be visible')
  const copy = elements.find(element => element.type === 'button' && element.props['aria-label'] === 'Copy the winget install command')
  assert.ok(copy, 'the install command must have its own copy control')
  assert.equal(copy.type, 'button')
  const download = links(panel).find(link => link.props.href === 'https://tailscale.com/download')
  assert.ok(download, 'the download link must be offered')
  assert.equal(download.props.target, '_blank')
  assert.match(String(download.props.rel), /noopener/u)
  assert.ok(all.some(text => /Install Tailscale/u.test(text)), 'the step must be titled')
  assert.ok(all.some(text => /To do/u.test(text)), 'an unfinished step must say so in words, not only in colour')
})

test('the install step renders the macOS Homebrew cask and the App Store link', () => {
  const panel = panelElement({ setup: detection({ platform: 'darwin' }) })

  assert.ok(texts(panel).some(text => text.includes('brew install --cask tailscale')))
  assert.ok(links(panel).some(link => /apps\.apple\.com/u.test(String(link.props.href))))
})

test('the install step renders the Linux install script', () => {
  const panel = panelElement({ setup: detection({ platform: 'linux' }) })

  assert.ok(texts(panel).some(text => text.includes('curl -fsSL https://tailscale.com/install.sh | sh')))
})

test('an installed and running machine shows the version and the funnel command for the configured port', () => {
  const setup = detection({ installed: true, running: true, needs: ['https', 'funnel-policy', 'funnel-run'] })
  const panel = panelElement({ setup })
  const all = texts(panel)

  assert.ok(all.some(text => /Installed · v1\.68\.1/u.test(text)), `the version must be shown; got ${all.join(' | ')}`)
  assert.ok(all.some(text => text.includes(`tailscale funnel --bg ${String(DEFAULT_PUBLIC_GATE_PORT)}`)), 'the funnel command must name the configured port')
  const copy = buttons(panel).find(button => String(button.props['aria-label'] ?? '').includes('tailscale funnel --bg'))
  assert.ok(copy, 'the funnel command must have a copy control')
  assert.ok(links(panel).some(link => link.props.href === DOCS.adminDnsUrl), 'the HTTPS admin link must be offered')
  assert.ok(links(panel).some(link => link.props.href === DOCS.adminAclUrl), 'the ACL admin link must be offered')
})

test('the policy block is shown and copied byte-exact', async () => {
  const setup = detection({ installed: true, running: true, needs: ['funnel-policy', 'funnel-run'] })
  const panel = panelElement({ setup })
  assert.ok(texts(panel).some(text => text === FUNNEL_POLICY_JSON), 'the nodeAttrs block must be rendered verbatim')

  const copy = buttons(panel).find(button => button.props['aria-label'] === 'Copy the Funnel policy JSON')
  assert.ok(copy, 'the policy block must have a copy control')

  await withBrowser(
    async () => jsonResponse(setup),
    async ({ copied }) => {
      copy.props.onClick()
      await settle()
      assert.deepEqual(copied, [FUNNEL_POLICY_JSON], 'the copied policy must be byte-exact')
    },
  )
})

test('"Run it for me" calls POST /pair/api/setup/funnel and sends no argument', async () => {
  const setup = detection({ installed: true, running: true, needs: ['funnel-run'] })
  const panel = panelElement({ setup })
  const runButton = buttons(panel).find(button => /run it for me/i.test(textContent(button)))
  assert.ok(runButton, 'the funnel step must offer to run the command')

  await withBrowser(
    async url => {
      if (url === '/pair/api/setup/funnel') {
        return jsonResponse({ ok: true, output: 'Funnel started on studio.tailnet-abc.ts.net', port: 8791, status: { ...setup, needs: ['apply'] } })
      }
      return jsonResponse(READY_STATUS)
    },
    async ({ calls }) => {
      runButton.props.onClick()
      await settle()
      const funnelCalls = calls.filter(call => call.url === '/pair/api/setup/funnel')
      assert.equal(funnelCalls.length, 1)
      assert.equal(funnelCalls[0].init.method, 'POST')
      assert.equal(funnelCalls[0].init.body, '{}', 'the panel must not send an argument for the fixed command')
    },
  )
})

test('a stored funnel output is rendered as status text', () => {
  const setup = detection({ installed: true, running: true, needs: ['apply'] })
  const panel = panelElement({ setup, setupOutput: 'Available on the internet: https://studio.tailnet-abc.ts.net' })
  const output = collectElements(panel).find(element => element.type === 'pre')

  assert.ok(output, 'the funnel output must be visible')
  assert.match(textContent(output), /Available on the internet/u)
  assert.equal(output.props.role, 'status')
})

test('the apply step shows the detected URL and calls /pair/api/setup/apply with exactly that URL', async () => {
  const setup = detection({ installed: true, running: true, funnelOn: true, matched: true, needs: ['apply'] })
  const panel = panelElement({ setup })
  assert.ok(texts(panel).some(text => text === TS_URL), 'the detected URL must be visible')

  const applyButton = buttons(panel).find(button => textContent(button) === 'Use this URL')
  assert.ok(applyButton, 'the apply step must offer "Use this URL"')

  await withBrowser(
    async url => {
      if (url === '/pair/api/setup/apply') return jsonResponse({ ...setup, config: { ...setup.config, publicUrl: TS_URL }, needs: ['done'] })
      return jsonResponse(READY_STATUS)
    },
    async ({ calls }) => {
      applyButton.props.onClick()
      await settle()
      const applyCalls = calls.filter(call => call.url === '/pair/api/setup/apply')
      assert.equal(applyCalls.length, 1)
      assert.equal(applyCalls[0].init.method, 'POST')
      assert.deepEqual(JSON.parse(applyCalls[0].init.body), { publicUrl: TS_URL })
      assert.equal(applyCalls[0].init.headers['content-type'], 'application/json')
    },
  )
})

test('"Check again" re-reads /pair/api/setup', async () => {
  const setup = detection({ installed: true, running: true, needs: ['apply'] })
  const panel = panelElement({ setup })
  const checkButton = buttons(panel).find(button => /check again/i.test(textContent(button)))
  assert.ok(checkButton, 'the card must offer a re-check')

  await withBrowser(
    async () => jsonResponse(setup),
    async ({ calls }) => {
      checkButton.props.onClick()
      await settle()
      assert.equal(calls.filter(call => call.url === '/pair/api/setup').length, 1)
      assert.equal(calls[0].init.method, 'GET')
    },
  )
})

test('the card reads /pair/api/setup once when the host panel mounts', async () => {
  await withBrowser(
    async () => jsonResponse(detection({ installed: true, running: true, needs: ['apply'] })),
    async ({ calls }) => {
      const mounted = renderPanel({ setup: null }, { runEffects: true })
      await settle()
      const setupCalls = calls.filter(call => call.url === '/pair/api/setup')
      assert.equal(setupCalls.length, 1, 'mounting the host panel must read the detection exactly once')
      assert.equal(setupCalls[0].init.method, 'GET')
      mounted.dispose()
    },
  )
})

test('the card renders a useful body for every needs state', () => {
  const cases = [
    { needs: ['install'], setup: detection({ needs: ['install'] }), expect: /winget/u },
    { needs: ['up'], setup: detection({ installed: true, running: false, needs: ['up'] }), expect: /Run the funnel/u },
    { needs: ['https', 'funnel-policy', 'funnel-run'], setup: detection({ installed: true, running: true, needs: ['https', 'funnel-policy', 'funnel-run'] }), expect: /Enable HTTPS/u },
    { needs: ['funnel-run'], setup: detection({ installed: true, running: true, needs: ['funnel-run'] }), expect: /Run the funnel/u },
    { needs: ['apply'], setup: detection({ installed: true, running: true, funnelOn: true, matched: true, needs: ['apply'] }), expect: /Use this URL/u },
  ]
  for (const item of cases) {
    const all = texts(panelElement({ setup: item.setup })).join('\n')
    assert.match(all, item.expect, `needs ${item.needs.join(',')} must render`)
    assert.ok(all.includes('Tailscale setup'), `needs ${item.needs.join(',')} must keep the card title`)
  }
})

/* ------------------------------------------------------------------------- *
 * Collapse
 * ------------------------------------------------------------------------- */

test('a fully configured machine collapses to one line and expands on demand', () => {
  const setup = detection({
    installed: true,
    running: true,
    funnelOn: true,
    matched: true,
    publicUrl: TS_URL,
    needs: ['done'],
  })

  const collapsed = panelElement({ setup })
  const collapsedText = textContent(collapsed)
  assert.ok(
    collapsedText.includes(`Tailscale ready — ${TS_URL}`),
    `a done state must collapse to one line; got ${collapsedText}`,
  )
  assert.ok(!collapsedText.includes('winget install'), 'a collapsed card must not render the steps')
  const expand = buttons(collapsed).find(button => /show steps/i.test(textContent(button)))
  assert.ok(expand)
  assert.equal(expand.props['aria-expanded'], false)

  const expanded = panelElement({ setup, expanded: true })
  const expandedText = textContent(expanded)
  assert.match(expandedText, /Install Tailscale/u, 'an expanded card must show the steps')
  const collapse = buttons(expanded).find(button => /hide steps/i.test(textContent(button)))
  assert.ok(collapse)
  assert.equal(collapse.props['aria-expanded'], true)
})

test('a partially configured machine never collapses', () => {
  const all = textContent(panelElement({
    setup: detection({ installed: true, running: true, funnelOn: true, matched: true, needs: ['apply'] }),
  }))

  assert.ok(!all.includes('Tailscale ready —'), 'only a done state collapses')
  assert.match(all, /Install Tailscale/u)
})

/* ------------------------------------------------------------------------- *
 * Accessibility and structure
 * ------------------------------------------------------------------------- */

test('the stepper is an ordered list of headed steps with a non-colour status', () => {
  const setup = detection({ installed: true, running: true, needs: ['apply'] })
  const elements = collectElements(panelElement({ setup }))

  const list = elements.find(element => element.type === 'ol')
  assert.ok(list, 'the steps must be an ordered list: it is a sequence')
  const items = elements.filter(element => element.type === 'li')
  assert.equal(items.length, 4, 'four steps: install, enable, run, apply')
  const headings = elements.filter(element => element.type === 'h3')
  assert.equal(headings.length, 4)
  for (const item of items) {
    const number = collectElements(item.children[0]).find(element => element.props['aria-hidden'] === 'true')
    assert.ok(number, 'the number is decoration; the words carry the state')
  }
  const stateWords = texts(panelElement({ setup })).filter(text => text === 'Done' || text === 'To do')
  assert.ok(stateWords.length >= 4, 'every step states Done or To do in words')
})

test('the card keeps the phone and agent hints', () => {
  const all = textContent(panelElement({
    setup: detection({ installed: true, running: true, needs: ['apply'] }),
  }))

  assert.match(all, /Install app/u, 'the PWA install note must stay')
  assert.match(all, /pair_setup_status/u, 'the agent hint must name the tool')
  assert.match(all, /docs\/AI-SETUP\.md/u, 'the agent hint must point at the AI protocol doc')
})

test('the status badges name each fact instead of relying on colour', () => {
  const setup = detection({ installed: true, running: true, funnelOn: true, matched: false, needs: ['funnel-run'] })
  const all = textContent(panelElement({ setup }))

  for (const label of ['installed', 'running', 'funnel', 'matched']) {
    assert.ok(all.includes(`✓ ${label}`) || all.includes(`× ${label}`), `the ${label} badge must be present`)
  }
  assert.ok(all.includes('× matched'), 'a mismatched funnel must be stated in words')
  assert.ok(all.includes('✓ installed'), 'an installed CLI must be stated in words')
})

test('a missing detection still renders the card while loading', () => {
  const all = textContent(panelElement({ setup: null }))

  assert.match(all, /Tailscale setup/u)
  assert.match(all, /Checking Tailscale/u)
})

/* ------------------------------------------------------------------------- *
 * Layout: the steps are cards in a responsive grid
 * ------------------------------------------------------------------------- */

test('the four steps sit in a responsive grid of step cards', () => {
  const elements = collectElements(panelElement({
    setup: detection({ installed: true, running: true, needs: ['apply'] }),
  }))

  const grid = elements.find(element => element.type === 'ol')
  assert.ok(grid, 'the steps must stay a list: it is a sequence')
  assert.equal(grid.props.style.display, 'grid', 'the steps must be laid out as a grid')
  assert.equal(grid.props.style.gridTemplateColumns, 'repeat(auto-fit, minmax(260px, 1fr))')
  assert.equal(grid.props.style.gap, '12px')

  const cards = elements.filter(element => element.type === 'li')
  assert.equal(cards.length, 4)
  for (const card of cards) {
    assert.equal(card.props.style.display, 'flex', 'each step is a card, not a bare row')
    assert.match(String(card.props.style.border), /^1px solid /u, 'each step card carries the panel border')
  }
})

test('each step card puts its number, title and state chip on one row', () => {
  const elements = collectElements(panelElement({
    setup: detection({ installed: true, running: true, needs: ['apply'] }),
  }))

  for (const card of elements.filter(element => element.type === 'li')) {
    const head = card.children[0]
    assert.ok(head, 'a step card must open with its header row')
    const parts = collectElements(head)
    const number = parts.find(element => element.props['aria-hidden'] === 'true')
    const heading = parts.find(element => element.type === 'h3')
    const chip = parts.find(element => textContent(element) === 'Done' || textContent(element) === 'To do')
    assert.ok(number && heading && chip, 'the number, the title and the state chip share the header row')
  }
})

test('the header states what is missing, or the URL everything is ready for', () => {
  const missing = textContent(panelElement({ setup: detection({ needs: ['install'] }) }))
  assert.match(missing, /Needs: install/u, 'an unfinished setup must say what is left')

  const ready = detection({
    installed: true,
    running: true,
    funnelOn: true,
    matched: true,
    publicUrl: TS_URL,
    needs: ['done'],
  })
  const readyText = textContent(panelElement({ setup: ready, expanded: true }))
  assert.ok(readyText.includes(`Ready · ${TS_URL}`), `a done setup must show the ready URL; got ${readyText}`)
  assert.ok(buttons(panelElement({ setup: ready })).some(button => /check again/i.test(textContent(button))))
})

test('every command is a monospace block with its own copy control', () => {
  const panel = panelElement({ setup: detection({ platform: 'win32', needs: ['install'] }) })
  const codes = collectElements(panel).filter(element => element.type === 'code')
  assert.ok(codes.length >= 4, `install, funnel, policy and URL must all be commands; got ${String(codes.length)}`)
  for (const code of codes) {
    assert.match(String(code.props.style.fontFamily), /monospace/u, 'a copied value must be monospaced')
  }

  const labels = buttons(panel)
    .map(button => button.props['aria-label'])
    .filter(label => typeof label === 'string' && label.startsWith('Copy '))
  assert.equal(labels.length, codes.length, 'each command block carries exactly one copy control')
  assert.equal(new Set(labels).size, labels.length, 'each copy control names its own command')
})

test('the policy JSON is folded into a collapsed details block', () => {
  const elements = collectElements(panelElement({
    setup: detection({ installed: true, running: true, needs: ['funnel-policy', 'funnel-run'] }),
  }))

  const details = elements.find(element => element.type === 'details')
  assert.ok(details, 'the policy JSON must not dominate the step card')
  assert.equal(details.props.open, undefined, 'the policy JSON starts collapsed')
  const summary = collectElements(details).find(element => element.type === 'summary')
  assert.equal(textContent(summary), 'Show the policy JSON')
  assert.ok(textContent(details).includes(FUNNEL_POLICY_JSON), 'the folded block keeps the JSON byte-exact')
  const copy = collectElements(details).find(element => element.type === 'button')
  assert.equal(copy.props['aria-label'], 'Copy the Funnel policy JSON')
})

/* ------------------------------------------------------------------------- *
 * Two absences, two answers: a stale host versus a missing plugin
 * ------------------------------------------------------------------------- */

test('a 404 from the setup route records the stale-host message, not the missing-plugin one', async () => {
  await withBrowser(
    async url => (url === '/pair/api/setup' ? jsonResponse({ error: 'not found' }, 404) : jsonResponse(READY_STATUS)),
    async () => {
      const mounted = renderPanel({ setup: null }, { runEffects: true })
      await settle()
      const recorded = mounted.setterCalls.filter(call => call.index === 12).pop()
      assert.ok(recorded, 'a setup 404 must be recorded as a setup error')
      assert.equal(recorded.value, SETUP_SERVICE_MISSING, 'a 404 setup route means the host process is old, not the plugin missing')
      mounted.dispose()
    },
  )
})

test('a setup 404 next to a healthy status warns inline and never raises the global banner', () => {
  const panel = panelElement({ setup: null, setupError: SETUP_SERVICE_MISSING })
  const elements = collectElements(panel)
  const text = textContent(panel)

  assert.ok(text.includes(SETUP_SERVICE_MISSING), `the stale-host warning must be exact; got ${text}`)
  assert.ok(!text.includes(HOST_ROUTE_MISSING), 'a stale host process is not a missing plugin')
  assert.ok(!text.includes('The panel keeps retrying the status endpoint'), 'the panel-wide state is reserved for a 404 status route')

  const warning = elements.find(element => element.props.role === 'alert')
  assert.ok(warning, 'the warning must be announced')
  assert.equal(textContent(warning), SETUP_SERVICE_MISSING)
  assert.equal(warning.props.style.border, '1px solid #c78100', 'a warning, not an error')

  // Everything else on the panel keeps working.
  assert.match(text, /Paired devices/u)
  assert.match(text, /Reconnect now/u)
  assert.match(text, /Pairing link/u)
  assert.match(text, /Start pairing|Stop/u)
})

test('a 404 on the status route keeps the panel-wide message and hides the setup card', () => {
  const panel = panelElement({ setup: null, status: null, statusError: HOST_ROUTE_MISSING })
  const text = textContent(panel)

  assert.ok(text.includes(HOST_ROUTE_MISSING), 'a 404 status route still means the host routes are not registered')
  assert.match(text, /restart the harness once the Pair host plugin is available/u)
  assert.ok(!text.includes('Tailscale setup'), 'the full-panel state must not render the card')
})

test('the setup card stays host-only: the phone view renders none of it', () => {
  const text = textContent(panelElement({ setup: detection({ needs: ['install'] }), hostView: false }))

  assert.ok(!text.includes('Tailscale setup'), 'the setup card is host-only')
  assert.ok(!text.includes('winget install'), 'the phone must not see install commands')
  assert.match(text, /Pair controls are host-only/u)
})
