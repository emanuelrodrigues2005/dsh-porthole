# dsh-porthole

[![npm](https://img.shields.io/npm/v/dsh-porthole)](https://www.npmjs.com/package/dsh-porthole)
[![license](https://img.shields.io/npm/l/dsh-porthole)](LICENSE)
[![GitHub](https://img.shields.io/badge/github-emanuelrodrigues2005%2Fdsh--porthole-181717?logo=github)](https://github.com/emanuelrodrigues2005/dsh-porthole)

Pair your phone with a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
web profile: a fail-closed gate in front of the untouched loopback GUI, a
single-use QR pairing ticket, an installable PWA, and Web Push for approvals,
questions, turn completions and reports.

The default path is a **stable `https://<machine>.<tailnet>.ts.net` URL through
Tailscale Funnel**, and the Pair panel walks you there: it detects Tailscale,
shows the per-OS install command, links the HTTPS + `funnel` policy pages, copies
the exact ACL block, runs `tailscale funnel --bg <port>` for you, detects the
resulting URL and applies it. A Cloudflare quick tunnel still works with no
configuration at all if you would rather not use Tailscale.

Nothing about the harness changes. DSH keeps its loopback bind, its Host/Origin
fence and its launch token; the plugin adds one row in front of it.

```
phone --https--> <random>.trycloudflare.com   (Cloudflare edge, TLS)
      --http-->  127.0.0.1:<gatePort>         (this plugin's gate)
      --http-->  127.0.0.1:<webServerPort>    (DSH listener, unchanged)

phone --https--> <machine>.<tailnet>.ts.net   (Tailscale edge, TLS; Funnel)
      --http-->  127.0.0.1:<gatePort>         (same gate, fixed port)
      --http-->  127.0.0.1:<webServerPort>    (DSH listener, unchanged)
```

- Node built-ins only, plain ESM, **no dependencies and no build step**.
- State lives in `$DSH_HOME/pair`; nothing is written anywhere else.
- The gate binds `127.0.0.1` and fails closed. There is no "open to the LAN"
  mode.

## Install

Into the profile you boot with (`web` below — use your own profile name):

```sh
# from npm
dsh plugin --profile web add dsh-porthole

# from a checkout or a git host
dsh plugin --profile web add github:emanuelrodrigues2005/dsh-porthole

# from a tarball produced by `npm pack`
dsh plugin --profile web add ./dsh-porthole-0.1.0.tgz
```

Then check the layer without booting, and start the GUI:

```sh
dsh --profile web --dump-config   # shows a "# == dsh-porthole" layer with the dsh-pair row
dsh --profile web
```

`dsh plugin --profile web remove dsh-porthole` removes both the dependency
and the layer.

A GitHub install fetches sources, and pnpm ≥10 refuses to run a git
dependency's `prepare` script until it is allowlisted. This package needs no
build at all, so there is normally nothing to allow — if pnpm still prints an
`allowBuilds` request, copy the exact key it names into the profile's
`pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-porthole: true
```

Prefer the npm or tarball install if you would rather not grant any install-time
execution. See [PUBLISHING.md](PUBLISHING.md) for the release side.

Requires Node `>=22` and a DSH release in the `>=0.2.2-rc.2 <0.3.0-0` range
(`engines.dsh`). Installation and profile startup refuse the bundle when the
running DSH is outside that range.

## Quickstart

### The Tailscale path (recommended: a URL that never changes)

1. Open the DSH GUI on the host machine (`127.0.0.1`/`localhost`) and click
   **Pair** in the left sidebar. The panel is host-only: the tunnelled page can
   use the GUI, but not the pair controls.
2. Follow the **Tailscale setup** card, top to bottom. It collapses to one line
   once everything matches:

   | step | what the card gives you |
   | --- | --- |
   | 1. Install Tailscale | the command for this OS — Windows `winget install --id Tailscale.Tailscale -e`, macOS `brew install --cask tailscale`, Linux `curl -fsSL https://tailscale.com/install.sh | sh` — plus <https://tailscale.com/download> |
   | 2. Enable HTTPS + Funnel | links to <https://login.tailscale.com/admin/dns> and the ACL editor, and the byte-exact `nodeAttrs` block to merge |
   | 3. Run the funnel | `tailscale funnel --bg <port>`, with a copy button and **Run it for me** |
   | 4. Apply the detected URL | the detected `https://<machine>.<tailnet>.ts.net` and **Use this URL** |

3. Press **Start pairing**. The state goes `off → starting → ready` at the stable
   origin; nothing is spawned except the gate itself.
4. Scan the QR code with the phone. It opens
   `https://<machine>.<tailnet>.ts.net/pair/<ticket>` once: the gate exchanges the
   ticket and the launch token with the local listener, sets the `dsh_pair` cookie
   and redirects to `/`. The phone now owns a revocable device cookie for ordinary
   requests and WebSocket reconnects.
5. **Install the PWA**: browser menu → **Install app** (Chrome) or **Add to Home
   Screen**. The stable origin means the installed app keeps working.
6. **Enable notifications** from the panel's push settings on the phone. The
   permission prompt comes only from that button press, and the phone chooses
   which categories it wants: approvals, questions, completion, reports.
7. **New ticket** replaces the live ticket; **Revoke** refuses a device at once
   and destroys its live connections; **Stop** closes the gate.

The full procedure, with verification commands, precedence rules and a
troubleshooting table, is in [docs/SETUP-TAILSCALE.md](docs/SETUP-TAILSCALE.md).
An agent can do it end to end: see [docs/AI-SETUP.md](docs/AI-SETUP.md) and the
[dsh-pair-setup skill](skills/dsh-pair-setup/SKILL.md).

### The quick-tunnel path (no configuration)

1. Open **Pair** on the host and press **Start pairing**. In quick-tunnel mode
   this resolves `cloudflared` (see [Cloudflared](#cloudflared-per-platform)).
2. Scan the QR code, install the app, enable notifications as above.
3. The URL is minted on every start, so the installed app's origin changes
   between restarts. Use Tailscale Funnel for anything permanent.

The quick tunnel is never started by loading the plugin — only when you ask. In
public-URL mode the gate starts itself on load when `autoStart: true` and a
device is already paired.

## Configuration

The bundle patch inserts one row, `dsh-pair`, and accepts exactly these keys.
Any other key (or a wrong type) disables the row with a
`[pair] disabled: …` warning; the profile still boots.

| key | patch default | env override | meaning |
| --- | --- | --- | --- |
| `gatePort` | `Number(DSH_PAIR_GATE_PORT ?? 0)` = `0` | `DSH_PAIR_GATE_PORT` | loopback gate port; `0` asks the OS. Public-URL mode needs a fixed port (`0` falls back to `8791`) because Funnel forwards to exactly one local port |
| `deviceTtlDays` | `30` | — | device-token lifetime; after it the phone pairs again |
| `ticketTtlSeconds` | `300` | — | pairing-ticket lifetime |
| `cloudflaredPath` | `DSH_PAIR_CLOUDFLARED ?? ''` | `DSH_PAIR_CLOUDFLARED` | explicit cloudflared executable (must exist); unused in public-URL mode |
| `publicUrl` | `DSH_PAIR_PUBLIC_URL ?? ''` | `DSH_PAIR_PUBLIC_URL` | `''` = Cloudflare quick tunnel; an `https://` origin with no path/query/fragment = stable public URL via your reverse proxy |
| `autoStart` | `DSH_PAIR_AUTO_START !== '0'` = `true` | `DSH_PAIR_AUTO_START` (`0` disables) | in public-URL mode, start the gate on load when a device is already paired |

`DSH_PAIR_DISABLE=1` disables the row without editing any file.

Your own profile patch wins over the bundle layer — but a patch replaces a row's
**whole** `config`, it does not deep-merge, so restate every key you keep:

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

There is no `--pair-*` command line: the surface app owns the invocation's
parser and rejects options it does not declare, so per-invocation overrides use
the environment variables above.

### The override file the panel writes

**Use this URL** in the panel (and `POST /pair/api/setup/apply`, and the
`pair_setup_apply` tool) writes `$DSH_HOME/pair/config.json`:

```json
{
  "version": 1,
  "publicUrl": "https://<machine>.<tailnet>.ts.net",
  "gatePort": 8791,
  "autoStart": true
}
```

It is written atomically (temp file + rename, mode `0600`), re-read at
construction and on every restart, and its three keys override the row config.
Precedence, lowest to highest:

1. the bundle row config, with the `DSH_PAIR_*` environment variables evaluated
   into it;
2. a profile patch that restates the `dsh-pair` row;
3. `$DSH_HOME/pair/config.json`.

So the env vars lose to the file — the GUI keeps the last word on a machine where
it is used. Delete the file (or a key in it) to fall back to the row config. A
corrupt or version-mismatched file disables the Pair row with
`[pair] disabled: pair setup: …` rather than pairing with the wrong origin.

## Stable URL with Tailscale Funnel

A Cloudflare quick tunnel is minted on every start, so its URL — and therefore
the installed app's origin — changes. Tailscale Funnel publishes the machine at
a **stable** `https://<machine>.<tailnet>.ts.net` origin instead. Funnel
terminates TLS at the tailnet edge and proxies to exactly one fixed local port,
so public-URL mode needs a fixed `gatePort`, never resolves or spawns
`cloudflared`, and keeps `status().url` across restarts.

The panel's **Tailscale setup** card performs this procedure and shows the state
of every step. By hand it is:

1. Install Tailscale (per OS, commands in
   [docs/SETUP-TAILSCALE.md](docs/SETUP-TAILSCALE.md#step-1--install-tailscale)).
2. Enable HTTPS certificates and grant the `funnel` node attribute:

   ```json
   {"nodeAttrs":[{"target":["autogroup:member"],"attr":["funnel"]}]}
   ```

3. Point the row at the Funnel origin with a **fixed** `gatePort` (a profile
   patch, as shown above, or `DSH_PAIR_GATE_PORT=8791` +
   `DSH_PAIR_PUBLIC_URL=https://<machine>.<tailnet>.ts.net`), then restart
   DeepSeek Harness — or skip the file entirely and press **Use this URL** in the
   panel, which writes `$DSH_HOME/pair/config.json` and restarts the gate.
4. Map the public origin to that port:

   ```sh
   tailscale funnel 8791          # foreground; prints the public URL, Ctrl+C stops it
   tailscale funnel --bg 8791     # background; keeps publishing after the terminal closes
   tailscale funnel status        # shows the mapping and its https:// URL
   ```

5. Open **Pair** and press **Start pairing** once — or let `autoStart: true`
   bring the gate back by itself when a device is already paired. The ready
   panel shows the stable URL next to the pairing link.
6. Pair, then install the app from the Funnel URL on the phone.
7. Funnel only works while the host is reachable. Optionally stop the host from
   sleeping on AC power (Windows):

   ```powershell
   powercfg /change standby-timeout-ac 0
   powercfg /change hibernate-timeout-ac 0
   ```

To stop publishing, remove the Funnel mapping (admin console or
`tailscale funnel reset`), then press **Stop** in the panel.

On macOS/Linux a Funnel-only setup is the path that needs no cloudflared at all:
`publicUrl` plus a fixed `gatePort`.

## Cloudflared per platform

Quick-tunnel mode (`publicUrl: ''`) needs a `cloudflared` binary. Resolution
order, first hit wins:

1. `cloudflaredPath` from the row config — must exist and be a file, otherwise
   start fails loudly naming the path;
2. the managed binary under `$DSH_HOME/pair` — checked with `--version`;
3. a **managed download** of the pinned Cloudflare release into
   `$DSH_HOME/pair` (streamed, size-capped, verified against the pinned SHA-256
   and `--version`, then renamed into place).

`PATH` is never consulted, so a planted `cloudflared` cannot hijack the tunnel.

| platform | behaviour |
| --- | --- |
| Windows (amd64) | pinned `cloudflared.exe` is downloaded automatically into `$DSH_HOME/pair/cloudflared.exe` |
| macOS / Linux | no automatic download: set `cloudflaredPath` to a binary you trust, or set `publicUrl` and use your own tunnel (Tailscale Funnel, nginx + your TLS) |
| offline host | set `cloudflaredPath` to a pre-installed binary; the row fails with a message naming the path and URL instead of guessing |

## Web Push

The phone registers a push subscription from the panel, and the host tickles it
when something needs the operator:

| category | trigger |
| --- | --- |
| `approvals` | a tool call is waiting for an approval |
| `questions` | the agent asks the operator a question |
| `completion` | a turn finished, failed, was blocked or hit the token limit |
| `reports` | the agent called the `pair_notify_report` tool |

Two deliberate design choices:

- **The permission prompt comes only from a user gesture** — the phone's push
  settings button. Never on page load, never from the host side.
- **The push payload is empty.** The host sends a zero-length POST to the push
  endpoint; the service worker then fetches the actual tickle from the gate
  under the device cookie. The push provider relays "something happened" and
  sees no prompt, no code and no report text. This also means no Web Push
  encryption library is needed.

Subscriptions are per device, live in `$DSH_HOME/pair/notifications.json`, and
can be switched off per category from the phone. VAPID keys are generated on
first use into `$DSH_HOME/pair/vapid.json`. A subscription the push service
reports as gone (`404`/`410`) is dropped.

## Security model

- **Fail closed.** A gate without a launch token refuses claims, proxied
  requests and upgrades. Everything except `GET /pair/health`, the pairing claim
  `GET /pair/<ticket>` and the install assets requires a valid `dsh_pair` cookie
  and is refused *before* the upstream is contacted. There is no
  loopback-operator exemption.
- **One-time tickets.** 43-character tickets, single use, `ticketTtlSeconds`
  TTL, one live ticket at a time; a new ticket replaces the old one.
- **Device cookies, not tokens in URLs.** The claim redirect carries no launch
  token. The gate performs the launch-token exchange against the loopback
  listener itself, relays upstream `Set-Cookie` headers, sets its own
  `HttpOnly; Path=/; SameSite=Lax; Secure` cookie with `Max-Age` matched to
  `deviceTtlDays`, and answers `303 Location: /`.
- **No raw secrets on disk.** Devices are stored as `HMAC-SHA256(token)` only,
  compared in constant time; the per-home HMAC key lives in
  `$DSH_HOME/pair/pair-state.json` (mode `0600` where supported). Nothing logs
  tokens, tickets, cookies or the launch URL.
- **Revocation is immediate.** A revoked device's cookie is refused and its live
  WebSockets are destroyed; other devices keep working.
- **No content to the push provider** (see above).
- **Host-only controls.** The operator endpoints (`/pair/api/*`, including
  `/pair/api/setup`, `/pair/api/setup/apply` and `/pair/api/setup/funnel`) live on
  the harness listener, nowhere else (the gate answers `404`), require a loopback
  socket plus an owner peer, and refuse any request carrying the
  `x-dsh-pair-proxied: 1` marker the gate stamps on everything it proxies — a
  client cannot forge or override it.
- **No arbitrary commands.** The setup service runs only `tailscale version`,
  `tailscale status --json`, `tailscale funnel status` and
  `tailscale funnel --bg <port>` (5 s / 15 s timeouts, `windowsHide: true`,
  `shell: false`). The port is an integer from configuration; no argv is ever
  assembled from a request body or from model input, and the tools expose no
  command parameter.
- **Bounded input.** 64 KiB request headers, a 32 MiB body cap rejected from the
  declared `Content-Length` before an upstream connection opens (with a
  streaming backstop for undeclared bodies), hop-by-hop headers dropped,
  responses streamed, redirects never followed.
- **Trusted boundary.** The tunnel provider terminates TLS and can see plaintext
  and modify the page — equivalent to agent control. Cloudflare quick tunnels
  and Tailscale Funnel are the same kind of boundary; this is documented, not
  mitigated. Treat anyone holding a live QR code as able to pair until it is
  used, expires or is replaced, and revoke devices you do not recognise.

## Compatibility

| requirement | value |
| --- | --- |
| DeepSeek Harness | `engines.dsh`: `>=0.2.2-rc.2 <0.3.0-0` |
| Node | `>=22` |
| OS | Windows, macOS, Linux (quick tunnel: Windows download, elsewhere `cloudflaredPath` or `publicUrl`) |
| dependencies | none — Node built-ins only, plain ESM, no build step |
| harness changes | none — the plugin adds a row, the harness stays loopback-bound |

The plugin needs two harness services: `webServer` (to register the operator
routes) and `connection` (for the launch token). A profile without them logs
`[pair] disabled: …` and boots normally. The client module injects
`@deepseek-ai/dsh-client-ui-sidebar` and `@deepseek-ai/dsh-client-ui-layout`
for its slots.

## Troubleshooting

| symptom | cause and fix |
| --- | --- |
| `Start` fails with **port busy** (`EADDRINUSE`) | another process holds `gatePort`. Set `gatePort: 0` for an OS-assigned port (quick-tunnel mode), or free the fixed port Funnel needs. |
| The phone shows **502** or **ERR_CONNECTION_CLOSED** | the tunnel is up but the gate is not: the panel went to `off`/`error`, a device was revoked, or the host slept. Press **Start pairing** on the host, keep the host awake, and check the harness log for `[pair] disabled`. |
| The phone shows **401** after pairing | the device was revoked or its `deviceTtlDays` token expired. Pair again with a fresh QR. |
| **QR expired** | press **New ticket**; the old ticket is already invalid. |
| **Notifications denied** | permission was dismissed or blocked. In the browser's site settings for the tunnel origin, allow notifications, then press the panel's enable button again — the prompt only appears from that gesture. If the subscription was deleted server-side it is dropped automatically; re-enable to re-register. No notification arrives with the app closed on iOS before the app is added to the Home Screen. |
| The panel says **pair controls are host-only** | you opened the tunnelled (or LAN) page. Open the GUI from `127.0.0.1`/`localhost` on the host machine. |
| `launch token is unavailable` | `ctx.connection` was unavailable in this profile; restart the harness. |
| `cloudflared` errors on start | install it, set `cloudflaredPath`, or allow the download; the error names the path and URL. |
| `[pair] disabled: …` in the log | the row config has an unknown key or a wrong type, or `publicUrl` is not a bare `https://` origin. The message names the offending key. |
| **Tailscale setup** says `needs: install` | the `tailscale` CLI was not found on `PATH`, at `C:\Program Files\Tailscale\tailscale.exe`, `/usr/local/bin/tailscale`, `/opt/homebrew/bin/tailscale` or `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. Install it, then **Check again**. |
| **Run it for me** answers 409 `gate port N is already in use` | another listener owns the port. Pick another `gatePort` or stop the other process. |
| Funnel is on but the panel says `× matched` | Funnel forwards to a different port than `effectiveGatePort`. Re-run `tailscale funnel --bg <port>` from the card. |
| **State Error** with an exit code | cloudflared could not create a quick tunnel (network, proxy, rate limit). Try again or use `publicUrl`. |

## Files

| path | contents |
| --- | --- |
| `index.js` | the host row: service wiring, operator routes, push routes, setup routes, `pair_notify_report`, `pair_setup_status` / `pair_setup_apply`, push sources |
| `pair/host/` | `gate.js`, `index.js` (service), `tickets.js`, `tunnel.js`, `cloudflared.js`, `routes.js`, `setup.js` (Tailscale detection + config file), `setup-tool.js` (agent tools), `qr.js`, `vapid.js`, `push.js`, `notifications.js`, `sources.js`, `notify-tool.js`, `sw.js` |
| `pair/host/vendor/` | the QR encoder and its licence |
| `pair/client/client.js` | the browser module: sidebar icon plus the Pair panel and its Tailscale stepper |
| `cordis.patch.yml` | the bundle layer: one `dsh-pair` row |
| `docs/SETUP-TAILSCALE.md` | the full Tailscale procedure (per OS, HTTPS, ACL, funnel, apply, troubleshooting) |
| `docs/AI-SETUP.md` | the agent protocol: tools, `needs` decision table, safety limits |
| `skills/dsh-pair-setup/SKILL.md` | a self-contained skill an agent can install to run the procedure |
| `locale/`, `icon.svg`, `docs/DETAIL.md` | plugin-manager metadata and the detail page |
| `scripts/check-package.mjs` | the package checks (`npm run check`) |

The contract test suite lives in `pair/test/` in the repository and is
deliberately **not** published: `npm run test` runs it
(`node --test --test-isolation=none "pair/test/*.test.mjs"`), `npm run check`
runs the package checks.

## Licence

MIT — see [LICENSE](LICENSE). The vendored QR encoder carries the same licence
in `pair/host/vendor/qrcodegen.LICENSE.txt`.

Not affiliated with DeepSeek. The icon is original artwork; please do not use
official DeepSeek brand assets in community projects.
