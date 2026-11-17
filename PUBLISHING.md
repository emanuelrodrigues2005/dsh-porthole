# Publishing `dsh-porthole`

Everything below runs from the package root (the directory holding
`package.json`). No build step exists: the package ships plain ESM, so what you
test is exactly what you publish.

## 0. Before the first publish

1. **Confirm the metadata.** `package.json` already carries the real author,
   repository, homepage and bugs (`github.com/emanuelrodrigues2005/dsh-porthole`),
   and `README.md` links to the same repository. Verify:

   ```sh
   node -e "const p=require('./package.json');console.log(p.name,p.author,p.repository.url)"
   ```

2. **Confirm the name is still free.** `dsh-pair` is taken by an unrelated
   package; this one publishes as `dsh-porthole` (checked free on 2026-11-17).

   ```sh
   npm view dsh-porthole version    # 404 = free; any version = pick another name
   ```

3. **Run the whole gate locally.** All four must be green before a publish:

   ```sh
   npm test            # node --test --test-isolation=none "pair/test/*.test.mjs"
   npm run check       # node scripts/check-package.mjs  (also runs on prepack)
   npm run pack:check  # npm pack --dry-run: the exact tarball file list
   npm pack            # real tarball, e.g. dsh-porthole-0.1.0.tgz
   ```

   `npm pack` lists the files it will ship. `pair/test/` must not appear: the
   tests stay in the repository and are excluded by the `files` list.

4. **Install the tarball into a throwaway profile** (see
   [Smoke test](#smoke-test-before-and-after-publishing)) before you publish, so
   a broken `files` list is caught while it is still local.

## 1. Publish to npm

```sh
npm login                       # opens the browser; verify with `npm whoami`
npm publish --access public     # scoped packages need the flag; harmless here
```

`prepack` runs `node scripts/check-package.mjs` automatically, so a package that
fails its own checks cannot be uploaded. `--access public` is required only for
scoped names (`@you/dsh-porthole`); it is safe for an unscoped name too.

Then tag the release:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Installing from the registry:

```sh
dsh plugin --profile web add dsh-porthole
```

## 2. Publish a tarball instead (no registry)

```sh
npm pack                                  # dsh-porthole-0.1.0.tgz
dsh plugin --profile web add ./dsh-porthole-0.1.0.tgz
```

The tarball install needs no registry account and no build permission, so it is
the right channel for an internal machine. Attach the `.tgz` to a GitHub release
and give users the download path.

## 3. GitHub install

```sh
dsh plugin --profile web add github:<your-github-user>/dsh-porthole
```

A git install fetches **sources, not build artifacts**. This package has no
build step, so it is loadable straight from the checkout — but pnpm ≥10 still
refuses to run a git dependency's `prepare` script until it is allowlisted. If
pnpm prints an `allowBuilds` request, copy the exact package key it names into
the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-porthole: true
```

and re-run the `add`. That allowance is **permission to execute the package's
code at install time**, outside any agent sandbox: grant it only for a
repository you trust, and pin a commit so a later push cannot change what runs:

```sh
dsh plugin --profile web add github:<your-github-user>/dsh-porthole#<sha>
```

Do not add a `prepare` script to this package unless a build is actually
introduced; today it would only cost users the allowance above.

## 4. Versioning

`engines.dsh` is `>=0.2.2-rc.2 <0.3.0-0`: installation and profile startup
refuse the bundle on a harness outside that range. Keep the two in step.

| change | version |
| --- | --- |
| a fix that keeps the row config and route contract | patch (`0.1.x`) |
| a new config key, a new route, a new notification category | minor (`0.x.0`) |
| a renamed/removed key, a changed cookie or route contract, a new `engines.dsh` floor | major, or a documented breaking minor while pre-1.0 |

When you bump `engines.dsh` (for example to `>=0.3.0-0 <0.4.0-0`), that is a
breaking change for users on the old harness: publish it as its own version and
say so in the release notes. Update `version` in `package.json` only — the
bundle patch and the client module id are name-based, not version-based.

`.gitignore` should keep `node_modules/` and `*.tgz` out of the repository.

## 5. Smoke test (before and after publishing)

Use a throwaway `DSH_HOME` so the live profile is never touched. In PowerShell:

```powershell
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-pair-smoke-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
$env:DSH_HOME = $tmp
dsh plugin --profile check add ./dsh-porthole-0.1.0.tgz   # or: add dsh-porthole
dsh --profile check --dump-config | Select-String -Context 0,10 "dsh-pair"
```

Expected: a `# == dsh-porthole` layer and a `dsh-pair` row carrying exactly
the six keys `gatePort`, `deviceTtlDays`, `ticketTtlSeconds`, `cloudflaredPath`,
`publicUrl`, `autoStart`. Then boot it once and open the GUI on loopback:

```powershell
dsh --profile check
```

and confirm **Pair** appears in the sidebar and the panel goes
`off → starting → ready` after **Start pairing**. Finally, remove the throwaway
home:

```powershell
Remove-Item -Recurse -Force $tmp
```

`node scripts/check-package.mjs` performs the same structural checks the smoke
test proves end to end (row name, config keys, client id, tarball contents).

## 6. Release checklist

- [ ] placeholders replaced (`author`, `repository`, `homepage`, `bugs`, README)
- [ ] `version` bumped as described above
- [ ] `npm test` green, `npm run check` `ok`
- [ ] `npm pack` lists only the intended files, no `pair/test/`
- [ ] tarball installed into a throwaway `DSH_HOME`, `--dump-config` shows the row
- [ ] `engines.dsh` still matches the harness release you tested on
- [ ] `git tag v<version>` pushed
