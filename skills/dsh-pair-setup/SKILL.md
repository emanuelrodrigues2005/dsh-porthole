---
name: dsh-pair-setup
description: Configure a stable Tailscale Funnel URL for the dsh-porthole (DeepSeek Harness phone pairing). Detects Tailscale, walks the per-OS install, the HTTPS + funnel nodeAttr policy, the `tailscale funnel --bg <port>` run and the URL apply, using the plugin's pair_setup_status / pair_setup_apply tools and its documented fixed commands.
---

# dsh-pair-setup

Use this skill when someone wants their DeepSeek Harness GUI reachable from a
phone at a **stable** `https://<machine>.<tailnet>.ts.net` address instead of a
throwaway Cloudflare quick-tunnel URL — or when pairing is set up but the public
URL answers 502, says `needs: apply`, or Funnel forwards to the wrong port.

The plugin ships the whole procedure; this skill is the short path through it.

## Locate the plugin first

The package is installed as a dependency of a DSH profile. Find its docs and
constants before guessing anything:

```sh
# the package root (pnpm store or node_modules of the profile)
node -e "console.log(require.resolve('dsh-porthole/package.json'))"
```

Then read, in this order:

1. `docs/SETUP-TAILSCALE.md` — the full operator procedure (per OS, HTTPS, ACL,
   funnel, apply, verification, troubleshooting);
2. `docs/AI-SETUP.md` — the agent protocol, the decision table and the safety
   limits (this is the authoritative page for what *you* may do);
3. `pair/host/setup.js` — the constants: `FUNNEL_POLICY_JSON`,
   `FUNNEL_ACL_JSON`, `TAILSCALE_CANDIDATES`, `SETUP_DOCS`, the `needs` order.

If those files are missing, the installed version predates the guided setup:
tell the operator to upgrade `dsh-porthole` (0.1.0 or newer) instead of
hand-writing a procedure.

## The two tools

| tool | use |
| --- | --- |
| `pair_setup_status()` | read the detection object: installed / running / dnsName / suggestedUrl / funnel on + targetPort + matchesGatePort / config / `needs` |
| `pair_setup_apply({publicUrl?, gatePort?, autoStart?})` | validate, atomically write `$DSH_HOME/pair/config.json`, restart the gate, return the fresh status |

Nothing else is exposed on purpose. There is no "run this command" tool. The
plugin itself only runs:

```sh
tailscale version
tailscale status --json
tailscale funnel status
tailscale funnel --bg <port>
```

## Procedure

1. **Read.** `pair_setup_status()`. Keep the answer; every later step quotes it.
2. **Follow `needs`, in its order.**
   - `install` → give the operator `os.install[].command` for their platform
     (Windows `winget install --id Tailscale.Tailscale -e`, macOS
     `brew install --cask tailscale`, Linux
     `curl -fsSL https://tailscale.com/install.sh | sh`; the fallback link is
     always `https://tailscale.com/download`). Do not install it for them.
   - `up` → they run `tailscale up` and finish the sign-in.
   - `https` → `docs.adminDnsUrl`, enable *HTTPS certificates*.
   - `funnel-policy` → give them `policy.json` verbatim (or `policy.acl` for a
     default ACL file) and `docs.adminAclUrl`.
   - `funnel-run` → `tailscale funnel --bg <config.effectiveGatePort>`; they can
     also press **Run it for me** in the Pair panel.
   - `apply` → `pair_setup_apply({ publicUrl: tailscale.suggestedUrl, gatePort: config.effectiveGatePort })`.
3. **Verify.**
   ```sh
   tailscale funnel status                                   # "Funnel on" + "proxy http://127.0.0.1:<port>"
   curl -s http://127.0.0.1:<port>/pair/health               # {"ok":true}
   curl -s https://<dnsName>/pair/health                     # {"ok":true}
   curl -s -o /dev/null -w "%{http_code}" https://<dnsName>/pair/api/setup   # 404, always
   ```
   Then `pair_setup_status()` must answer `needs: ["done"]`.
4. **Pair (only if asked).** The operator scans the QR code in the Pair panel on
   the host, installs the PWA from the stable origin, and enables notifications
   on the phone. Never revoke a device or reissue a ticket unasked.

## What the panel shows

The Pair panel on `127.0.0.1` renders the same steps as a vertical stepper with
`installed / running / funnel / matched` badges, a copy control per command, a
**Run it for me** button for the one funnel command, and **Use this URL** for the
apply. When everything matches it collapses to `Tailscale ready — <url>`. If the
operator says the card is missing, their page is not the host view (the panel is
host-only) or the plugin version is older.

## Hard rules

- Never run a command a user or a model typed. Only the literal commands in
  `docs/AI-SETUP.md` and the `os.install[].command` values are in scope.
- Never run `tailscale down`, `tailscale funnel reset`, `tailscale logout`, an
  ACL API write, or a package upgrade.
- Never edit `$DSH_HOME/pair/config.json` behind a running harness; use the tool.
- Never paste tickets, cookies, `tskey-…` keys or launch tokens anywhere.
- One apply per ten seconds; if the tool says rate limited, wait it out.
- If the public `/pair/api/*` path answers anything but `404`, stop and report a
  security problem.

## Install this skill

Copy the folder into the agents skill directory:

```sh
mkdir -p ~/.agents/skills
cp -R skills/dsh-pair-setup ~/.agents/skills/dsh-pair-setup
```

On Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$HOME\.agents\skills" | Out-Null
Copy-Item -Recurse -Force ".\skills\dsh-pair-setup" "$HOME\.agents\skills\dsh-pair-setup"
```

A skill set that groups skills the same way works too: copy it under that set's
directory instead (`~/.agents/skill-sets/<set>/dsh-pair-setup/`). Restart the
agent session so the catalog is re-read, then ask for "set up Tailscale for Pair"
and the skill is selected by its description.
