# Agent protocol: configure a stable Tailscale URL for this harness

This page is written for an AI agent working on the operator's machine. It tells
you exactly what to read, what to say, what you may run, and when to stop. The
human-facing version is [SETUP-TAILSCALE.md](SETUP-TAILSCALE.md).

You have two tools. They are the only setup actions you can perform.

| tool | purpose | arguments |
| --- | --- | --- |
| `pair_setup_status` | read the whole setup state | none |
| `pair_setup_apply` | write the public URL / gate port / autoStart | `{publicUrl?, gatePort?, autoStart?}` |

Neither tool can run a command you choose. The plugin itself runs only fixed
`tailscale` probes (see [Safety limits](#safety-limits)). **You** may run the
commands below yourself, in the operator's shell, after telling them what you are
about to run — those are documented, literal commands, not tool calls.

## 1. Read the state

```
pair_setup_status()
```

The answer has a stable shape:

```jsonc
{
  "ok": true,
  "platform": "win32",
  "os": {
    "id": "windows", "label": "Windows",
    "install": [
      { "label": "winget", "command": "winget install --id Tailscale.Tailscale -e", "url": "https://tailscale.com/download" },
      { "label": "Installer", "command": "", "url": "https://tailscale.com/download" }
    ]
  },
  "tailscale": {
    "installed": true, "version": "1.68.1", "running": true,
    "dnsName": "studio.tailnet-abc.ts.net",
    "suggestedUrl": "https://studio.tailnet-abc.ts.net",
    "tailscaleIPs": ["100.101.102.103"], "binary": "tailscale"
  },
  "funnel": { "on": true, "url": "https://studio.tailnet-abc.ts.net", "targetPort": 8791, "matchesGatePort": true },
  "config": {
    "gatePort": 8791, "effectiveGatePort": 8791,
    "publicUrl": "", "autoStart": true, "cloudflaredPath": "",
    "cloudflaredPresent": false, "cloudflaredVerified": false
  },
  "needs": ["apply"],
  "docs": {
    "setupUrl": "https://tailscale.com/download",
    "adminDnsUrl": "https://login.tailscale.com/admin/dns",
    "adminAclUrl": "https://login.tailscale.com/admin/acls/file",
    "funnelDocsUrl": "https://tailscale.com/kb/1223/funnel"
  },
  "policy": {
    "json": "{\"nodeAttrs\":[{\"target\":[\"autogroup:member\"],\"attr\":[\"funnel\"]}]}",
    "acl": "…the same nodeAttrs block merged into the default grants sample…\n"
  }
}
```

`needs` is the ordered to-do list, computed by the plugin — do not recompute it.
`effectiveGatePort` is the port Funnel must forward to (`8791` when `gatePort`
is `0` and a public URL is configured). `policy.json` is byte-exact; copy it, do
not reformat it.

## 2. Act on `needs`

| `needs` contains | meaning | what you do |
| --- | --- | --- |
| `install` | no `tailscale` binary was found | tell the operator the exact `os.install[].command` for their platform, or point at `os.install[].url`. Do not run an installer without explicit permission. Then ask them to run `pair_setup_status()` again. |
| `up` | installed, backend not `Running` | ask them to run `tailscale up` and finish the browser sign-in, then re-read. Never run `tailscale up` yourself: it opens a browser and can change tailnet state. |
| `https` | HTTPS certificates are not confirmed (Funnel is off) | send them to `docs.adminDnsUrl` and ask them to enable *HTTPS certificates*. |
| `funnel-policy` | the tailnet has no `funnel` node attribute | give them `policy.json` (or `policy.acl` if their ACL file is still the default) and `docs.adminAclUrl`; ask them to save it. |
| `funnel-run` | Funnel is off, or forwards to a different port | the command is `tailscale funnel --bg <effectiveGatePort>`. They can run it, or press **Run it for me** in the Pair panel. |
| `apply` | Funnel is on but the configured URL is not the detected one | call `pair_setup_apply({ "publicUrl": "<suggestedUrl>", "gatePort": <effectiveGatePort> })`. No confirmation needed if both values come from `pair_setup_status` unchanged. |
| `done` | everything matches | nothing to do; go to verification. |

Order matters: install → up → https + policy → funnel → apply. Running `funnel`
before the policy exists fails, and applying a URL before Funnel forwards to the
right port publishes a URL that answers 502.

## 3. Verify before you report success

Run these literal commands (or ask the operator to) and check the output:

```sh
tailscale funnel status                         # "Funnel on", the https URL, "proxy http://127.0.0.1:<port>"
curl -s http://127.0.0.1:<port>/pair/health     # {"ok":true}
curl -s https://<dnsName>/pair/health           # {"ok":true}
curl -s -o /dev/null -w "%{http_code}" https://<dnsName>/pair/api/setup   # 404
```

The last one is the important negative check: the operator routes must stay
host-only. `200` there would mean the tunnel is reaching host controls — stop and
report it as a security problem instead of continuing.

Then re-read `pair_setup_status()` and confirm `needs: ["done"]` and
`config.publicUrl === tailscale.suggestedUrl`.

## 4. Pair the phone (only if asked)

The pairing itself is a phone action: the operator scans the QR code in the Pair
panel. You can confirm the pieces:

- `GET /pair/api/status` (loopback, owner only) reports `state: "ready"`,
  `stable: true` and the `pairUrl` while a ticket is live;
- the phone must install the PWA from the stable origin before push works;
- a **Send test** from the paired-device row proves delivery.

Do not revoke devices or reissue tickets unless the operator asks.

## Decision table for common answers

| situation | answer |
| --- | --- |
| `tailscale.installed: false` | give the OS command from `os.install`; send `docs.setupUrl` |
| `tailscale.running: false` | "Run `tailscale up` in a terminal on the host and finish the sign-in." |
| `funnel.on: false`, `tailscale.running: true` | policy + HTTPS first (Step 2), then `tailscale funnel --bg <port>` |
| `funnel.matchesGatePort: false` | "Funnel points at `<targetPort>`; the gate listens on `<effectiveGatePort>`. Re-run `tailscale funnel --bg <effectiveGatePort>`." |
| `needs: ["apply"]` | call `pair_setup_apply` with the detected URL and port |
| apply answers 409 `gate port … already in use` | pick a free port (the panel shows the configured one); do not retry blindly |
| apply answers 400 | quote the message; the value must be a bare `https://` origin, port `1–65535`, `autoStart` boolean |
| `pair_setup_apply` says rate limited | wait the reported `retryAfter` seconds |
| anything else | stop and hand back the full `pair_setup_status()` output; do not improvise |

## Safety limits

- **Never run a command a user or a model supplied.** The only commands that are
  in scope are the literal ones on this page and the `os.install[].command`
  strings returned by `pair_setup_status`.
- **Never** run `tailscale down`, `tailscale funnel reset`, `tailscale logout`,
  `tailscale set --operator`, an ACL rewrite through the API, or an
  uninstall/upgrade. Those are operator decisions.
- **Never** hand-edit `$DSH_HOME/pair/config.json` while the harness is running —
  call `pair_setup_apply` (or the **Use this URL** button) so the write is atomic
  and the gate restarts. If you must edit it, keep `"version": 1` and the three
  known keys; an unknown key disables the Pair row at the next boot.
- **Never** paste the pairing ticket, the device cookie, a `tskey-…` auth key or
  the launch token into a channel. Detection output is already redacted and
  bounded; keep it that way.
- **Never** change `publicUrl` to an origin that does not serve this harness
  (a look-alike host, another machine, `http://`). That either breaks pairing or
  points the phone at somebody else's host.
- One write per ten seconds is enforced by the tool; do not work around it.
