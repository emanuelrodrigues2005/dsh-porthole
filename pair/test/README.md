# Pair plugin — contract test suite

The Pair test suite is the executable specification for the Pair row. The tests
are owned by the specification side of the bundle; implementation changes must
make them pass without weakening, skipping or deleting an assertion. The suite
was green at 94 tests before the red phase described at the end of this file.

Everything is offline and deterministic: no external network, no real Cloudflare
tunnel, no real DSH process and no dependency beyond Node built-ins
(`node:test`, `node:assert/strict`).

## Run

From the package root — the directory that holds `package.json`,
`cordis.patch.yml` and the `pair/` folder:

```powershell
node --test --test-isolation=none "pair/test/*.test.mjs"
```

Expected tail of the run during the red phase (113 tests, 14 red):

```text
ℹ tests 113
ℹ pass 99
ℹ fail 14
ℹ skipped 0
```

### Sandbox and Node notes

- Pass the glob, not the directory. Node 24.19 does not expand a directory
  argument for `--test`: `node --test pair/test/` treats `pair/test/` as a module
  and fails with `ERR_UNSUPPORTED_DIR_IMPORT` before any test runs.
- Inside the DSH sandbox, `node --test` cannot spawn its per-file child
  processes (`spawn EPERM`). `--test-isolation=none` runs every file in one
  process and is the supported form here. Outside such a sandbox the same glob
  also works without that flag.
- A single file can be run directly, e.g.
  `node pair/test/tickets.test.mjs`, for a fast edit loop.
- Every module is plain ESM: `node --check pair/test/gate.test.mjs` (and each
  other `.mjs`) is a valid syntax check.

## Files

| File | Module under test | Focus |
| --- | --- | --- |
| `tickets.test.mjs` | `pair/host/tickets.js` | 43-char single-use tickets, injected TTLs, claim/verify/revoke, 30-day device lifetime, atomic hash-only persistence, no raw tokens or secret on disk |
| `tunnel.test.mjs` | `pair/host/tunnel.js` | quick-tunnel URL parsing and lookalike rejection, exact spawn argv/options, `off → starting → ready/error` state machine, idempotent stop, 30 s URL timeout |
| `gate.test.mjs` | `pair/host/gate.js` | launch-token exchange and token-free relative redirect (S2), `Secure` + `Max-Age` cookies (S3/S6), relayed upstream cookies, proxied marker (S4), declared-body cap (S7c), fail-closed paths, Host/Origin/Referer rewrite, hop-by-hop stripping, WebSocket passthrough, idempotent close, no control endpoints |
| `qr.test.mjs` | `pair/host/qr.js` | square boolean matrix, finder patterns, deterministic SVG geometry/scale/margin, empty and over-long input limits |
| `panel.test.mjs` | `pair/client/client.js` | module-loader registration, pure factory, sidebar + main slot registrations, disposal, no network at apply time, ticketed `status.pairUrl` rendered and copied exactly (S10) |
| `routes.test.mjs` | `pair/host/routes.js` | the five operator routes, gate-proxied refusal first (S4), `requestRejection` before `admit`, loopback-only, owner-only, GET/POST method split, body parsing |
| `setup.test.mjs` | `pair/host/setup.js` | CLI candidate order, injected `execFile` outputs, `version`/`status --json`/`funnel status` parsing, the `needs` state machine, per-OS install commands, byte-exact Funnel policy, fixed-argv `funnel --bg` run |
| `setupconfig.test.mjs` | `pair/host/setup.js`, `pair/host/index.js` | atomic 0600 versioned `config.json`, validation before write, 409 busy port, row < file precedence, restart re-reads the file and the gate goes live |
| `setuproutes.test.mjs` | `pair/host/routes.js` | the three setup routes, identical guard order (marker → 401/403 → loopback → owner), apply 400/409/413, funnel 409 with install guidance, no body reaches the runner |
| `setuptool.test.mjs` | `pair/host/setup-tool.js` | `pair_setup_status` / `pair_setup_apply` schemas, never-throwing execution, bounded output, one apply per ten seconds |
| `setuppanel.test.mjs` | `pair/client/client.js` | the stepper per `needs` state, per-OS command, byte-exact policy copy, the three endpoints, collapse + expand, list/heading/aria structure |
| `setupwiring.test.mjs` | `index.js` | the row contributes the setup routes and tools, detection answers through the real handler, the override file lands in `$DSH_HOME/pair` |
| `service.test.mjs` | `pair/host/index.js` | revocation ends the revoked device's live WebSocket and leaves the other connected (S1), `stop()` closes the rest, burned tickets disappear from `status()` (S5), lifecycle, error release, persistence, idempotent start |
| `cloudflared.test.mjs` | `pair/host/cloudflared.js` | pinned version/URL/SHA-256/size, digest rejection before execution, streamed size cap, never consults `PATH`, explicit path handling |
| `helpers.mjs` | — | manual clock/timers, temp directories, fake child process/spawn, fake ticket store, loopback mock HTTP + WebSocket upstream |

## Contracts pinned by the suite

### S1 — revocation ends live sessions

`service.revoke(deviceId)` revokes the store record **and** destroys the live
upgraded sockets that authenticated with that device's cookie. Another device's
socket keeps echoing. `service.stop()` destroys every remaining upgraded socket
and the gate stops listening.

### S2 — the gate owns the launch-token exchange

A successful claim makes the gate issue exactly one
`GET /?token=<launchToken>` against `127.0.0.1:<upstreamPort>` with the `Host`
header rewritten to that authority. Upstream redirects are not followed: the
browser receives `302`/`303` with exactly `Location: ./`, every upstream
`Set-Cookie`, and no `token=` anywhere in status, headers or body. Upstream
`4xx`/`5xx` or a network failure answers `502`/`503` and hands out no `dsh_pair`
cookie.

### S3 — Secure cookies

The browser-facing `dsh_pair` cookie is
`dsh_pair=<43-char token>; HttpOnly; Path=/; SameSite=Lax; Secure; Max-Age=<s>`.
Every relayed upstream cookie is the upstream string with only `; Secure`
appended, so its value and existing attributes are preserved byte for byte.

### S4 — the proxied marker

Every request the gate forwards upstream carries exactly one
`x-dsh-pair-proxied: 1`; a client-supplied value (including `0`) is overwritten.
The five operator routes on the harness listener refuse the mere presence of
that header with `403` before `ctx.connection.requestRejection` or `admit` is
consulted.

### S5 — a claimed ticket disappears

After a successful claim, `service.status()` returns `pairUrl: null`,
`matrix: null` and `expiresAt: null` for the burned ticket, while still listing
the newly paired device.

### S6 — Max-Age matches the claim

The device cookie's `Max-Age` is `floor((claim.expiresAt - now()) / 1000)`, is
positive, and therefore tracks the injected device lifetime (±1 s).

### S7 — fail closed

Without a launch token the gate answers `503` to a valid ticket, a
cookie-bearing proxied request and an upgrade, never touching the upstream. The
sixth claim attempt in a one-minute window answers `429` with a positive
`Retry-After`. A request whose declared `Content-Length` exceeds the gate's
32 MiB body cap answers `413`/`431` **before** an upstream connection is opened;
the streaming limiter remains the backstop for undeclared bodies.

### S8 — lifecycle

After `start()` reaches `ready`, `status().pairUrl` is
`https://<tunnel>/pair/<ticket>`. `stop()` closes the gate and kills the
cloudflared child. A tunnel error before the URL sets `state: 'error'`, names the
exit code and releases the gate. `revoke()` persists the revoked record to
`devices.json`; a second `start()` while ready spawns nothing.

### S9 — pinned tunnel binary

`PINNED_VERSION` is `2026.11.0` and `DOWNLOAD_URL` is derived from it, never
`latest`. A download whose bytes or digest do not match `PINNED_BYTES` /
`PINNED_SHA256` is rejected before `--version` runs and leaves no file; an
oversized download aborts mid-stream; `resolveCloudflared` never consults
`PATH`; an explicit `cloudflaredPath` that is missing fails loudly, while an
existing one is returned without downloading.

### S10 — the panel shows the ticketed URL

In `ready`, the panel renders `status.pairUrl` (the ticketed link) as selectable
text and its copy control writes exactly that string to the clipboard — never
the bare tunnel root.

## Operator routes

`registerPairRoutes(ctx, service)` registers exactly five exact routes on the
harness web server. The guard order for each request is:

0. `x-dsh-pair-proxied` present → `403`; neither admission call runs.
1. `ctx.connection.requestRejection(request)` returns a number → answer it
   verbatim and stop.
2. `request.socket.remoteAddress` must be one of `127.0.0.1`, `::1`,
   `::ffff:127.0.0.1`; a missing address is non-loopback. Otherwise `403`
   without calling `admit`.
3. `ctx.connection.admit(request)` must return `{ peer: { principal: { kind:
   'owner' } } }`, otherwise `403`.

`/pair/api/status` is GET; the four mutations are POST. A wrong method answers
`405` with `Allow`. Mutations answer `200 {"ok":true}`; `status` answers the
service payload verbatim; `revoke` reads `deviceId` from the JSON body.

## Determinism

- Clocks and timers are manual (`createClock`, `createFakeTimers`).
- The fake ticket store mints deterministic 43-character tokens rather than
  random ones; no filesystem or hashing is needed in gate tests.
- The only sockets are the gate under test and a mock upstream on `127.0.0.1`.
- Temp directories live under `os.tmpdir()` and are removed in `after()` hooks.
- Raw-socket and close tests use 1–2 s **failure** timeouts while waiting for
  socket events; no test synchronises by sleeping.
- `pair/test/README.md` is documentation only; the seven `.test.mjs` modules and
  `helpers.mjs` are test-owned and are not edited to make the implementation
  pass.

## Red phase — PWA assets, stable URL, auto-start, resume

The following contracts are written red on purpose. They were added to the
already-green suite; nothing existing was weakened. (A pass-through service
worker and a `/` HTML injection were considered and dropped: the shipped
frontend is already installable and Android Chrome no longer requires a service
worker, so both would add risk without benefit.)

### A1 — public PWA assets

`GET` and `HEAD` for `/manifest.webmanifest`, `/icon-192.png`, `/icon-512.png`,
`/icon-maskable-512.png`, `/apple-touch-icon.png`, `/favicon.svg` and
`/favicon-dark.svg` reach the upstream without any cookie, with `host` rewritten
to the loopback authority, and the upstream status, headers and body are relayed
unchanged. Any other method answers `405` with `Allow: GET, HEAD`. A path that
starts with `/pair/` is never treated as a public asset.

### A4 — a human 401 on the tunnel front door

`GET /` with `accept: text/html` and no valid `dsh_pair` cookie answers `401`
with `content-type: text/html` and a body explaining the pairing fix (it must
mention "pair"). `accept: application/json` keeps the existing JSON 401 shape,
and a valid cookie still proxies normally.

### B1 — config

`createPairService` accepts `publicUrl` and `autoStart` alongside `gatePort`,
`deviceTtlDays`, `ticketTtlSeconds` and `cloudflaredPath`; the key set stays
closed. `publicUrl` must be an `https://` origin with no path, query or fragment
(a trailing slash is normalized) and any other value is rejected with a message
naming `publicUrl`. `autoStart` must be a boolean.

### B2 — public-URL mode

With `publicUrl` set, `start()` listens on the configured `gatePort`, never
resolves or spawns cloudflared, reaches `ready` with `status().url` equal to the
normalized public URL and `status().pairUrl` under that origin plus `/pair/`.
`stop()` closes the gate and returns to `off`.

### B3 — auto-start

With `autoStart: true` and one already paired device in the state directory, the
factory starts the gate by itself (the test polls for `ready` for up to 2 s).
With zero devices, or with `autoStart: false`, it stays `off`. A failing
auto-start never throws out of the factory: the status is `error` with a message.

### B4 — the panel shows the stable URL

When `status.stable` is true, the panel renders `status.url` as its own text and
shows an "Install app" hint next to it. The existing ticketed-link, copy,
registration and disposal assertions are unchanged.

### C1 — reconnect on resume

`apply` adds `document.addEventListener('visibilitychange', …)` and
`window.addEventListener('pageshow', …)`, reconnects once per hidden → visible
transition (and once per `pageshow`) when `navigator.onLine` is true, does
nothing while offline, removes both listeners on dispose, and tolerates a host
without a `connection` service. The plugin's `inject` gains `'connection'`. The
factory still touches no DOM global.

## Tailscale setup — what the new files pin

The guided setup is specified the same way: a red set that the implementation now
satisfies, with no existing assertion changed.

- **Detection is injected, not mocked globally.** `setup.test.mjs` passes an
  `execFile` double and asserts the exact argv of every probe (`version`,
  `status --json`, `funnel status`, `funnel --bg <port>`), the candidate order and
  the `windowsHide`/`shell: false`/timeout options. A regression that adds a
  command, drops a timeout or enables a shell fails there.
- **`needs` is computed once, on the host.** `computeNeeds` is exercised directly
  and through `status()`; the panel test renders each state from a detection
  object built with the server's own `installGuidance()` and
  `FUNNEL_POLICY_JSON`, so the two halves cannot drift.
- **The write path is ordered.** `setupconfig.test.mjs` proves validation happens
  before any write, the write is a rename of a `0600` temp file, a busy port is a
  409 with no file, and the pair service re-reads the file on `restart()` — the
  file wins over the row config, and a corrupt file disables the row loudly.
- **The guard order is shared.** `setuproutes.test.mjs` runs the same matrix as
  `routes.test.mjs` (proxied marker → `requestRejection` 401/403 → loopback →
  owner) and asserts the setup service is never called before the guard passes.
- **Tools cannot run commands.** `setuptool.test.mjs` serialises both tool
  definitions and asserts no `command`/`args`/`exec`/`shell` parameter exists,
  plus the ten-second apply limit and the never-throwing execute contract.
- **The row wires it all.** `setupwiring.test.mjs` applies `index.js` with a fake
  host context and drives the real handlers; the detection there is
  machine-dependent, so it asserts the shape (200, known `needs`, the policy
  constant), never a particular installation state.


