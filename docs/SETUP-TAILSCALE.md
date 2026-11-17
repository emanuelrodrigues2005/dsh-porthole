# Tailscale setup for a stable Pair URL

This is the long form of the **Tailscale setup** card in the Pair panel. Follow it
once per machine; afterwards the phone keeps a stable
`https://<machine>.<tailnet>.ts.net` origin across restarts, reboots and network
changes, and the panel collapses to a single `Tailscale ready — <url>` line.

Everything below is something *you* can do from a terminal or the admin console.
The plugin can also detect each step and run the one Funnel command for you; it
never edits your ACL, never signs in to Tailscale and never installs anything.

```
phone --https--> <machine>.<tailnet>.ts.net   (Tailscale edge, TLS; Funnel)
      --http-->  127.0.0.1:8791               (this plugin's gate)
      --http-->  127.0.0.1:<webServerPort>    (DSH listener, unchanged)
```

## What you end up with

| piece | value in this guide | why |
| --- | --- | --- |
| gate port | `8791` | Funnel forwards to exactly one local port, so it must be fixed |
| public URL | `https://<machine>.<tailnet>.ts.net` | stable, TLS-terminated at the tailnet edge |
| config file | `$DSH_HOME/pair/config.json` | written by **Use this URL**, read at every start |
| phone | installed PWA with push | the origin never changes, so the install stays valid |

## Before you start

- DSH is running and the Pair row is loaded (`dsh plugin --profile web list`
  shows `dsh-porthole`).
- You are on the machine that runs DSH. The Pair controls are host-only: open the
  GUI at `http://127.0.0.1:<port>` (or the desktop window), not through the
  tunnel.
- You can sign in to the Tailscale admin console as an owner of the tailnet.
- Optional: `tailscale` is already installed and signed in — then skip to
  [Step 2](#step-2-enable-https-and-the-funnel-policy).

## Step 0 — pick the gate port

The gate listens on `127.0.0.1` only; Funnel proxies to that one port. Pick a
port that is free (check with `netstat -ano | findstr :8791` on Windows or
`ss -lntp | grep 8791` on Linux) and keep it for good.

- In the panel: the **Run the funnel** step already shows the port the plugin will
  use. It is `gatePort` from the row config, or `8791` when the row leaves
  `gatePort: 0` and a `publicUrl` is configured.
- In a file: `$DSH_HOME/pair/config.json` (next section) or the profile patch.

If the port is changed later, re-run the Funnel command with the new port and
re-apply the URL — the panel reports `matched` only while the two agree.

## Step 1 — install Tailscale

### Windows

```powershell
winget install --id Tailscale.Tailscale -e
```

No winget? Download the installer from <https://tailscale.com/download> and run
it. The CLI ends up at `C:\Program Files\Tailscale\tailscale.exe`; the plugin
finds it there even when it is not on `PATH`.

### macOS

```sh
brew install --cask tailscale
```

Or install the App Store build (the plugin also looks at
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`). With Homebrew the CLI is
at `/opt/homebrew/bin/tailscale` on Apple silicon, `/usr/local/bin/tailscale` on
Intel.

### Linux

```sh
curl -fsSL https://tailscale.com/install.sh | sh
```

Any distro package works too; the plugin only needs `tailscale` on `PATH`.

### Sign in and check

```sh
tailscale up
tailscale status --json      # BackendState must be "Running"
```

`Self.DNSName` in that JSON is the machine name the panel will show as
`https://<machine>.<tailnet>.ts.net` (with the trailing dot removed).

The panel's **Install Tailscale** step reads the same three facts
(`installed`, `running`, `dnsName`) and offers a **Check again** button.

## Step 2 — enable HTTPS and the Funnel policy

Both live in the Tailscale admin console and both are one-time per tailnet.

1. **HTTPS certificates** — open <https://login.tailscale.com/admin/dns> and turn
   on *Enable HTTPS*. Funnel refuses to serve a `.ts.net` hostname without a
   certificate for it.
2. **The `funnel` node attribute** — open
   <https://login.tailscale.com/admin/acls/file> and merge this block into the
   ACL file:

   ```json
   {"nodeAttrs":[{"target":["autogroup:member"],"attr":["funnel"]}]}
   ```

   With the default policy, the merged document looks like this (paste the whole
   thing if you have not customised your ACL yet):

   ```json
   {
     "grants": [
       {
         "src": "autogroup:member",
         "dst": "autogroup:member",
         "ip": ["*"]
       }
     ],
     "nodeAttrs": [
       {
         "target": ["autogroup:member"],
         "attr": ["funnel"]
       }
     ]
   }
   ```

   Save the file. If Tailscale rejects it, the editor names the offending node;
   the usual causes are a trailing comma and a `nodeAttrs` block placed inside
   `grants`.

The panel's **Enable HTTPS + Funnel** step links to both pages and copies the
`nodeAttrs` block byte-exactly (the same button also has the merged document in
`docs/AI-SETUP.md` for an agent to paste).

> Scope: `autogroup:member` grants Funnel to every member of your tailnet. To
> limit it to this machine, replace the target with the machine's tag or
> `"*"`-style selector your policy already uses, for example
> `{"target":["tag:dsh"],"attr":["funnel"]}` with the machine tagged `tag:dsh`.

## Step 3 — run the funnel

```sh
tailscale funnel --bg 8791        # background: keeps publishing after the shell closes
tailscale funnel status           # shows "Funnel on", the https URL and the proxy port
```

A healthy `tailscale funnel status` looks like this:

```
# Funnel on:
#     - https://studio.tailnet-abc.ts.net
#     - http://100.101.102.103:8791

https://studio.tailnet-abc.ts.net (Funnel on)
|-- / proxy http://127.0.0.1:8791
```

The panel's **Run it for me** button runs exactly that command (fixed argv, the
port comes from configuration), shows the bounded output and re-detects. If the
Funnel mapping ends up on a different port, the panel's `matched` badge turns to
`× matched` and shows both ports.

Stop publishing with:

```sh
tailscale funnel reset
```

That only removes the mapping; the DSH gate keeps listening on `127.0.0.1:8791`.

## Step 4 — apply the detected URL

The panel's **Apply the detected URL** step shows the URL Tailscale reported and a
**Use this URL** button. It writes `$DSH_HOME/pair/config.json` and restarts the
gate, so the new origin is live in a second or two — no harness restart.

The file it writes (mode `0600`, atomic rename, versioned):

```json
{
  "version": 1,
  "publicUrl": "https://studio.tailnet-abc.ts.net",
  "gatePort": 8791,
  "autoStart": true
}
```

Three ways to do the same thing:

| way | how |
| --- | --- |
| panel | **Use this URL** (writes the file, restarts the gate) |
| HTTP (loopback, owner only) | `POST /pair/api/setup/apply` with `{"publicUrl":"https://…","gatePort":8791}` |
| agent tool | `pair_setup_apply` with the same three keys |

or by hand, if you prefer files: write that JSON and press **Stop** then **Start
pairing** in the panel (the file is read at every start, so a restart of the
harness works too).

### Configuration precedence

Lowest to highest:

1. the bundle row config — `cordis.patch.yml` defaults, with the `DSH_PAIR_*`
   environment variables evaluated into the row;
2. any profile patch that restates the `dsh-pair` row (it replaces the row's whole
   `config`, so restate every key you keep);
3. `$DSH_HOME/pair/config.json` — the file this panel writes;
4. the running GUI: **Use this URL** and `pair_setup_apply` write layer 3 and
   restart the gate immediately.

Environment variables are read when the bundle patch is evaluated, so they land in
layer 1 and therefore lose to the file. That is intentional: the GUI keeps the
last word on a machine where it is used. Remove the file (or delete a key from it)
to fall back to the row config.

A corrupt or unsupported file disables the Pair row with a
`[pair] disabled: pair setup: …` warning instead of pairing with the wrong
origin. Fix or delete `$DSH_HOME/pair/config.json` to recover.

## Step 5 — pair the phone

1. In the panel, press **Start pairing** (with `autoStart: true` and a device
   already paired, the gate comes back by itself).
2. Scan the QR code with the phone. It opens
   `https://<machine>.<tailnet>.ts.net/pair/<ticket>` once; the gate exchanges the
   ticket for a device cookie and redirects to `/`.
3. Install the app: browser menu → **Install app** (Chrome) or **Add to Home
   Screen**. The origin is stable, so the installed app keeps working.
4. On the phone, open the app from the home screen and press **Enable
   notifications**. Approve the browser prompt. iOS only offers push to an
   installed app, which is why the install comes first.
5. Back on the host, the device appears under **Paired devices** with its push
   state and four category switches. **Send test** proves the path end to end.

## Verification

Run these on the host:

```sh
# 1. the gate is listening on the fixed port (fail-closed, no cookie needed)
curl -s http://127.0.0.1:8791/pair/health
# {"ok":true}

# 2. Funnel forwards to that port
tailscale funnel status        # shows "... (Funnel on)" and "proxy http://127.0.0.1:8791"

# 3. the public origin answers through Tailscale
curl -s https://<machine>.<tailnet>.ts.net/pair/health
# {"ok":true}

# 4. operator routes stay host-only: the tunnel answers 404 for them
curl -s -o /dev/null -w "%{http_code}\n" https://<machine>.<tailnet>.ts.net/pair/api/setup
# 404
```

And in the panel: `Tailscale ready — https://<machine>.<tailnet>.ts.net`, the
device row listing `push · registered`, and a received test notification.

## Troubleshooting

| symptom | cause | fix |
| --- | --- | --- |
| `502 Bad Gateway` / `ERR_CONNECTION_CLOSED` from the public URL | the gate is not listening on the port Funnel forwards to (pairing stopped, wrong port, or a crash) | press **Start pairing**; compare `tailscale funnel status` with `config.effectiveGatePort` in the panel (or `/pair/api/setup`); if they differ, re-run `tailscale funnel --bg <port>` |
| **Run it for me** answers 409 `gate port N is already in use` | something else owns that port | pick another `gatePort`, or stop the other listener (`netstat -ano | findstr :8791`) |
| 409 `Tailscale is not installed or not on PATH` | the CLI was not found in any known location | run Step 1, then **Check again** |
| `tailscale funnel` fails with `nodeAttrs` / `funnel` errors | the ACL has no `funnel` node attribute | paste the block from Step 2 and save |
| `tailscale funnel` fails with a certificate error | HTTPS certificates are off | enable them at <https://login.tailscale.com/admin/dns> |
| The panel says `× matched` | Funnel forwards to another port | `tailscale funnel --bg <the port in the panel>` |
| The panel says `needs: apply` although Funnel is on | the configured `publicUrl` is not the detected one | press **Use this URL** |
| The phone shows the "pair again" page after a restart | it is holding a revoked/expired device cookie, or the origin changed | issue a **New ticket** and re-pair; check `deviceTtlDays` |
| Public URL works on the phone but not from a browser on the host | Tailscale MagicDNS resolves only inside the tailnet | expected — test with `/pair/health` from the host instead |
| Everything dies when the machine sleeps | Funnel needs the host to be awake | stop it from sleeping: `powercfg /change standby-timeout-ac 0` (Windows), *Prevent automatic sleeping* (macOS Energy), `systemd-inhibit sleep` (Linux) |
| Notifications arrive hours late | the browser was closed or the app was not installed | re-open the installed app; re-send **Send test** |

## What the plugin runs, and what it never does

The setup service executes **only** these commands, each with a 5 s timeout
(15 s for the funnel run), `windowsHide: true` and `shell: false`:

```sh
tailscale version
tailscale status --json
tailscale funnel status
tailscale funnel --bg <port>     # only from the "Run it for me" button or pair_setup_apply's sibling route
```

No argument is ever assembled from a request body or from model input: the port is
an integer read from configuration, and the subcommands are literals. The plugin
never runs `tailscale up`, `tailscale cert`, `tailscale funnel reset`, an ACL
edit, a package manager, or any command of your choosing. Cloudflared is only
*resolved* during detection (its download path is disabled); quick-tunnel mode
still spawns it exactly as before.

## Roll back to a quick tunnel

```sh
tailscale funnel reset
rm "$DSH_HOME/pair/config.json"     # or delete just the publicUrl key
```

Then press **Start pairing**. The gate goes back to `gatePort: 0` (OS-assigned)
and a Cloudflare quick tunnel, and the URL changes on every start.
