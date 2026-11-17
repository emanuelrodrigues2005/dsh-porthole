# Pair — phone access to this DeepSeek Harness GUI

Pair puts a **Pair** panel in the left sidebar of the DSH web UI. It opens a
Cloudflare quick tunnel in front of a loopback-only gate, shows a single-use QR
code, and lets you revoke each paired phone. Set `publicUrl` instead and the same
gate sits behind a **stable** public origin served by your own reverse proxy
(Tailscale Funnel), with no cloudflared at all.

The panel leads with a **Tailscale setup** card: it detects the CLI, shows the
per-OS install command, links the HTTPS and `funnel` policy pages, copies the
exact ACL block, runs `tailscale funnel --bg <port>` on request, detects the
resulting `https://<machine>.<tailnet>.ts.net` URL and applies it by writing
`$DSH_HOME/pair/config.json` and restarting the gate — no harness restart. The
full procedure is [SETUP-TAILSCALE.md](SETUP-TAILSCALE.md); the agent protocol is
[AI-SETUP.md](AI-SETUP.md).

It also ships the phone experience: the installed app is a PWA, and Web Push
tickles the phone when the agent needs an approval, asks a question, finishes a
turn, or calls the `pair_notify_report` tool.

## What it does

```
phone --https--> <random>.trycloudflare.com   (Cloudflare edge, TLS)
      --http-->  127.0.0.1:<gatePort>         (this plugin's gate)
      --http-->  127.0.0.1:<webServerPort>    (DSH listener, unchanged)

phone --https--> <machine>.<tailnet>.ts.net   (Tailscale edge, TLS; Funnel)
      --http-->  127.0.0.1:<gatePort>         (same gate, fixed port)
      --http-->  127.0.0.1:<webServerPort>    (DSH listener, unchanged)
```

DSH keeps its Host/Origin fence and its launch token. The gate rewrites `Host`,
`Origin` and `Referer` to `http://127.0.0.1:<webServerPort>` so the harness
accepts the request as loopback, and on a successful pairing claim it performs
the launch-token exchange itself, exactly once, against the loopback listener.
It relays the upstream `Set-Cookie` headers plus its own `dsh_pair` cookie and
answers the phone with a redirect to `/`. The launch token therefore never
reaches the browser, its history or the tunnel, and the plugin never stores or
logs it.

The plugin contributes:

- one host row (`index.js`) that owns the service, the five operator endpoints,
  the two push operator endpoints, the three Tailscale setup endpoints, the
  `pair_notify_report` tool, the `pair_setup_status` / `pair_setup_apply` tools and
  the push sources;
- one browser module (`pair/client/client.js`) with the sidebar icon and the
  panel, including the Tailscale stepper;
- the gate, ticket store, tunnel manager, QR encoder, Web Push sender, VAPID
  key store and notification store under `pair/host/`;
- the Tailscale detection and configuration service (`pair/host/setup.js`) and
  its agent tools (`pair/host/setup-tool.js`).

## Install

```sh
dsh plugin --profile web add dsh-porthole
```

The bundle declares `dsh.bundle.patch`, so `dsh plugin` appends it to the
profile's bundle list. In a profile patch you can override the inserted row, but
a patch replaces the row's whole `config`, so restate every key you keep:

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: dsh-porthole
  config:
    gatePort: 8791
    publicUrl: 'https://my-machine.my-tailnet.ts.net'
    autoStart: true
    cloudflaredPath: ''
    deviceTtlDays: 30
    ticketTtlSeconds: 300
```

Requires Node `>=22` and a DSH release in the `>=0.2.2-rc.2 <0.3.0-0` range
(`engines.dsh`). No dependencies, no build step: plain ESM with Node built-ins
only. All state lives in `$DSH_HOME/pair`.

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `gatePort` | `0` | loopback gate port; `0` asks the OS (public-URL mode: `0` falls back to `8791`, and a fixed port is required) |
| `deviceTtlDays` | `30` | device-token lifetime; the phone pairs again after it expires |
| `ticketTtlSeconds` | `300` | pairing-ticket lifetime |
| `cloudflaredPath` | `''` | explicit cloudflared executable (unused in public-URL mode) |
| `publicUrl` | `''` | `''` = Cloudflare quick tunnel; a bare `https://` origin = stable public URL (Tailscale Funnel) |
| `autoStart` | `true` | in public-URL mode, start the gate on load when a device is already paired |

Any other key, or a wrong type, disables the row with a
`[pair] disabled: …` warning — the profile still boots. `publicUrl` must be an
`https://` origin with no path, query or fragment.

The bundle patch also reads `DSH_PAIR_DISABLE`, `DSH_PAIR_GATE_PORT`,
`DSH_PAIR_PUBLIC_URL`, `DSH_PAIR_AUTO_START` and `DSH_PAIR_CLOUDFLARED` for
per-invocation overrides. There is no `--pair-*` command line: the surface app
rejects options it does not declare.

### The override file

`$DSH_HOME/pair/config.json` (written by the panel's **Use this URL**, by
`POST /pair/api/setup/apply` and by `pair_setup_apply`) holds the three keys a
person changes most often:

```json
{
  "version": 1,
  "publicUrl": "https://<machine>.<tailnet>.ts.net",
  "gatePort": 8791,
  "autoStart": true
}
```

It is written atomically (temp file + rename, mode `0600`) and re-read at
construction and on every restart. Precedence, lowest to highest:

1. bundle row config, with the `DSH_PAIR_*` environment variables evaluated into
   it;
2. a profile patch restating the `dsh-pair` row;
3. `$DSH_HOME/pair/config.json`.

A corrupt, unknown-key or version-mismatched file disables the row with a message
naming the file; delete it to fall back to the row config.

## Guided Tailscale setup

Three owner-only routes on the harness listener, plus two agent tools, all backed
by `pair/host/setup.js`:

| surface | behaviour |
| --- | --- |
| `GET /pair/api/setup` | returns the detection object (never throws) |
| `POST /pair/api/setup/apply` | body ≤ 2 KiB, `{publicUrl?, gatePort?, autoStart?}`; validates, writes the override, restarts the gate; `400` invalid, `409` busy port |
| `POST /pair/api/setup/funnel` | runs only `tailscale funnel --bg <gatePort>` (fixed argv, 15 s); `409` + install guidance when Tailscale is missing |
| `pair_setup_status` | the detection object, bounded and redacted |
| `pair_setup_apply` | the same validated write, rate limited to one per 10 s |

The detection object is stable:

```
{ ok, platform,
  os: { id, label, install: [{ label, command, url }] },
  tailscale: { installed, version, running, dnsName, suggestedUrl, tailscaleIPs, binary },
  funnel: { on, url, targetPort, matchesGatePort },
  config: { gatePort, effectiveGatePort, publicUrl, autoStart, cloudflaredPath,
            cloudflaredPresent, cloudflaredVerified },
  needs: ['install'|'up'|'https'|'funnel-policy'|'funnel-run'|'apply'|'done'],
  docs: { setupUrl, adminDnsUrl, adminAclUrl, funnelDocsUrl },
  policy: { json, acl } }
```

`needs` is ordered, and `['done']` is the only terminal state. The panel renders
one step per fact and collapses to a single line when `needs` is `['done']`.

## Security model

- The gate binds `127.0.0.1` only. Its only network peers are the quick-tunnel
  child (cloudflared) or the operator's reverse proxy on the fixed gate port.
- Everything except health, the pairing claim and the install assets requires a
  valid `dsh_pair` cookie and is refused **before** the upstream is contacted;
  there is no loopback-operator exemption. Fail-closed is the default: a gate
  without a launch token refuses claims, proxied requests and upgrades.
- Tickets are 43-character single-use secrets with a TTL; a new ticket replaces
  the previous one. Devices are stored as `HMAC-SHA256(token)` only, compared in
  constant time, never as raw tokens.
- Cookies are `HttpOnly`, `Path=/`, `SameSite=Lax`, `Secure`, with `Max-Age`
  matched to the device lifetime. Relayed upstream cookies keep their value and
  gain only `Secure`.
- Every proxied request is stamped `x-dsh-pair-proxied: 1`, and a client value
  cannot override it. The operator routes refuse any request carrying it, so a
  tunnelled browser cannot drive the host controls. Those routes live on the
  harness listener and require a loopback socket plus an owner peer.
- Revoking a device refuses its cookie and destroys its live WebSockets; other
  devices keep working.
- Limits: 64 KiB request headers, a 32 MiB body cap rejected from the declared
  `Content-Length` before an upstream connection opens (with a streaming
  backstop), hop-by-hop headers dropped, responses streamed, redirects never
  followed.
- The tunnel provider terminates TLS and can therefore see plaintext and modify
  the page: that is equivalent to agent control. Cloudflare quick tunnels and
  Tailscale Funnel are the same kind of trusted boundary. This is documented,
  not mitigated.
- Anyone holding a live QR code can pair until it is used, expires or is
  replaced. Revoke devices you do not recognise.

## PWA and Web Push

The DSH web UI is already installable: its manifest and icons are relayed by the
gate as public bytes, with no cookie in either direction, so the phone can
install the app **before** it pairs. Pair first, then use the browser's install
action (**Install app** in Chrome, **Add to Home Screen** where that is the
name).

For notifications, the phone registers a push subscription from the panel's
settings. Permission is requested **only** from that explicit gesture — never on
load, and never from the host. Subscriptions live in
`$DSH_HOME/pair/notifications.json`, are per device, per category (approvals,
questions, completion, reports), and can be switched off from the phone.

The push message carries **no content**: the host sends a zero-length POST to
the push endpoint, and the service worker then fetches the actual tickle from
the gate under the device cookie. The push provider sees an empty notification,
not your prompt, code or report text. VAPID keys are generated on first use and
stored in `$DSH_HOME/pair/vapid.json`; a subscription the service says is gone
(`404`/`410`) is dropped.

## Limits

- One live pairing ticket at a time; one device cookie per browser profile.
- A Cloudflare quick tunnel URL is minted on every start, so the installed app's
  origin changes between restarts. Use `publicUrl` (Tailscale Funnel) for a
  stable origin.
- The gate does not speak HTTP/2 or HTTP/3 to the phone; the edge terminates
  those and forwards HTTP/1.1 to the gate.
- The setup service runs only `tailscale version`, `tailscale status --json`,
  `tailscale funnel status` and `tailscale funnel --bg <port>` (fixed argv, 5 s /
  15 s timeouts, `windowsHide: true`, `shell: false`), and it only *resolves*
  cloudflared during detection — it never downloads it there. It never runs
  `tailscale up`, `tailscale cert`, `tailscale funnel reset`, an ACL write, a
  package manager or any command of yours; those remain operator steps.
- Windows downloads a pinned cloudflared release into `$DSH_HOME/pair`; on
  macOS and Linux, set `cloudflaredPath` or use `publicUrl`. `PATH` is never
  consulted, so a planted binary cannot hijack the tunnel.
- No settings UI beyond the panel, no multi-user pairing: a paired device is the
  owner of the profile it pairs with.
