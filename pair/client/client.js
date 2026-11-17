/**
 * Pair — DSH Web client bundle (browser half).
 *
 * Loaded by the DSH client module table as plain text:
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * The factory is pure: no window, document, storage or network access. All
 * network traffic starts from useEffect inside the rendered components, and
 * the only module required from the table is `react`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-porthole',
  factory(require) {
    const React = require('react')
    const { useEffect, useState } = React
    const h = React.createElement

    const STATUS_ENDPOINT = '/pair/api/status'
    const START_ENDPOINT = '/pair/api/start'
    const STOP_ENDPOINT = '/pair/api/stop'
    const REISSUE_ENDPOINT = '/pair/api/reissue'
    const REVOKE_ENDPOINT = '/pair/api/revoke'
    // Push: the phone owns its own settings under `/pair/self/push/*`, the
    // operator drives a device through the host-only `/pair/api/*` routes.
    const PUSH_CONFIG_ENDPOINT = '/pair/self/push/config'
    const PUSH_SETTINGS_ENDPOINT = '/pair/self/push/settings'
    const PUSH_SUBSCRIBE_ENDPOINT = '/pair/self/push/subscribe'
    const PUSH_UNSUBSCRIBE_ENDPOINT = '/pair/self/push/unsubscribe'
    const PUSH_TEST_ENDPOINT = '/pair/self/push/test'
    const DEVICE_NOTIFICATIONS_ENDPOINT = '/pair/api/devices/notifications'
    const OPERATOR_TEST_ENDPOINT = '/pair/api/push/test'
    // Tailscale setup: one read, one validated write, one fixed command.
    const SETUP_ENDPOINT = '/pair/api/setup'
    const SETUP_APPLY_ENDPOINT = '/pair/api/setup/apply'
    const SETUP_FUNNEL_ENDPOINT = '/pair/api/setup/funnel'
    const SERVICE_WORKER_URL = '/dsh-pair-sw.js'
    const CATEGORY_LABELS = [
      ['approvals', 'Approvals'],
      ['questions', 'Questions'],
      ['completion', 'Completion'],
      ['reports', 'Reports'],
    ]
    const POLL_INTERVAL_MS = 2000
    /** Set by apply(); the panel's "Reconnect now" button calls it. */
    let requestReconnect = () => {}
    const HOST_ROUTE_MISSING =
      'Pair host routes are not registered on this DSH listener. Restart the harness so the Pair plugin can load.'
    /**
     * A narrower absence than HOST_ROUTE_MISSING: the operator routes answer but
     * the setup routes are 404. That means the host process predates them — a
     * window reload only restarts the renderer, not the host that owns the
     * routes — so the copy names the one action that actually fixes it.
     */
    const SETUP_SERVICE_MISSING =
      'The setup service is not loaded in the running host. Quit and reopen the DeepSeek Harness app (a window reload is not enough) to load it.'
    const OFF_LOOPBACK_NOTE =
      'Pair controls are only available on the machine running the harness. Open the DSH GUI from 127.0.0.1 (or localhost) on that machine.'

    const S = {
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      spread: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      title: { margin: 0, fontSize: '14px', fontWeight: 600, letterSpacing: '0.01em' },
      muted: { opacity: 0.7, fontSize: '12px' },
      badge: {
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        border: '1px solid currentColor',
      },
      button: {
        padding: '4px 10px',
        borderRadius: '6px',
        border: '1px solid currentColor',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        opacity: 0.9,
      },
      primary: { fontWeight: 600 },
      link: {
        color: 'inherit',
        wordBreak: 'break-all',
        textDecoration: 'underline',
        textDecorationThickness: '1px',
        fontSize: '12px',
      },
      card: {
        border: '1px solid rgba(127,127,127,0.35)',
        borderRadius: '8px',
        padding: '10px',
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      },
      qr: {
        display: 'block',
        width: '100%',
        maxWidth: '220px',
        height: 'auto',
        margin: '0 auto',
        background: '#ffffff',
        borderRadius: '4px',
      },
      error: {
        border: '1px solid #d9534f',
        color: '#d9534f',
        borderRadius: '6px',
        padding: '6px 8px',
        fontSize: '12px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      /** Amber, not red: the setup service is absent, nothing is broken. */
      warning: {
        border: '1px solid #c78100',
        color: '#c78100',
        borderRadius: '6px',
        padding: '6px 8px',
        fontSize: '12px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      deviceColumn: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '6px 0', borderTop: '1px solid rgba(127,127,127,0.2)' },
      switch: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', opacity: 0.85 },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '11px', opacity: 0.75 },
      main: { padding: '24px', overflowY: 'auto', minHeight: '100%', boxSizing: 'border-box', color: 'inherit' },
      mainInner: { maxWidth: '560px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '14px' },
      intro: { margin: 0, opacity: 0.8 },
      // Tailscale setup. The four steps are cards in a responsive grid, so a
      // wide panel reads them side by side and a narrow one stacks them. The
      // monospace face is reserved for the commands, the detected URL and the
      // policy JSON — the only text here a person copies verbatim.
      stepGrid: {
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: '12px',
      },
      step: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        minWidth: 0,
        padding: '8px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,0.28)',
        background: 'rgba(127,127,127,0.05)',
      },
      dot: {
        flex: '0 0 auto',
        width: '18px',
        height: '18px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '10px',
        fontWeight: 600,
        lineHeight: 1,
      },
      dotDone: { borderColor: '#2e9e5b', color: '#2e9e5b' },
      stepBody: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' },
      stepHead: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      stepTitle: { margin: 0, fontSize: '13px', fontWeight: 600, flex: '1 1 auto', minWidth: 0 },
      stepState: { fontSize: '11px', opacity: 0.7 },
      /** The Done/To do chip: the word carries the state, the border repeats it. */
      stateChip: {
        flex: '0 0 auto',
        marginLeft: 'auto',
        padding: '1px 7px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,0.45)',
        fontSize: '10px',
        fontWeight: 600,
        opacity: 0.8,
      },
      stateDone: { borderColor: '#2e9e5b', color: '#2e9e5b', opacity: 1 },
      /** Collapsed policy JSON: it is reference text, not a step of its own. */
      details: { margin: 0 },
      summary: { cursor: 'pointer', fontSize: '12px', opacity: 0.85, width: 'fit-content' },
      /** One line of "what is left": Ready · <url>, or Needs: install, up, … */
      summaryText: { fontSize: '12px', opacity: 0.75, minWidth: 0, wordBreak: 'break-word' },
      commandRow: { display: 'flex', alignItems: 'flex-start', gap: '6px' },
      command: {
        flex: '1 1 auto',
        minWidth: 0,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '11px',
        padding: '5px 7px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.3)',
        background: 'rgba(127,127,127,0.10)',
        whiteSpace: 'pre-wrap',
        // In a 260 px step card a command has to wrap; prefer a break at the
        // spaces, and only split a long token (a URL, the policy JSON) when the
        // line genuinely cannot fit.
        overflowWrap: 'anywhere',
      },
      iconButton: {
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '26px',
        height: '26px',
        padding: 0,
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.45)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        opacity: 0.85,
      },
      output: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '11px',
        margin: 0,
        padding: '6px 8px',
        borderRadius: '6px',
        border: '1px solid rgba(127,127,127,0.3)',
        background: 'rgba(127,127,127,0.10)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: '160px',
        overflowY: 'auto',
      },
      hint: { margin: 0, fontSize: '11px', opacity: 0.65 },
      linkRow: { display: 'flex', gap: '10px', flexWrap: 'wrap' },
      badges: { display: 'flex', gap: '4px', flexWrap: 'wrap' },
    }

    const STATE_LABELS = { off: 'Off', starting: 'Starting', ready: 'Ready', error: 'Error' }
    const STATE_COLORS = { off: 'currentColor', starting: '#c78100', ready: '#2e9e5b', error: '#d9534f' }

    function formatDuration(milliseconds) {
      const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000))
      const minutes = Math.floor(totalSeconds / 60)
      const seconds = totalSeconds % 60
      return `${String(minutes)}:${String(seconds).padStart(2, '0')}`
    }

    function formatTimestamp(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown'
      try {
        return new Date(value).toLocaleString()
      } catch {
        return 'unknown'
      }
    }

    function statusState(status) {
      return status !== null && typeof status.state === 'string' ? status.state : 'off'
    }

    /**
     * A fast hint only. The harness listener is loopback, so a loopback page is
     * certainly the host view; any other origin may still be the host (custom
     * loopback alias, desktop shell) and is confirmed by probing the operator
     * route once. The gate answers 404 there, so a tunnel page stays a notice.
     */
    function isLoopbackOrigin() {
      try {
        if (typeof location === 'undefined') return true
        const hostname = String(location.hostname ?? '').replace(/^\[|\]$/gu, '').toLowerCase()
        return hostname.length === 0 || hostname === 'localhost' || hostname.startsWith('127.') || hostname === '::1'
      } catch {
        return true
      }
    }

    /** Short origin label for the remote notice, so support sees the real one. */
    function originLabel() {
      try {
        if (typeof location === 'undefined') return 'unknown origin'
        const origin = String(location.origin ?? '')
        return origin.length > 0 && origin !== 'null' ? origin : String(location.href ?? 'unknown origin')
      } catch {
        return 'unknown origin'
      }
    }

    function isMatrix(value) {
      return (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(row => Array.isArray(row) && row.length === value.length)
      )
    }

    /**
     * base64url → Uint8Array. `PushManager.subscribe()` wants the VAPID key as
     * raw bytes, while the gate publishes it as an unpadded base64url string.
     * Nothing here runs at factory time.
     */
    function base64urlToUint8Array(value) {
      const text = String(value ?? '').replace(/-/gu, '+').replace(/_/gu, '/')
      if (text.length === 0) return new Uint8Array(0)
      const padded = text.length % 4 === 0 ? text : text + '='.repeat(4 - (text.length % 4))
      let binary = ''
      try {
        binary = typeof atob === 'function' ? atob(padded) : ''
      } catch {
        binary = ''
      }
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return bytes
    }

    /** Push support is a browser fact, read at render/handler time only. */
    function notificationSupport() {
      try {
        if (typeof Notification === 'undefined') return false
        if (typeof PushManager === 'undefined') return false
        if (typeof navigator === 'undefined' || navigator.serviceWorker === undefined) return false
        return typeof navigator.serviceWorker.register === 'function'
      } catch {
        return false
      }
    }

    function notificationPermission() {
      try {
        return typeof Notification !== 'undefined' && typeof Notification.permission === 'string'
          ? Notification.permission
          : 'default'
      } catch {
        return 'default'
      }
    }

    /**
     * The five phone states from the accepted design, in priority order:
     * unsupported → blocked → subscribed → denied (a refused prompt) → default.
     */
    function phoneNotificationState(config, denied) {
      if (!notificationSupport()) return 'unsupported'
      if (notificationPermission() === 'denied') return 'blocked'
      const subscribed =
        config !== null &&
        typeof config === 'object' &&
        config.subscription !== null &&
        config.subscription !== undefined
      if (subscribed) return 'subscribed'
      if (denied === true) return 'denied'
      return 'default'
    }

    const NOTIFICATION_STATE_TEXT = {
      unsupported:
        'This browser cannot receive push notifications. On iOS, add DSH to the home screen first, then open it from there.',
      blocked:
        'Notifications are blocked for this site. Allow them in the browser site settings, then reload this page.',
      denied: 'The browser refused the notification permission. Allow notifications for this site and try again.',
      default:
        'Get a notification on this phone when an approval, a question or a turn needs you. The push itself is empty; the text is fetched from this harness.',
      subscribed: 'Notifications are on for this phone. Each push is empty and the text is fetched from this harness.',
    }

    /**
     * The phone card. It is rendered only in the phone view; every handler is a
     * user gesture (a permission prompt outside one is refused by the browser).
     */
    function PhonePushCard(props) {
      const state = typeof props.state === 'string' ? props.state : 'default'
      const config = props.config !== null && typeof props.config === 'object' ? props.config : null
      const busy = props.busy === true
      const error = typeof props.error === 'string' && props.error.length > 0 ? props.error : null
      const categories = config !== null && config.categories !== null && typeof config.categories === 'object'
        ? config.categories
        : null
      const canEnable = state === 'default' || state === 'denied'
      return h(
        'div',
        { style: S.card, 'data-pair-push': state },
        h('h2', { style: { ...S.title, fontSize: '14px', margin: 0 } }, 'Notifications'),
        h('p', { style: { ...S.muted, margin: 0 } }, NOTIFICATION_STATE_TEXT[state] ?? NOTIFICATION_STATE_TEXT.default),
        error !== null ? h('div', { style: S.error, role: 'alert' }, error) : null,
        state === 'subscribed' && categories !== null
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
              CATEGORY_LABELS.map(([name, label]) =>
                h(
                  'label',
                  { key: name, style: S.switch },
                  h('input', {
                    type: 'checkbox',
                    checked: categories[name] === true,
                    disabled: busy,
                    onChange: () => props.onCategory(name, categories[name] !== true),
                  }),
                  ` ${label}`,
                ),
              ),
            )
          : null,
        h(
          'div',
          { style: S.row },
          canEnable
            ? h(
                'button',
                {
                  type: 'button',
                  style: { ...S.button, ...S.primary },
                  disabled: busy,
                  onClick: () => props.onEnable(),
                },
                busy ? 'Working…' : 'Enable notifications',
              )
            : null,
          state === 'subscribed'
            ? h(
                'button',
                { type: 'button', style: S.button, disabled: busy, onClick: () => props.onTest() },
                'Send test',
              )
            : null,
          state === 'subscribed'
            ? h(
                'button',
                { type: 'button', style: S.button, disabled: busy, onClick: () => props.onDisable() },
                'Turn off',
              )
            : null,
        ),
      )
    }

    /** One switch per category for a place in the operator device list. */
    function categorySwitches(device, busy, onToggle) {
      const settings = device !== null && typeof device === 'object' && device.notifications !== null && typeof device.notifications === 'object'
        ? device.notifications
        : null
      const categories = settings !== null && settings.categories !== null && typeof settings.categories === 'object'
        ? settings.categories
        : {}
      return h(
        'div',
        { style: { ...S.row, gap: '10px' } },
        CATEGORY_LABELS.map(([name, label]) =>
          h(
            'label',
            { key: name, style: S.switch },
            h('input', {
              type: 'checkbox',
              checked: categories[name] !== false,
              disabled: busy,
              onChange: () => onToggle(name, categories[name] === false),
            }),
            ` ${label}`,
          ),
        ),
      )
    }

    async function readResponseError(response) {
      let text = ''
      try {
        text = await response.text()
      } catch {
        text = ''
      }
      if (text.length > 0) {
        try {
          const parsed = JSON.parse(text)
          if (parsed !== null && typeof parsed === 'object' && typeof parsed.error === 'string') {
            return parsed.error
          }
        } catch {
          /* plain-text server error */
        }
        return text
      }
      return `Request failed with status ${String(response.status)}`
    }

    async function readStatusResponse(response) {
      if (response.status === 404) throw new Error(HOST_ROUTE_MISSING)
      if (!response.ok) throw new Error(await readResponseError(response))
      const payload = await response.json()
      if (payload === null || typeof payload !== 'object') throw new Error('Invalid status payload from the pair plugin')
      return payload
    }

    /**
     * Copy through the Clipboard API, with a hidden-textarea fallback for a
     * browser that refuses it (an insecure origin, a denied permission). Never
     * throws: the caller only learns whether the text landed.
     */
    function copyText(text) {
      const value = String(text ?? '')
      return new Promise(resolve => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined
            && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard
              .writeText(value)
              .then(() => resolve(true))
              .catch(() => resolve(copyTextFallback(value)))
            return
          }
        } catch {
          /* fall through to the legacy path */
        }
        resolve(copyTextFallback(value))
      })
    }

    /** The pre-Clipboard-API path, kept for a browser that refuses the modern one. */
    function copyTextFallback(value) {
      try {
        if (typeof document === 'undefined' || document === null || document.body === null) return false
        const area = document.createElement('textarea')
        area.value = value
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        document.body.appendChild(area)
        let copied = false
        try {
          area.select()
          copied = typeof document.execCommand === 'function' && document.execCommand('copy') === true
        } finally {
          document.body.removeChild(area)
        }
        return copied
      } catch {
        return false
      }
    }

    /** The copy affordance: an icon button whose accessible name is its action. */
    function copyGlyph() {
      return h(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': 'true' },
        h('rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }),
        h('path', { d: 'M5 15V5a2 2 0 0 1 2-2h8' }),
      )
    }

    /** The confirmation glyph, so a copy is not colour-only feedback. */
    function checkGlyph() {
      return h(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, 'aria-hidden': 'true' },
        h('path', { d: 'M4 12.5 9 17.5 20 6.5' }),
      )
    }

    function qrElement(matrix, label) {
      if (!isMatrix(matrix)) {
        return h('p', { style: S.muted }, 'QR code is not available yet. Create a new ticket to refresh it.')
      }
      const margin = 4
      const size = matrix.length
      const dimension = size + margin * 2
      const children = [h('rect', { key: 'bg', x: 0, y: 0, width: dimension, height: dimension, fill: '#ffffff' })]
      for (let row = 0; row < size; row += 1) {
        for (let column = 0; column < size; column += 1) {
          if (!matrix[row][column]) continue
          children.push(
            h('rect', {
              key: `${String(row)}-${String(column)}`,
              x: column + margin,
              y: row + margin,
              width: 1,
              height: 1,
              fill: '#000000',
            }),
          )
        }
      }
      return h(
        'svg',
        {
          style: S.qr,
          viewBox: `0 0 ${String(dimension)} ${String(dimension)}`,
          shapeRendering: 'crispEdges',
          role: 'img',
          'aria-label': label ?? 'Pairing QR code',
        },
        children,
      )
    }

    function StateBadge({ state }) {
      return h(
        'span',
        {
          style: {
            ...S.badge,
            color: STATE_COLORS[state] ?? 'currentColor',
            borderColor: STATE_COLORS[state] ?? 'currentColor',
          },
        },
        STATE_LABELS[state] ?? state,
      )
    }

    function PairIcon(props) {
      const size = props !== null && typeof props === 'object' && typeof props.size === 'number' ? props.size : 20
      const cells = [
        [3, 3],
        [14, 3],
        [3, 14],
        [17, 17],
        [17, 10],
        [10, 17],
        [10, 10],
      ]
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'square',
          'aria-hidden': 'true',
        },
        h('rect', { x: 2.5, y: 2.5, width: 7, height: 7, rx: 1 }),
        h('rect', { x: 14.5, y: 2.5, width: 7, height: 7, rx: 1 }),
        h('rect', { x: 2.5, y: 14.5, width: 7, height: 7, rx: 1 }),
        cells.map(([x, y]) => h('rect', { key: `${String(x)}-${String(y)}`, x, y, width: 2, height: 2, fill: 'currentColor', stroke: 'none' })),
      )
    }

    function PairPanel() {
      const [status, setStatus] = useState(null)
      const [statusError, setStatusError] = useState(null)
      const [actionError, setActionError] = useState(null)
      const [pending, setPending] = useState(null)
      /** Which copy control last succeeded, so each one confirms on its own. */
      const [copiedKey, setCopiedKey] = useState(null)
      const [now, setNow] = useState(0)
      // The origin is a hint; the operator route is the authority. A page served
      // from a non-loopback origin (desktop shell alias, custom hostname) still
      // gets the controls when `/pair/api/status` answers, which the tunnel-side
      // gate never does.
      const [hostView, setHostView] = useState(isLoopbackOrigin())
      // Push, phone side: the config comes from the gate under the device
      // cookie and `denied` is the transient result of a refused prompt.
      const [pushConfig, setPushConfig] = useState(null)
      const [pushError, setPushError] = useState(null)
      const [pushBusy, setPushBusy] = useState(false)
      const [pushDenied, setPushDenied] = useState(false)
      // Tailscale setup. Detection runs four fixed `tailscale` commands, so it is
      // read on mount and on demand — never on the two-second status poll.
      const [setup, setSetup] = useState(null)
      const [setupError, setSetupError] = useState(null)
      /** `'apply'` or `'funnel'` while that one action is in flight. */
      const [setupBusy, setSetupBusy] = useState(null)
      /** The bounded output of the last `tailscale funnel --bg` run. */
      const [setupOutput, setSetupOutput] = useState(null)
      const [setupExpanded, setSetupExpanded] = useState(false)

      async function loadStatus(signal) {
        try {
          const response = await fetch(STATUS_ENDPOINT, {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
            signal,
          })
          const payload = await readStatusResponse(response)
          setStatus(payload)
          setStatusError(null)
        } catch (error) {
          if (error !== null && typeof error === 'object' && error.name === 'AbortError') return
          setStatus(null)
          setStatusError(error instanceof Error ? error.message : String(error))
        }
      }

      useEffect(() => {
        if (hostView) return undefined
        let disposed = false
        const controller = new AbortController()
        fetch(STATUS_ENDPOINT, {
          method: 'GET',
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        })
          .then(async response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return readStatusResponse(response)
          })
          .then(payload => {
            if (disposed) return
            setStatus(payload)
            setStatusError(null)
            setHostView(true)
          })
          .catch(error => {
            if (disposed) return
            setStatusError(error instanceof Error ? error.message : String(error))
          })
        return () => {
          disposed = true
          controller.abort()
        }
      }, [hostView])

      useEffect(() => {
        if (!hostView) return undefined
        let disposed = false
        const controller = new AbortController()
        const poll = () => {
          if (disposed) return
          void loadStatus(controller.signal)
        }
        poll()
        const timer = setInterval(poll, POLL_INTERVAL_MS)
        return () => {
          disposed = true
          clearInterval(timer)
          controller.abort()
        }
      }, [hostView])

      useEffect(() => {
        if (!hostView) return undefined
        const tick = () => setNow(Date.now())
        tick()
        const timer = setInterval(tick, 1000)
        return () => clearInterval(timer)
      }, [hostView])

      // The phone view polls nothing, but it does read its push settings once.
      useEffect(() => {
        if (hostView) return undefined
        let disposed = false
        const controller = new AbortController()
        loadPushConfig(controller.signal).catch(() => {})
        return () => {
          disposed = true
          controller.abort()
        }
        // `disposed` is intentionally unused: loadPushConfig guards its own
        // setState calls through the abort signal.
        void disposed
      }, [hostView])

      /**
       * Reads the Tailscale detection object. It answers with the setup service's
       * single stable shape, so the panel never derives a rule of its own.
       */
      async function loadSetup(signal) {
        try {
          const response = await fetch(SETUP_ENDPOINT, {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
            signal,
          })
          if (response.status === 404) throw new Error(SETUP_SERVICE_MISSING)
          if (!response.ok) throw new Error(await readResponseError(response))
          const payload = await response.json()
          if (payload === null || typeof payload !== 'object' || !Array.isArray(payload.needs)) {
            throw new Error('Invalid setup payload from the pair plugin')
          }
          setSetup(payload)
          setSetupError(null)
          return payload
        } catch (error) {
          if (error !== null && typeof error === 'object' && error.name === 'AbortError') return null
          setSetupError(error instanceof Error ? error.message : String(error))
          return null
        }
      }

      useEffect(() => {
        if (!hostView) return undefined
        const controller = new AbortController()
        void loadSetup(controller.signal)
        return () => controller.abort()
      }, [hostView])

      /**
       * Writes a validated setup patch (public URL / gate port / autoStart) and
       * restarts the gate. The route answers the fresh detection object, so the
       * stepper redraws from one response.
       */
      async function applySetup(patch) {
        if (setupBusy !== null) return
        setSetupBusy('apply')
        setSetupError(null)
        try {
          const response = await fetch(SETUP_APPLY_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(patch ?? {}),
          })
          if (response.status === 404) throw new Error(SETUP_SERVICE_MISSING)
          if (!response.ok) throw new Error(await readResponseError(response))
          const payload = await response.json()
          if (payload !== null && typeof payload === 'object' && Array.isArray(payload.needs)) setSetup(payload)
          await loadStatus()
        } catch (error) {
          setSetupError(error instanceof Error ? error.message : String(error))
        } finally {
          setSetupBusy(null)
        }
      }

      /**
       * The "Run it for me" button: the only command the panel can trigger, and
       * the server builds its argv from configuration. The output is shown
       * verbatim (already redacted and bounded by the host).
       */
      async function runSetupFunnel() {
        if (setupBusy !== null) return
        setSetupBusy('funnel')
        setSetupError(null)
        setSetupOutput(null)
        try {
          const response = await fetch(SETUP_FUNNEL_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: '{}',
          })
          if (response.status === 404) throw new Error(SETUP_SERVICE_MISSING)
          let payload = null
          try {
            payload = await response.json()
          } catch {
            payload = null
          }
          const output = payload !== null && typeof payload === 'object' && typeof payload.output === 'string'
            ? payload.output
            : ''
          if (output.length > 0) setSetupOutput(output)
          if (!response.ok) {
            const message = payload !== null && typeof payload === 'object' && typeof payload.error === 'string'
              ? payload.error
              : `Request failed with status ${String(response.status)}`
            throw new Error(message)
          }
          if (payload !== null && typeof payload === 'object' && payload.status !== null
            && typeof payload.status === 'object' && Array.isArray(payload.status.needs)) {
            setSetup(payload.status)
          }
          await loadStatus()
        } catch (error) {
          setSetupError(error instanceof Error ? error.message : String(error))
        } finally {
          setSetupBusy(null)
        }
      }

      async function loadPushConfig(signal) {
        try {
          const response = await fetch(PUSH_CONFIG_ENDPOINT, {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
            signal,
          })
          if (!response.ok) throw new Error(await readResponseError(response))
          const payload = await response.json()
          if (payload === null || typeof payload !== 'object') throw new Error('Invalid push config from the pair plugin')
          setPushConfig(payload)
          setPushError(null)
          return payload
        } catch (error) {
          if (error !== null && typeof error === 'object' && error.name === 'AbortError') return null
          setPushError(error instanceof Error ? error.message : String(error))
          return null
        }
      }

      /**
       * The enable flow, always inside the click: register the worker, ask for
       * the permission, subscribe with the gate's VAPID key, then POST the
       * subscription. Without a gesture the browser refuses the prompt.
       */
      async function enableNotifications() {
        if (pushBusy) return
        setPushBusy(true)
        setPushError(null)
        setPushDenied(false)
        try {
          if (!notificationSupport()) throw new Error(NOTIFICATION_STATE_TEXT.unsupported)
          const registration = await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
            scope: '/',
            updateViaCache: 'none',
          })
          const permission = await Notification.requestPermission()
          if (permission !== 'granted') {
            setPushDenied(true)
            return
          }
          const manager = registration !== null && typeof registration === 'object' && registration.pushManager
            ? registration.pushManager
            : (await navigator.serviceWorker.ready).pushManager
          const config = pushConfig !== null && typeof pushConfig === 'object' ? pushConfig : await loadPushConfig()
          const key = config !== null && typeof config.vapidPublicKey === 'string' ? config.vapidPublicKey : ''
          if (key.length === 0) throw new Error('The harness did not publish a VAPID key; reload the page and try again.')
          const subscription = await manager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: base64urlToUint8Array(key),
          })
          const stored = subscription !== null && typeof subscription === 'object' && typeof subscription.toJSON === 'function'
            ? subscription.toJSON()
            : subscription
          const endpoint = stored !== null && typeof stored === 'object' && typeof stored.endpoint === 'string'
            ? stored.endpoint
            : ''
          if (endpoint.length === 0) throw new Error('The browser returned an empty push subscription.')
          const response = await fetch(PUSH_SUBSCRIBE_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ endpoint, keys: stored.keys ?? undefined }),
          })
          if (!response.ok) throw new Error(await readResponseError(response))
          await loadPushConfig()
        } catch (error) {
          setPushError(error instanceof Error ? error.message : String(error))
        } finally {
          setPushBusy(false)
        }
      }

      /** Stop the browser subscription, then tell the gate; both are idempotent. */
      async function disableNotifications() {
        if (pushBusy) return
        setPushBusy(true)
        setPushError(null)
        try {
          try {
            const registration = navigator.serviceWorker.getRegistration
              ? await navigator.serviceWorker.getRegistration()
              : null
            const subscription = registration !== null && typeof registration === 'object' && registration.pushManager
              ? await registration.pushManager.getSubscription()
              : null
            if (subscription !== null && typeof subscription === 'object' && typeof subscription.unsubscribe === 'function') {
              await subscription.unsubscribe()
            }
          } catch {
            /* the browser may already have dropped it */
          }
          const response = await fetch(PUSH_UNSUBSCRIBE_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: '{}',
          })
          if (!response.ok) throw new Error(await readResponseError(response))
          await loadPushConfig()
        } catch (error) {
          setPushError(error instanceof Error ? error.message : String(error))
        } finally {
          setPushBusy(false)
        }
      }

      /** Phone-side category switch: PATCH the one category, keep the rest. */
      async function setPushCategory(category, enabled) {
        if (pushBusy) return
        setPushBusy(true)
        setPushError(null)
        try {
          const response = await fetch(PUSH_SETTINGS_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ categories: { [category]: enabled } }),
          })
          if (!response.ok) throw new Error(await readResponseError(response))
          await loadPushConfig()
        } catch (error) {
          setPushError(error instanceof Error ? error.message : String(error))
        } finally {
          setPushBusy(false)
        }
      }

      /** Ask this harness to queue one test notification for this phone. */
      async function sendPushTest() {
        if (pushBusy) return
        setPushBusy(true)
        setPushError(null)
        try {
          const response = await fetch(PUSH_TEST_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: '{}',
          })
          if (!response.ok) throw new Error(await readResponseError(response))
        } catch (error) {
          setPushError(error instanceof Error ? error.message : String(error))
        } finally {
          setPushBusy(false)
        }
      }

      async function post(endpoint, body) {
        if (pending !== null) return
        setPending(endpoint)
        setActionError(null)
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body ?? {}),
          })
          if (response.status === 404) throw new Error(HOST_ROUTE_MISSING)
          if (!response.ok) throw new Error(await readResponseError(response))
          await loadStatus()
        } catch (error) {
          setActionError(error instanceof Error ? error.message : String(error))
        } finally {
          setPending(null)
        }
      }

      /** Copies one value and confirms on the control that produced it. */
      function copyValue(key, value) {
        void copyText(value).then(copied => {
          if (!copied) return
          setCopiedKey(key)
          setTimeout(() => setCopiedKey(current => (current === key ? null : current)), 1500)
        })
      }

      /**
       * One copy control. It is an icon button on purpose: the stepper has four
       * of them, and the accessible name carries the action ("Copy the install
       * command") while the tooltip and the glyph show the confirmation.
       */
      function copyControl(key, value, label) {
        const copied = copiedKey === key
        return h(
          'button',
          {
            type: 'button',
            style: S.iconButton,
            title: copied ? 'Copied' : label,
            'aria-label': copied ? 'Copied' : label,
            onClick: () => copyValue(key, value),
          },
          copied ? checkGlyph() : copyGlyph(),
        )
      }

      /**
       * One step card: the number, the title and the Done/To do chip share a
       * row, then the explanation and the command or action span the card.
       */
      function stepRow(index, title, done, children) {
        return h(
          'li',
          { style: S.step, key: `step-${String(index)}` },
          h(
            'div',
            { style: S.stepHead },
            h(
              'span',
              {
                style: done ? { ...S.dot, ...S.dotDone } : S.dot,
                'aria-hidden': 'true',
              },
              done ? '✓' : String(index),
            ),
            h('h3', { style: S.stepTitle }, title),
            h('span', { style: done ? { ...S.stateChip, ...S.stateDone } : S.stateChip }, done ? 'Done' : 'To do'),
          ),
          children,
        )
      }

      /** A command line with its copy control. */
      function commandLine(key, value, label) {
        return h(
          'div',
          { style: S.commandRow },
          h('code', { style: S.command }, value),
          copyControl(key, value, label),
        )
      }

      /**
       * The guided Tailscale card. It reads nothing but the detection object, so
       * every OS, every state and every command is the server's answer — the
       * panel cannot drift from `pair/host/setup.js`.
       */
      function tailscaleCard(detected) {
        const view = detected !== null && typeof detected === 'object' ? detected : null
        const tall = view !== null && view.tailscale !== null && typeof view.tailscale === 'object' ? view.tailscale : null
        const funnel = view !== null && view.funnel !== null && typeof view.funnel === 'object' ? view.funnel : null
        const config = view !== null && view.config !== null && typeof view.config === 'object' ? view.config : null
        const os = view !== null && view.os !== null && typeof view.os === 'object' ? view.os : null
        const docs = view !== null && view.docs !== null && typeof view.docs === 'object' ? view.docs : null
        const policy = view !== null && view.policy !== null && typeof view.policy === 'object' ? view.policy : null
        const needs = view !== null && Array.isArray(view.needs) ? view.needs : []
        const installEntries = os !== null && Array.isArray(os.install) ? os.install : []
        const port = config !== null && Number.isSafeInteger(config.effectiveGatePort) ? config.effectiveGatePort : 8791
        const funnelCommand = `tailscale funnel --bg ${String(port)}`
        const installed = tall !== null && tall.installed === true
        const running = tall !== null && tall.running === true
        const funnelOn = funnel !== null && funnel.on === true
        const matched = funnel !== null && funnel.matchesGatePort === true
        const suggestedUrl = tall !== null && typeof tall.suggestedUrl === 'string' && tall.suggestedUrl.length > 0
          ? tall.suggestedUrl
          : null
        const configuredUrl = config !== null && typeof config.publicUrl === 'string' ? config.publicUrl : ''
        const applied = suggestedUrl !== null ? configuredUrl === suggestedUrl : configuredUrl !== ''
        const ready = needs.length === 1 && needs[0] === 'done'
        const collapsed = ready && !setupExpanded
        const busyApply = setupBusy === 'apply'
        const busyFunnel = setupBusy === 'funnel'

        const badges = [
          ['installed', installed],
          ['running', running],
          ['funnel', funnelOn],
          ['matched', matched],
        ].map(([label, ok]) =>
          h(
            'span',
            {
              key: `setup-badge-${label}`,
              style: {
                ...S.badge,
                fontSize: '10px',
                textTransform: 'none',
                letterSpacing: '0.02em',
                color: ok ? STATE_COLORS.ready : 'currentColor',
                borderColor: ok ? STATE_COLORS.ready : 'rgba(127,127,127,0.55)',
                opacity: ok ? 1 : 0.7,
              },
            },
            `${ok ? '✓' : '×'} ${label}`,
          ),
        )

        // One line the operator can read without opening the steps: what is
        // still missing, or the URL everything is ready for.
        const summary = view === null
          ? 'Checking…'
          : ready
            ? (configuredUrl.length > 0 ? `Ready · ${configuredUrl}` : 'Ready')
            : needs.length > 0
              ? `Needs: ${needs.join(', ')}`
              : 'State unknown'

        const header = h(
          'div',
          { style: S.spread },
          h(
            'div',
            { style: { ...S.row, minWidth: 0 } },
            h('h2', { style: { ...S.title, fontSize: '14px', margin: 0 } }, 'Tailscale setup'),
            h('span', { style: S.summaryText, role: 'status' }, summary),
          ),
          h(
            'button',
            {
              type: 'button',
              style: S.button,
              disabled: setupBusy !== null,
              onClick: () => {
                void loadSetup()
              },
            },
            setupBusy !== null ? 'Checking…' : 'Check again',
          ),
        )

        const body = collapsed
          ? [
              h(
                'div',
                { style: S.spread, key: 'setup-collapsed' },
                h('span', { style: { fontSize: '13px' } }, `Tailscale ready — ${configuredUrl}`),
                h(
                  'button',
                  {
                    type: 'button',
                    style: S.button,
                    'aria-expanded': false,
                    onClick: () => setSetupExpanded(true),
                  },
                  'Show steps',
                ),
              ),
            ]
          : [
              h('div', { style: S.badges, key: 'setup-badges', role: 'group', 'aria-label': 'Tailscale detection' }, badges),
              h(
                'ol',
                { style: S.stepGrid, key: 'setup-steps' },
                stepRow(
                  1,
                  'Install Tailscale',
                  installed,
                  installed
                    ? [
                        h(
                          'p',
                          { style: S.hint, key: 'installed' },
                          `Installed${tall.version ? ` · v${String(tall.version)}` : ''}${os !== null && typeof os.label === 'string' ? ` on ${os.label}` : ''}.`,
                        ),
                      ]
                    : [
                        ...installEntries.map((entry, index) => {
                          const label = typeof entry.label === 'string' ? entry.label : 'Install'
                          const command = typeof entry.command === 'string' ? entry.command : ''
                          const url = typeof entry.url === 'string' ? entry.url : ''
                          return h(
                            'div',
                            { style: S.stepBody, key: `install-${String(index)}` },
                            h('span', { style: S.stepState }, label),
                            command.length > 0
                              ? commandLine(`install-${String(index)}`, command, `Copy the ${label} install command`)
                              : null,
                            url.length > 0
                              ? h(
                                  'a',
                                  { style: S.link, href: url, target: '_blank', rel: 'noreferrer noopener' },
                                  url,
                                )
                              : null,
                          )
                        }),
                        h(
                          'p',
                          { style: S.hint, key: 'install-hint' },
                          'Install Tailscale on this machine, sign in, then press Check again.',
                        ),
                      ],
                ),
                stepRow(
                  2,
                  'Enable HTTPS + Funnel',
                  funnelOn,
                  [
                    h(
                      'div',
                      { style: S.linkRow, key: 'admin-links' },
                      docs !== null && typeof docs.adminDnsUrl === 'string'
                        ? h('a', { style: S.link, href: docs.adminDnsUrl, target: '_blank', rel: 'noreferrer noopener' }, 'Admin console → DNS (HTTPS certificates)')
                        : null,
                      docs !== null && typeof docs.adminAclUrl === 'string'
                        ? h('a', { style: S.link, href: docs.adminAclUrl, target: '_blank', rel: 'noreferrer noopener' }, 'Admin console → Access controls (ACL)')
                        : null,
                    ),
                    h(
                      'p',
                      { style: S.hint, key: 'policy-hint' },
                      'Turn on HTTPS certificates, then merge this block into your ACL file so the `funnel` node attribute is granted:',
                    ),
                    // Reference text, not a step of its own: it stays folded so
                    // it cannot dominate the card.
                    policy !== null && typeof policy.json === 'string'
                      ? h(
                          'details',
                          { style: S.details, key: 'policy-details', 'data-pair-policy': 'json' },
                          h('summary', { style: S.summary }, 'Show the policy JSON'),
                          commandLine('policy', policy.json, 'Copy the Funnel policy JSON'),
                        )
                      : null,
                    docs !== null && typeof docs.funnelDocsUrl === 'string'
                      ? h('a', { style: S.link, key: 'funnel-docs', href: docs.funnelDocsUrl, target: '_blank', rel: 'noreferrer noopener' }, 'Funnel documentation')
                      : null,
                  ],
                ),
                stepRow(
                  3,
                  'Run the funnel',
                  funnelOn && matched,
                  [
                    commandLine('funnel', funnelCommand, `Copy "${funnelCommand}"`),
                    h(
                      'div',
                      { style: S.linkRow, key: 'funnel-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          style: { ...S.button, ...S.primary },
                          disabled: setupBusy !== null,
                          onClick: () => {
                            void runSetupFunnel()
                          },
                        },
                        busyFunnel ? 'Running…' : 'Run it for me',
                      ),
                      funnelOn && typeof funnel.url === 'string'
                        ? h('span', { style: S.stepState }, `Funnel on ${funnel.url}${matched ? '' : ` → port ${String(funnel.targetPort ?? '?')} (expected ${String(port)})`}`)
                        : null,
                    ),
                    setupOutput !== null
                      ? h('pre', { style: S.output, role: 'status', 'aria-live': 'polite', key: 'funnel-output' }, setupOutput)
                      : null,
                    h(
                      'p',
                      { style: S.hint, key: 'funnel-hint' },
                      'Runs exactly that command on this machine. `--bg` keeps publishing after the terminal closes.',
                    ),
                  ],
                ),
                stepRow(
                  4,
                  'Apply the detected URL',
                  applied && ready,
                  [
                    suggestedUrl !== null
                      ? h(
                          'div',
                          { style: S.commandRow, key: 'suggested' },
                          h('code', { style: S.command }, suggestedUrl),
                          copyControl('url', suggestedUrl, 'Copy the detected Tailscale URL'),
                        )
                      : h(
                          'p',
                          { style: S.hint, key: 'no-url' },
                          'No address yet. Tailscale reports it once it is installed, running and signed in.',
                        ),
                    h(
                      'div',
                      { style: S.linkRow, key: 'apply-actions' },
                      suggestedUrl !== null
                        ? h(
                            'button',
                            {
                              type: 'button',
                              style: { ...S.button, ...S.primary },
                              disabled: setupBusy !== null || applied,
                              onClick: () => {
                                void applySetup({ publicUrl: suggestedUrl })
                              },
                            },
                            busyApply ? 'Applying…' : applied ? 'URL applied' : 'Use this URL',
                          )
                        : null,
                      configuredUrl.length > 0
                        ? h('span', { style: S.stepState }, `Configured public URL: ${configuredUrl}`)
                        : h('span', { style: S.stepState }, 'No public URL configured yet'),
                    ),
                    h(
                      'p',
                      { style: S.hint, key: 'apply-hint' },
                      'Writes the public URL to this harness and restarts the Pair gate. The pairing ticket below stays valid.',
                    ),
                  ],
                ),
              ),
              ready
                ? h(
                    'div',
                    { style: S.spread, key: 'setup-collapse' },
                    h('span', { style: S.stepState }, 'Everything is configured.'),
                    h(
                      'button',
                      {
                        type: 'button',
                        style: S.button,
                        'aria-expanded': true,
                        onClick: () => setSetupExpanded(false),
                      },
                      'Hide steps',
                    ),
                  )
                : null,
              h(
                'p',
                { style: S.hint, key: 'phone-hint' },
                'Install the app on the phone first (browser menu → Install app), then open it from the home screen so push notifications work.',
              ),
              h(
                'p',
                { style: S.hint, key: 'ai-hint' },
                'An AI can do this end to end: it calls pair_setup_status, follows docs/AI-SETUP.md shipped with this plugin, then calls pair_setup_apply.',
              ),
            ]

        /*
         * Two different absences, two different answers. `SETUP_SERVICE_MISSING`
         * is the stale-host case: the operator routes answer, so the plugin is
         * loaded, but this host process predates the setup routes. It stays an
         * inline warning inside this card and must never raise the panel-wide
         * "host routes are not registered" banner. Any other failure keeps the
         * plain error text.
         */
        const setupServiceMissing = setupError === SETUP_SERVICE_MISSING

        return h(
          'div',
          { style: S.card, 'data-pair-setup': needs.join(' ') || 'unknown' },
          header,
          setupServiceMissing
            ? h('div', { style: S.warning, role: 'alert', key: 'setup-service-missing' }, SETUP_SERVICE_MISSING)
            : setupError !== null
              ? h('div', { style: S.error, role: 'alert' }, setupError)
              : null,
          view === null && setupError === null ? h('p', { style: S.hint }, 'Checking Tailscale…') : null,
          ...body,
        )
      }

      const state = statusState(status)
      const stable = status !== null && status.stable === true
      const url = status !== null && typeof status.url === 'string' ? status.url : null
      const pairUrl = status !== null && typeof status.pairUrl === 'string' && status.pairUrl.length > 0
        ? status.pairUrl
        : null
      const devices = status !== null && Array.isArray(status.devices) ? status.devices : []
      const matrix = status !== null ? status.matrix : null
      const expiresAt = status !== null && typeof status.expiresAt === 'number' ? status.expiresAt : null
      const remaining = expiresAt !== null && now > 0 ? expiresAt - now : null
      const busy = pending !== null
      const errorMessages = [statusError, actionError, status !== null && state === 'error' ? status.message : null].filter(
        message => typeof message === 'string' && message.length > 0,
      )
      const hostRouteMissing = statusError === HOST_ROUTE_MISSING
      const phoneState = phoneNotificationState(pushConfig, pushDenied)

      if (!hostView) {
        return h(
          'div',
          { style: S.main },
          h(
            'div',
            { style: S.mainInner },
            h('div', { style: S.spread }, h('h1', { style: { ...S.title, fontSize: '20px' } }, 'Pair')),
            h(
              'p',
              { style: S.intro },
              'You are viewing the DSH GUI through the tunnel or from another machine. Pair controls are host-only, so they are hidden here.',
            ),
            h('div', { style: S.card }, h('p', { style: { margin: 0 } }, OFF_LOOPBACK_NOTE)),
            // S3: the phone owns its own notification settings; the operator
            // card below only exists on the host.
            h(PhonePushCard, {
              state: phoneState,
              config: pushConfig,
              error: pushError,
              busy: pushBusy,
              onEnable: enableNotifications,
              onDisable: disableNotifications,
              onCategory: setPushCategory,
              onTest: sendPushTest,
            }),
            statusError !== null &&
              h(
                'p',
                { style: { margin: '10px 0 0', fontSize: '12px', opacity: 0.75 } },
                `The host Pair route answered: ${String(statusError)}`,
              ),
            h(
              'p',
              { style: { margin: '10px 0 0', fontSize: '12px', opacity: 0.75 } },
              `This page is served from ${originLabel()}. Open the desktop app window (or http://127.0.0.1:<port> on the host) to manage pairing.`,
            ),
          ),
        )
      }

      if (hostRouteMissing) {
        return h(
          'div',
          { style: S.main },
          h(
            'div',
            { style: S.mainInner },
            h('div', { style: S.spread }, h('h1', { style: { ...S.title, fontSize: '20px' } }, 'Pair')),
            errorMessages.map((message, index) =>
              h('div', { key: `error-${String(index)}`, style: S.error, role: 'alert' }, message),
            ),
            h(
              'p',
              { style: { ...S.muted, margin: 0 } },
              'The panel keeps retrying the status endpoint; restart the harness once the Pair host plugin is available.',
            ),
          ),
        )
      }

      return h(
        'div',
        { style: S.main },
        h(
          'div',
          { style: S.mainInner },
          h(
            'div',
            { style: S.spread },
            h('h1', { style: { ...S.title, fontSize: '20px' } }, 'Pair'),
            h(StateBadge, { state }),
          ),
          h(
            'p',
            { style: S.intro },
            stable
              ? 'Expose this DeepSeek Harness GUI at your stable public URL. The phone pairs once with the QR code and keeps a revocable device cookie.'
              : 'Expose this DeepSeek Harness GUI to your phone through a Cloudflare quick tunnel. The phone pairs once with the QR code and keeps a revocable device cookie.',
          ),

          errorMessages.map((message, index) =>
            h('div', { key: `error-${String(index)}`, style: S.error, role: 'alert' }, message),
          ),
          h(
            'div',
            { style: { ...S.row, marginTop: '8px' } },
            h('span', { style: S.muted }, 'Connection stuck?'),
            h(
              'button',
              {
                type: 'button',
                style: S.button,
                onClick: () => {
                  try {
                    requestReconnect()
                  } catch {
                    /* a refused reconnect must not break the panel */
                  }
                },
              },
              'Reconnect now',
            ),
          ),

          /*
           * The guided setup sits above the ticket card: it is the first thing an
           * operator needs on a machine that has never published this harness.
           * It collapses to one line once Tailscale is ready and applied.
           */
          tailscaleCard(setup),

          state === 'off'
            ? h(
                'div',
                { style: S.card },
                h('p', { style: { margin: 0 } }, stable
                  ? 'Pairing is off. Start it, then scan the QR code on your phone.'
                  : 'The tunnel is off. Start it, then scan the QR code on your phone.'),
              )
            : null,
          state === 'starting'
            ? h('p', { style: { margin: 0 } }, stable
              ? 'Starting the Pair gate…'
              : 'Starting the Cloudflare tunnel… this can take up to 30 seconds.')
            : null,

          state === 'ready'
            ? h(
                'div',
                { style: S.card },
                pairUrl !== null
                  ? h(
                      'div',
                      { style: S.spread },
                      h('span', { style: S.muted }, 'Pairing link'),
                      h(
                        'button',
                        {
                          type: 'button',
                          style: S.button,
                          disabled: busy,
                          onClick: () => copyValue('pairUrl', pairUrl),
                        },
                        copiedKey === 'pairUrl' ? 'Copied' : 'Copy',
                      ),
                    )
                  : h('span', { style: S.muted }, 'No live pairing ticket'),
                pairUrl !== null
                  ? h(
                      'a',
                      { style: S.link, href: pairUrl, target: '_blank', rel: 'noreferrer noopener' },
                      pairUrl,
                    )
                  : url !== null
                    ? h('span', { style: S.code }, url)
                    : null,
                // B4: a stable public URL (Tailscale Funnel) is configured, not
                // minted by a tunnel, so operators need the bare origin itself
                // and the install step that turns the page into an app.
                stable && url !== null
                  ? h(
                      'div',
                      { style: S.spread },
                      h('span', { style: S.muted }, 'Public URL'),
                      h('span', { style: S.link }, url),
                    )
                  : null,
                stable
                  ? h(
                      'p',
                      { style: { ...S.muted, margin: 0 } },
                      "Open the browser menu and choose Install app to add this harness to your phone's home screen.",
                    )
                  : null,
                qrElement(matrix, 'Pairing QR code'),
                h(
                  'div',
                  { style: S.spread },
                  h(
                    'span',
                    { style: S.muted },
                    pairUrl === null
                      ? 'Create a new ticket to show a pairing link and QR code.'
                      : remaining === null
                        ? 'Ticket expiry unavailable'
                        : remaining <= 0
                          ? 'Ticket expired — create a new one'
                          : `Ticket expires in ${formatDuration(remaining)}`,
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: S.button,
                      disabled: busy,
                      onClick: () => post(REISSUE_ENDPOINT),
                    },
                    'New ticket',
                  ),
                ),
              )
            : null,

          h(
            'div',
            { style: S.row },
            h(
              'button',
              {
                type: 'button',
                style: { ...S.button, ...S.primary },
                disabled: busy,
                onClick: () => post(state === 'off' || state === 'error' ? START_ENDPOINT : STOP_ENDPOINT),
              },
              busy
                ? 'Working…'
                : state === 'off' || state === 'error'
                  ? 'Start pairing'
                  : 'Stop',
            ),
          ),

          h(
            'div',
            { style: S.card },
            h('h2', { style: { ...S.title, fontSize: '14px', margin: 0 } }, 'Paired devices'),
            devices.length === 0
              ? h('p', { style: { ...S.muted, margin: 0 } }, 'No devices paired yet.')
              : devices.map(device =>
                  h(
                    'div',
                    { key: String(device.id), style: S.deviceColumn },
                    h(
                      'div',
                      { style: S.row },
                      h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: '1 1 auto' } },
                        h('span', null, typeof device.name === 'string' && device.name.length > 0 ? device.name : 'Phone'),
                        h(
                          'span',
                          { style: S.code },
                          `${String(device.id).slice(0, 8)} · added ${formatTimestamp(device.createdAt)} · last seen ${formatTimestamp(device.lastSeenAt)}`,
                        ),
                        h(
                          'span',
                          { style: S.code },
                          device.notifications !== null && typeof device.notifications === 'object' && device.notifications.subscription !== null && typeof device.notifications.subscription === 'object'
                            ? `push · ${String(device.notifications.subscription.host ?? 'registered')}`
                            : 'push · not subscribed',
                        ),
                      ),
                      h(
                        'div',
                        { style: { ...S.row, justifyContent: 'flex-end' } },
                        h(
                          'button',
                          {
                            type: 'button',
                            style: S.button,
                            disabled: busy,
                            onClick: () =>
                              post(DEVICE_NOTIFICATIONS_ENDPOINT, {
                                deviceId: device.id,
                                enabled: !(device.notifications !== null && typeof device.notifications === 'object' && device.notifications.enabled === true),
                              }),
                          },
                          device.notifications !== null && typeof device.notifications === 'object' && device.notifications.enabled === true
                            ? 'Notifications on'
                            : 'Notifications off',
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            style: S.button,
                            disabled: busy,
                            onClick: () => post(OPERATOR_TEST_ENDPOINT, { deviceId: device.id }),
                          },
                          'Send test',
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            style: S.button,
                            disabled: busy,
                            onClick: () => post(REVOKE_ENDPOINT, { deviceId: device.id }),
                          },
                          'Revoke',
                        ),
                      ),
                    ),
                    categorySwitches(device, busy, (name, enabled) =>
                      post(DEVICE_NOTIFICATIONS_ENDPOINT, { deviceId: device.id, categories: { [name]: enabled } }),
                    ),
                  ),
                ),
          ),

          state === 'off' || state === 'error'
            ? h('p', { style: { ...S.muted, margin: 0 } }, stable
              ? 'While pairing is off, the gate is not listening at your public URL.'
              : 'While pairing is off, the gate is not listening and no public URL exists.')
            : null,
        ),
      )
    }

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        requestReconnect = () => {
          try {
            const connection = ctx !== null && typeof ctx === 'object' ? ctx.connection : null
            if (connection !== null && typeof connection === 'object'
              && typeof connection.reconnect === 'function') connection.reconnect()
          } catch {
            /* a refused reconnect must not break the panel */
          }
        }
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'pair', order: 30, label: 'Pair' },
            PairIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'pair' }, PairPanel),
        )

        // C1: an installed app that sat in the background lost its WebSocket.
        // Reconnect when the document becomes visible again or the page is
        // restored from the back/forward cache — once per resume, never while
        // the browser reports itself offline, and never through a missing
        // `connection` service.
        const release = installResumeListeners(ctx)
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => release)
        } else if (typeof ctx.on === 'function') {
          ctx.on('dispose', release)
        }
      },
    }

    /**
     * Registers the resume listeners and returns their remover.
     * Nothing here touches a DOM global outside the listener bodies, so a host
     * without a document (and the factory itself) stays untouched.
     */
    function installResumeListeners(ctx) {
      const view = typeof document === 'undefined' ? null : document
      const host = typeof window === 'undefined' ? null : window
      if (view === null || host === null) return () => {}

      const online = () => !(typeof navigator !== 'undefined' && navigator.onLine === false)
      /**
       * A resume only needs to force a reconnect when the transport is not
       * already healthy. The DSH client publishes its recovery state, so an
       * ordinary alt-tab on a connected page stays quiet instead of flashing
       * "connecting" on every visibility change.
       */
      const connectionState = service => {
        try {
          const source = service !== null && typeof service === 'object' ? service.state : null
          if (source !== null && typeof source === 'object' && typeof source.getSnapshot === 'function') {
            return source.getSnapshot()
          }
        } catch {
          /* an unreadable state must not block the recovery path */
        }
        return undefined
      }
      let lastVisibilityReconnectAt = 0
      const reconnect = source => {
        if (!online()) return
        // A bfcache restore fires visibilitychange and then pageshow(persisted);
        // the pageshow must not reset the connection a second time.
        if (source === 'pageshow' && Date.now() - lastVisibilityReconnectAt < 1000) return
        const connection = ctx !== null && typeof ctx === 'object' ? ctx.connection : null
        if (connection === null || typeof connection !== 'object') return
        if (typeof connection.reconnect !== 'function') return
        const state = connectionState(connection)
        if (state === 'connected' || state === 'connecting') return
        try {
          connection.reconnect()
          if (source === 'visibility') lastVisibilityReconnectAt = Date.now()
        } catch {
          /* a refused reconnect must not break the panel */
        }
      }

      let visible = view.visibilityState !== 'hidden'
      const onVisibilityChange = () => {
        const next = view.visibilityState !== 'hidden'
        if (next && !visible) reconnect('visibility')
        visible = next
      }
      // pageshow also fires on every ordinary load: only a restored page resumed
      // from the back/forward cache is a resume worth reconnecting for.
      const onPageShow = event => {
        if (event !== null && typeof event === 'object' && event.persisted === true) reconnect('pageshow')
      }
      view.addEventListener('visibilitychange', onVisibilityChange)
      host.addEventListener('pageshow', onPageShow)
      return () => {
        view.removeEventListener('visibilitychange', onVisibilityChange)
        host.removeEventListener('pageshow', onPageShow)
      }
    }
  },
})
