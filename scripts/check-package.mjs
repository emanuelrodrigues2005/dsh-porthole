#!/usr/bin/env node
/**
 * Package checks for `dsh-porthole`.
 *
 * Node built-ins only — no dev dependencies, no build step. Run it directly
 * (`node scripts/check-package.mjs`) or through the package scripts (`check`,
 * `prepack`). It exits 1 and lists every failed expectation; a clean run prints
 * one line per check plus a final `ok`.
 *
 * What it pins:
 *   1. package.json carries the bundle/profile contract DSH reads.
 *   2. Every entry in `files` matches at least one real file, and nothing under
 *      `pair/test` ships (tests are not part of the tarball).
 *   3. The bundle patch inserts exactly one row whose `name` is the package name.
 *   4. The patch config keys are exactly the `CONFIG_KEYS` the host plugin
 *      accepts — an extra or missing key would silently disable the row.
 *   5. The client module registers under the package name.
 *   6. The Tailscale setup surface: the fixed commands, the byte-exact policy
 *      block, the three routes, the two agent tools and the endpoints the panel
 *      calls.
 *   7. The bundled docs (`docs/SETUP-TAILSCALE.md`, `docs/AI-SETUP.md`) and the
 *      `skills/dsh-pair-setup` skill are present and cover the procedure.
 *   8. No source file carries an absolute user home path, a private key, or a
 *      cloud token, and none references another bundle.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every failure is collected so one run reports the whole list. */
const failures = []
const passes = []

function check(label, condition, detail = '') {
  if (condition) {
    passes.push(label)
    return true
  }
  failures.push(detail === '' ? label : `${label} — ${detail}`)
  return false
}

function read(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

/** Recursively list files under `dir`, POSIX-style and relative to `ROOT`. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) walk(absolute, out)
    else if (entry.isFile()) out.push(relative(ROOT, absolute).split('\\').join('/'))
  }
  return out
}

/**
 * Expands a `files` entry to the real paths it selects. Supports the two
 * patterns npm packages actually use here: a literal path, and `*` / `**`
 * globs. Directory entries select everything beneath them, as npm does.
 */
function expand(entry, tree) {
  if (!entry.includes('*')) {
    const absolute = join(ROOT, entry)
    try {
      if (statSync(absolute).isFile()) return [entry]
      if (statSync(absolute).isDirectory()) return tree.filter(path => path.startsWith(`${entry}/`))
    } catch {
      return []
    }
    return []
  }
  const source = entry
    .split('**')
    .map(chunk => chunk
      .split('*')
      .map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*'))
    .join('.*')
  const matcher = new RegExp(`^${source}$`)
  return tree.filter(path => matcher.test(path))
}

const tree = walk(ROOT)

// ---------------------------------------------------------------------------
// 1. package.json
// ---------------------------------------------------------------------------
const pkg = JSON.parse(read('package.json'))
const NAME = pkg.name

check('name is dsh-porthole', NAME === 'dsh-porthole', `got ${String(NAME)}`)
check('version is semver', /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(pkg.version)), String(pkg.version))
check('description is a non-trivial string', typeof pkg.description === 'string' && pkg.description.length >= 40)
check('license is MIT', pkg.license === 'MIT', String(pkg.license))
check('type is module', pkg.type === 'module', String(pkg.type))
check('main is ./index.js', pkg.main === './index.js', String(pkg.main))
check('main exists', tree.includes('index.js'))
for (const keyword of ['dsh-plugin', 'dsh', 'deepseek-harness', 'pair', 'remote', 'pwa', 'push', 'tunnel']) {
  check(`keyword ${keyword}`, Array.isArray(pkg.keywords) && pkg.keywords.includes(keyword))
}
check('author is declared', typeof pkg.author === 'string' && pkg.author.length > 0)
check('repository is declared', typeof pkg.repository?.url === 'string' && pkg.repository.url.length > 0)
check('homepage is declared', typeof pkg.homepage === 'string' && pkg.homepage.length > 0)
check('bugs is declared', typeof pkg.bugs?.url === 'string' && pkg.bugs.url.length > 0)
check(
  'no runtime dependencies',
  (pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0)
    && (pkg.devDependencies === undefined || Object.keys(pkg.devDependencies).length === 0),
)
for (const target of ['.', './client', './package.json']) {
  const value = pkg.exports?.[target]
  const path = typeof value === 'string' ? value : value?.default
  check(`exports ${target} resolves to an existing file`, typeof path === 'string' && tree.includes(path.replace(/^\.\//, '')), String(path))
}
check('dsh.bundle.patch is ./cordis.patch.yml', pkg.dsh?.bundle?.patch === './cordis.patch.yml', String(pkg.dsh?.bundle?.patch))
check('dsh.client.platform is web', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))
check('dsh.client.immediately is true', pkg.dsh?.client?.immediately === true)
check(
  'dsh.client.inject names the sidebar and layout services',
  Array.isArray(pkg.dsh?.client?.inject)
    && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar')
    && pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'),
)
check('engines.node is >=22', pkg.engines?.node === '>=22', String(pkg.engines?.node))
check(
  'engines.dsh gates the supported harness range',
  typeof pkg.engines?.dsh === 'string' && /^>=.*<0\.3\.0-0$/.test(pkg.engines.dsh),
  String(pkg.engines?.dsh),
)
for (const script of ['test', 'check', 'prepack', 'pack:check']) {
  check(`script ${script}`, typeof pkg.scripts?.[script] === 'string' && pkg.scripts[script].length > 0)
}

// ---------------------------------------------------------------------------
// 2. files
// ---------------------------------------------------------------------------
check('files is a non-empty array', Array.isArray(pkg.files) && pkg.files.length > 0)
const shipped = new Set()
for (const entry of pkg.files ?? []) {
  const matches = expand(entry, tree)
  check(`files entry ${entry} matches a real file`, matches.length > 0)
  for (const match of matches) {
    shipped.add(match)
    check(`files entry ${entry} does not ship ${match}`, !match.startsWith('pair/test/'), 'pair/test is excluded from the tarball')
  }
}
for (const required of [
  'index.js',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'icon.svg',
  'docs/DETAIL.md',
  'docs/SETUP-TAILSCALE.md',
  'docs/AI-SETUP.md',
  'skills/dsh-pair-setup/SKILL.md',
  'pair/client/client.js',
  'pair/host/gate.js',
  'pair/host/setup.js',
  'pair/host/setup-tool.js',
  'pair/host/sw.js',
  'pair/host/vendor/qrcodegen.js',
]) {
  check(`shipped file ${required}`, shipped.has(required))
}
check(
  'pair/test is not in the files list',
  !(pkg.files ?? []).some(entry => entry === 'pair' || entry.startsWith('pair/test')),
)

// ---------------------------------------------------------------------------
// 3. bundle patch row
// ---------------------------------------------------------------------------
const PATCH_PATH = pkg.dsh?.bundle?.patch ?? ''
const patch = PATCH_PATH === '' ? '' : read(PATCH_PATH.replace(/^\.\//, ''))
const patchLines = patch.split(/\r?\n/)

/** Parses the single inserted row without a YAML dependency. */
function parsePatchRow(lines) {
  const start = lines.findIndex(line => /^\s*-\s+id:\s*\S/.test(line))
  if (start === -1) return null
  const rowIndent = lines[start].length - lines[start].trimStart().length
  const row = { id: null, name: null, disabled: false, configKeys: [] }
  let inConfig = false
  let configIndent = -1
  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index]
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    if (index > start && indent <= rowIndent && /^\s*-/.test(raw)) break
    const trimmed = raw.trim().replace(/^-\s+/, '')
    const colon = trimmed.indexOf(':')
    if (colon === -1) continue
    const key = trimmed.slice(0, colon).trim()
    const value = trimmed.slice(colon + 1).trim()
    if (inConfig && indent <= configIndent) inConfig = false
    if (key === 'config' && value === '') {
      inConfig = true
      configIndent = indent
      continue
    }
    if (inConfig) {
      row.configKeys.push(key)
      continue
    }
    if (key === 'id') row.id = value.replace(/^['"]|['"]$/g, '')
    if (key === 'name') row.name = value.replace(/^['"]|['"]$/g, '')
    if (key === 'disabled') row.disabled = true
  }
  return row
}

const row = parsePatchRow(patchLines)
check('the patch inserts exactly one row', patchLines.filter(line => /^\s*-\s+id:/.test(line)).length === 1)
check('the patch row exists', row !== null)
if (row !== null) {
  check('the patch row id is dsh-porthole', row.id === 'dsh-porthole', String(row.id))
  check('the patch row name is the package name', row.name === NAME, `row name ${String(row.name)} !== package name ${String(NAME)}`)
  check('the patch row is env-disablable', row.disabled === true)
}

// ---------------------------------------------------------------------------
// 4. patch config keys === CONFIG_KEYS
// ---------------------------------------------------------------------------
const hostSource = read('index.js')
const configKeysMatch = hostSource.match(/const CONFIG_KEYS = new Set\(\[([\s\S]*?)\]\)/)
check('index.js declares CONFIG_KEYS as a Set', configKeysMatch !== null)
const configKeys = configKeysMatch === null
  ? []
  : [...configKeysMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1])
check('CONFIG_KEYS has six keys', configKeys.length === 6, configKeys.join(', '))

const sortedConfig = [...configKeys].sort()
const sortedPatch = [...(row?.configKeys ?? [])].sort()
const missing = sortedConfig.filter(key => !sortedPatch.includes(key))
const extra = sortedPatch.filter(key => !sortedConfig.includes(key))
check(
  'the patch config keys match CONFIG_KEYS exactly',
  missing.length === 0 && extra.length === 0,
  `missing [${missing.join(', ')}] extra [${extra.join(', ')}]`,
)

// ---------------------------------------------------------------------------
// 5. client module id
// ---------------------------------------------------------------------------
const clientSource = read('pair/client/client.js')
const clientId = clientSource.match(/window\.__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)?.[1]
check('the client module registers through window.__ModuleLoader__.load', clientId !== undefined)
check('the client module id is the package name', clientId === NAME, `client id ${String(clientId)} !== package name ${String(NAME)}`)

// ---------------------------------------------------------------------------
// 5b. the Tailscale setup surface
// ---------------------------------------------------------------------------
const setupSource = read('pair/host/setup.js')
const setupToolSource = read('pair/host/setup-tool.js')
const routesSource = read('pair/host/routes.js')

check('setup.js exports createSetupService', /export function createSetupService\b/.test(setupSource))
check(
  'setup.js pins the Funnel policy block byte-exact',
  setupSource.includes('\'{"nodeAttrs":[{"target":["autogroup:member"],"attr":["funnel"]}]}\''),
)
for (const command of ['winget install --id Tailscale.Tailscale -e', 'brew install --cask tailscale', 'curl -fsSL https://tailscale.com/install.sh | sh']) {
  check(`setup.js offers the install command ${command}`, setupSource.includes(command))
}
for (const probe of [
  "['version']",
  "['status', '--json']",
  "['funnel', 'status']",
  "['funnel', '--bg', String(port)]",
]) {
  check(`setup.js runs the fixed probe ${probe}`, setupSource.includes(probe))
}
check('setup.js never enables a shell', !/shell:\s*true/u.test(setupSource) && setupSource.includes('shell: false'))
check('setup.js never opens a console window', setupSource.includes('windowsHide: true'))
check('setup.js uses a 5 s probe timeout', /COMMAND_TIMEOUT_MS = 5_000/u.test(setupSource))
check('setup.js uses a 15 s funnel timeout', /FUNNEL_TIMEOUT_MS = 15_000/u.test(setupSource))
check('setup.js writes the override atomically', /renameSync\(/u.test(setupSource) && /mode: 0o600/u.test(setupSource))
check(
  'setup.js declares the seven needs states',
  ['install', 'up', 'https', 'funnel-policy', 'funnel-run', 'apply', 'done'].every(state => setupSource.includes(`'${state}'`)),
)
check(
  'setup-tool.js registers both agent tools',
  setupToolSource.includes("'pair_setup_status'")
    && setupToolSource.includes("'pair_setup_apply'")
    && /registerSetupTool/u.test(setupToolSource),
)
check(
  'setup-tool.js limits apply to one call per ten seconds',
  /APPLY_RATE_LIMIT_MS = 10_000/u.test(setupToolSource),
)
for (const path of ['/pair/api/setup', '/pair/api/setup/apply', '/pair/api/setup/funnel']) {
  check(`routes.js registers ${path}`, routesSource.includes(`path: '${path}'`))
}
check('routes.js registers the setup routes on the shared dispatcher', /export function registerSetupRoutes/u.test(routesSource))
check(
  'index.js wires the setup service, routes and tools',
  hostSource.includes('createSetupService')
    && hostSource.includes('registerSetupRoutes')
    && hostSource.includes('registerSetupTool')
    && hostSource.includes("join(stateDir, 'config.json')"),
)
const clientSetupCalls = ['/pair/api/setup', '/pair/api/setup/apply', '/pair/api/setup/funnel']
for (const endpoint of clientSetupCalls) {
  check(`the client bundle calls ${endpoint}`, clientSource.includes(`'${endpoint}'`))
}
for (const marker of ['Tailscale setup', 'Run it for me', 'Use this URL', 'Check again', 'Tailscale ready']) {
  check(`the client bundle renders "${marker}"`, clientSource.includes(marker))
}

// ---------------------------------------------------------------------------
// 5c. the bundled docs and the agent skill
// ---------------------------------------------------------------------------
const tailscaleDoc = read('docs/SETUP-TAILSCALE.md')
const aiDoc = read('docs/AI-SETUP.md')
const skillDoc = read('skills/dsh-pair-setup/SKILL.md')

for (const command of ['winget install --id Tailscale.Tailscale -e', 'brew install --cask tailscale', 'curl -fsSL https://tailscale.com/install.sh | sh', 'tailscale funnel --bg 8791']) {
  check(`docs/SETUP-TAILSCALE.md documents ${command}`, tailscaleDoc.includes(command))
}
for (const detail of [
  '{"nodeAttrs":[{"target":["autogroup:member"],"attr":["funnel"]}]}',
  'https://login.tailscale.com/admin/dns',
  'https://login.tailscale.com/admin/acls/file',
  '/pair/health',
  'config.json',
  '502',
  'ERR_CONNECTION_CLOSED',
  'Tailscale is not installed',
]) {
  check(`docs/SETUP-TAILSCALE.md covers ${detail}`, tailscaleDoc.includes(detail))
}
for (const detail of ['pair_setup_status', 'pair_setup_apply', 'rate limited', 'Never run a command']) {
  check(`docs/AI-SETUP.md covers ${detail}`, aiDoc.includes(detail))
}
const skillFrontMatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(skillDoc)
check('the skill opens with frontmatter', skillFrontMatter !== null)
const frontMatter = skillFrontMatter === null ? '' : skillFrontMatter[1]
check('the skill name is dsh-pair-setup', /^name:\s*dsh-pair-setup\s*$/mu.test(frontMatter))
check(
  'the skill has a substantial description',
  /^description:\s*\S.{39,}$/mu.test(frontMatter),
)
check(
  'the skill teaches the two tools and the fixed commands',
  skillDoc.includes('pair_setup_status')
    && skillDoc.includes('pair_setup_apply')
    && skillDoc.includes('tailscale funnel --bg'),
)
check('the skill documents installing itself', /\.agents[\\/]skills/u.test(skillDoc))
check('the skill points at the plugin docs', skillDoc.includes('docs/SETUP-TAILSCALE.md') && skillDoc.includes('docs/AI-SETUP.md'))

// ---------------------------------------------------------------------------
// 6. locale / icon / docs presence
// ---------------------------------------------------------------------------
for (const locale of ['locale/en.json', 'locale/pt.json']) {
  check(`${locale} exists`, tree.includes(locale))
  if (!tree.includes(locale)) continue
  const parsed = JSON.parse(read(locale))
  const meta = parsed.meta ?? {}
  check(`${locale} declares meta.title`, typeof meta.title === 'string' && meta.title.length > 0)
  check(`${locale} declares a meta.description`, typeof meta.description === 'string' && meta.description.length >= 40)
  check(`${locale} detail page ${String(meta.detail)} exists`, tree.includes(String(meta.detail)))
}

// ---------------------------------------------------------------------------
// 7. no absolute user paths, no secrets, no other bundle
// ---------------------------------------------------------------------------
// Patterns are assembled so this file never matches its own scan.
const homeMarker = ['C', ':', '\\', 'Users', '\\'].join('')
const HOME_PATHS = [homeMarker, ['/', 'home', '/'].join(''), ['/', 'Users', '/'].join('')]
/** PEM headers are assembled too, so a plain text search stays meaningful. */
const pemHeader = kind => ['-----', 'BEGIN ', kind, 'PRIVATE KEY-----'].join('')
const SECRETS = [
  pemHeader(''),
  pemHeader('RSA '),
  pemHeader('EC '),
  ['gh', 'p_', '[A-Za-z0-9]{20,}'].join(''),
  ['AK', 'IA', '[0-9A-Z]{16}'].join(''),
  ['xo', 'x[abp]-[A-Za-z0-9-]{10,}'].join(''),
  ['np', 'm_[A-Za-z0-9]{36}'].join(''),
]

const scanned = tree
// Names are assembled so this file never matches its own scan.
const OTHER_BUNDLE = ['dsh', 'preset', 'equipe'].join('-')
for (const path of scanned) {
  let text
  try {
    text = readFileSync(join(ROOT, path), 'utf8')
  } catch {
    continue
  }
  if (text.includes('\u0000')) continue
  for (const marker of HOME_PATHS) {
    check(`${path} has no absolute user path`, !text.includes(marker), marker)
  }
  for (const pattern of SECRETS) {
    check(`${path} has no embedded secret`, !new RegExp(pattern).test(text), pattern)
  }
  check(`${path} does not reference another bundle`, !text.includes(OTHER_BUNDLE), OTHER_BUNDLE)
}

// ---------------------------------------------------------------------------
// 8. npm's own tarball list, when npm is available
// ---------------------------------------------------------------------------
if (process.env.DSH_PAIR_SKIP_NPM_CHECK !== '1') {
  // `--ignore-scripts` keeps `prepack` from re-entering this script. The command
  // is one string because Windows needs a shell to launch `npm.cmd`.
  const packed = spawnSync('npm pack --dry-run --json --ignore-scripts', {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
  })
  const output = typeof packed.stdout === 'string' ? packed.stdout : ''
  // npm answers either an array of pack records or an object keyed by package.
  let report = null
  try {
    report = JSON.parse(output)
  } catch {
    const first = output.indexOf('{')
    const last = output.lastIndexOf('}')
    if (first !== -1 && last > first) {
      try {
        report = JSON.parse(output.slice(first, last + 1))
      } catch {
        report = null
      }
    }
  }
  const record = report === null
    ? null
    : (Array.isArray(report) ? report[0] : Object.values(report)[0])
  if (packed.error !== undefined || packed.status !== 0 || record === null) {
    check('npm pack --dry-run reports the tarball list', false, 'run `npm pack --dry-run` by hand')
  } else {
    const paths = (record.files ?? []).map(entry => entry.path)
    check('the tarball lists at least one file', paths.length > 0)
    check(
      'the tarball excludes pair/test',
      !paths.some(path => path.startsWith('pair/test/')),
      paths.filter(path => path.startsWith('pair/test/')).join(', '),
    )
    check(
      'the tarball contains every shipped file the checks pin',
      [
        'index.js',
        'cordis.patch.yml',
        'README.md',
        'LICENSE',
        'docs/DETAIL.md',
        'docs/SETUP-TAILSCALE.md',
        'docs/AI-SETUP.md',
        'skills/dsh-pair-setup/SKILL.md',
        'pair/host/setup.js',
        'pair/host/setup-tool.js',
      ].every(path => paths.includes(path)),
      paths.join(', '),
    )
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
for (const label of passes) console.log(`  ok  ${label}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} package check(s) failed:`)
  for (const failure of failures) console.error(`  FAIL  ${failure}`)
  process.exitCode = 1
} else {
  console.log(`\n${passes.length} checks passed`)
  console.log('ok')
}
