/**
 * Contract tests for pair/host/setup.js — Tailscale detection.
 *
 * The CLI is injected: every probe is a fake `execFile` that answers by argv, so
 * these tests prove exactly which commands the module may run and how their
 * output becomes the object the panel, the routes and the tools consume.
 *
 * What is pinned:
 *   - the candidate order (PATH name first, then the per-OS absolute paths);
 *   - `version` → installed + version, `status --json` → running / DNSName /
 *     IPs, `funnel status` → on / public URL / proxy port;
 *   - `needs` for installed, running, funnel-on, mismatched port and done;
 *   - the per-OS install commands and links;
 *   - the byte-exact Funnel policy block;
 *   - `runFunnel()` runs only `tailscale funnel --bg <configured port>`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  COMMAND_TIMEOUT_MS,
  DEFAULT_PUBLIC_GATE_PORT,
  FUNNEL_ACL_JSON,
  FUNNEL_POLICY_JSON,
  FUNNEL_TIMEOUT_MS,
  SETUP_DOCS,
  TAILSCALE_CANDIDATES,
  TAILSCALE_DOWNLOAD_URL,
  computeNeeds,
  createSetupService,
  effectiveGatePort,
  installGuidance,
  normalizePublicUrl,
  normalizeSetupPatch,
  parseFunnelStatus,
  parseTailscaleStatus,
  parseVersion,
  redactOutput,
} from '../host/setup.js'

const TS_HOST = 'studio.tailnet-abc.ts.net'
const TS_URL = `https://${TS_HOST}`

const STATUS_JSON = JSON.stringify({
  BackendState: 'Running',
  Self: {
    DNSName: `${TS_HOST}.`,
    TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
  },
})

/** A funnel that forwards to `port`. */
function funnelStatus(port = DEFAULT_PUBLIC_GATE_PORT) {
  return [
    '# Funnel on:',
    `#     - ${TS_URL}`,
    `#     - http://100.101.102.103:${port}`,
    '',
    `${TS_URL} (Funnel on)`,
    `|-- / proxy http://127.0.0.1:${port}`,
    '',
  ].join('\n')
}

const FUNNEL_OFF = ['No funnel is set up.', '', 'To enable funnel, run:', '\ttailscale funnel 8791', ''].join('\n')

/**
 * Answers like a CLI: `answers` is a map from `"binary args"` to
 * `{code, stdout, stderr}`; anything not listed fails with ENOENT.
 */
function createFakeExecFile(answers) {
  const calls = []
  const execFile = (binary, args, options, callback) => {
    const key = `${binary} ${args.join(' ')}`
    calls.push({ binary, args: [...args], options, key })
    const answer = answers[key]
    if (answer === undefined) {
      const error = new Error(`spawn ${binary} ENOENT`)
      error.code = 'ENOENT'
      callback(error, '', '')
      return
    }
    const error = answer.code === undefined || answer.code === 0 ? null : Object.assign(new Error('failed'), { code: answer.code })
    callback(error, answer.stdout ?? '', answer.stderr ?? '')
  }
  return { execFile, calls, keys: () => calls.map(call => call.key) }
}

function createSetup(execFile, { config = {}, candidates = TAILSCALE_CANDIDATES, platform = 'win32', restarts = [], resolveBinary } = {}) {
  return createSetupService({
    stateDir: 'C:\\state\\pair',
    configFile: 'C:\\state\\pair\\config.json',
    platform,
    candidates,
    execFile,
    getConfig: () => ({
      gatePort: 0,
      publicUrl: '',
      autoStart: true,
      cloudflaredPath: '',
      ...config,
    }),
    restart: async () => {
      restarts.push('restart')
    },
    resolveBinary: resolveBinary ?? (async () => {
      throw new Error('no cloudflared here')
    }),
  })
}

/**
 * The standard answers for one healthy machine. `config.gatePort` decides which
 * port the fake funnel forwards to.
 */
function healthyAnswers({ port = DEFAULT_PUBLIC_GATE_PORT, funnel = funnelStatus(port), version = '1.68.1' } = {}) {
  return {
    'tailscale version': { stdout: `${version}\n  tailscale commit: deadbeef\n` },
    'tailscale status --json': { stdout: STATUS_JSON },
    'tailscale funnel status': { stdout: funnel },
  }
}

test('the CLI candidate order starts with PATH and lists the per-OS absolute paths', () => {
  assert.deepEqual([...TAILSCALE_CANDIDATES], [
    'tailscale',
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  ])
})

test('a missing CLI reports install, without throwing, after one probe per candidate', async () => {
  const fake = createFakeExecFile({})
  const setup = createSetup(fake.execFile)

  const status = await setup.status()

  assert.equal(status.ok, true)
  assert.equal(status.tailscale.installed, false)
  assert.equal(status.tailscale.version, null)
  assert.equal(status.tailscale.running, false)
  assert.equal(status.tailscale.suggestedUrl, null)
  assert.equal(status.funnel.on, false)
  assert.deepEqual(status.needs, ['install'])
  assert.deepEqual(fake.keys(), TAILSCALE_CANDIDATES.map(candidate => `${candidate} version`))
  for (const call of fake.calls) {
    assert.equal(call.options.shell, false, 'tailscale must never run through a shell')
    assert.equal(call.options.windowsHide, true, 'tailscale must never open a console window')
    assert.equal(call.options.timeout, COMMAND_TIMEOUT_MS)
  }
})

test('the first candidate that answers version wins and is used for every probe', async () => {
  const fake = createFakeExecFile(healthyAnswers())
  const setup = createSetup(fake.execFile)

  const status = await setup.status()

  assert.equal(status.tailscale.installed, true)
  assert.equal(status.tailscale.version, '1.68.1')
  assert.equal(status.tailscale.binary, 'tailscale')
  assert.deepEqual(fake.keys(), [
    'tailscale version',
    'tailscale status --json',
    'tailscale funnel status',
  ])
})

test('an absolute candidate is used when the PATH name fails', async () => {
  const answers = healthyAnswers()
  const absolute = 'C:\\Program Files\\Tailscale\\tailscale.exe'
  const renamed = {}
  for (const [key, value] of Object.entries(answers)) {
    renamed[key.replace(/^tailscale /u, `${absolute} `)] = value
  }
  const fake = createFakeExecFile(renamed)
  const setup = createSetup(fake.execFile)

  const status = await setup.status()

  assert.equal(status.tailscale.installed, true)
  assert.equal(status.tailscale.binary, absolute)
  assert.equal(fake.calls[0].key, 'tailscale version')
})

test('status --json yields running, the dot-less DNSName and the suggested https URL', async () => {
  const fake = createFakeExecFile(healthyAnswers())
  const setup = createSetup(fake.execFile)

  const status = await setup.status()

  assert.equal(status.tailscale.running, true)
  assert.equal(status.tailscale.dnsName, TS_HOST)
  assert.equal(status.tailscale.suggestedUrl, TS_URL)
  assert.deepEqual(status.tailscale.tailscaleIPs, ['100.101.102.103', 'fd7a:115c:a1e0::1'])
})

test('a stopped backend is "installed but not running" and asks for up', async () => {
  const answers = healthyAnswers()
  answers['tailscale status --json'] = {
    code: 1,
    stdout: JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: `${TS_HOST}.`, TailscaleIPs: [] } }),
  }
  const fake = createFakeExecFile(answers)
  const setup = createSetup(fake.execFile)

  const status = await setup.status()

  assert.equal(status.tailscale.running, false)
  assert.deepEqual(status.needs, ['up'])
})

test('parseTailscaleStatus never throws on garbage and strips the trailing dot', () => {
  assert.deepEqual(parseTailscaleStatus(''), { running: false, dnsName: null, tailscaleIPs: [] })
  assert.deepEqual(parseTailscaleStatus('not json'), { running: false, dnsName: null, tailscaleIPs: [] })
  assert.deepEqual(parseTailscaleStatus('{"BackendState":'), { running: false, dnsName: null, tailscaleIPs: [] })
  assert.equal(parseTailscaleStatus(STATUS_JSON).dnsName, TS_HOST)
  assert.equal(parseVersion('1.68.1\n  tailscale commit: abc'), '1.68.1')
  assert.equal(parseVersion('tailscale v2.0.0-rc1'), '2.0.0')
  assert.equal(parseVersion('no version here'), null)
})

test('funnel status parsing: on, public URL and proxy port', () => {
  assert.deepEqual(parseFunnelStatus(funnelStatus(8791)), {
    on: true,
    url: TS_URL,
    targetPort: 8791,
  })
  assert.deepEqual(parseFunnelStatus(FUNNEL_OFF), { on: false, url: null, targetPort: null })
  assert.deepEqual(parseFunnelStatus(''), { on: false, url: null, targetPort: null })
  // A funnel on a non-default port is still parsed.
  assert.equal(parseFunnelStatus(funnelStatus(9443)).targetPort, 9443)
})

test('funnel on and matching the configured gate port leaves only apply', async () => {
  const fake = createFakeExecFile(healthyAnswers())
  const setup = createSetup(fake.execFile, { config: { gatePort: 8791 } })

  const status = await setup.status()

  assert.deepEqual(status.funnel, {
    on: true,
    url: TS_URL,
    targetPort: 8791,
    matchesGatePort: true,
  })
  assert.deepEqual(status.needs, ['apply'])
  assert.equal(status.config.effectiveGatePort, 8791)
})

test('a funnel on the wrong port asks to run the funnel again', async () => {
  const fake = createFakeExecFile(healthyAnswers({ port: 3000 }))
  const setup = createSetup(fake.execFile, { config: { gatePort: 8791 } })

  const status = await setup.status()

  assert.equal(status.funnel.targetPort, 3000)
  assert.equal(status.funnel.matchesGatePort, false)
  assert.deepEqual(status.needs, ['funnel-run', 'apply'])
})

test('no funnel yet asks for https, the policy, the run and the apply', async () => {
  const fake = createFakeExecFile({ ...healthyAnswers(), 'tailscale funnel status': { stdout: FUNNEL_OFF } })
  const setup = createSetup(fake.execFile, { config: { gatePort: 8791 } })

  const status = await setup.status()

  assert.equal(status.funnel.on, false)
  assert.deepEqual(status.needs, ['https', 'funnel-policy', 'funnel-run', 'apply'])
})

test('a fully configured machine reports done and no other step', async () => {
  const fake = createFakeExecFile(healthyAnswers())
  const setup = createSetup(fake.execFile, { config: { gatePort: 8791, publicUrl: TS_URL } })

  const status = await setup.status()

  assert.deepEqual(status.needs, ['done'])
  assert.equal(status.config.publicUrl, TS_URL)
})

test('the detection object carries the documented keys and no secret material', async () => {
  const fake = createFakeExecFile(healthyAnswers())
  const setup = createSetup(fake.execFile, { config: { gatePort: 8791 } })

  const status = await setup.status()

  assert.deepEqual(Object.keys(status).sort(), [
    'config',
    'docs',
    'funnel',
    'needs',
    'ok',
    'os',
    'platform',
    'policy',
    'tailscale',
  ])
  assert.deepEqual(Object.keys(status.tailscale).sort(), [
    'binary',
    'dnsName',
    'installed',
    'running',
    'suggestedUrl',
    'tailscaleIPs',
    'version',
  ])
  assert.deepEqual(Object.keys(status.funnel).sort(), ['matchesGatePort', 'on', 'targetPort', 'url'])
  assert.deepEqual(Object.keys(status.config).sort(), [
    'autoStart',
    'cloudflaredPath',
    'cloudflaredPresent',
    'cloudflaredVerified',
    'effectiveGatePort',
    'gatePort',
    'publicUrl',
  ])
  assert.deepEqual(Object.keys(status.docs).sort(), ['adminAclUrl', 'adminDnsUrl', 'funnelDocsUrl', 'setupUrl'])
  assert.equal(status.platform, 'win32')
  assert.equal(status.docs.adminDnsUrl, 'https://login.tailscale.com/admin/dns')
  assert.equal(status.docs.adminAclUrl, 'https://login.tailscale.com/admin/acls/file')
  assert.equal(status.docs.setupUrl, TAILSCALE_DOWNLOAD_URL)
  assert.equal(SETUP_DOCS.funnelDocsUrl, 'https://tailscale.com/kb/1223/funnel')
})

test('cloudflared presence is reported without ever starting a download', async () => {
  let resolverCalls = 0
  const setup = createSetup(createFakeExecFile(healthyAnswers()).execFile, {
    resolveBinary: async () => {
      resolverCalls += 1
      throw new Error('cloudflared is not installed')
    },
  })

  const status = await setup.status()

  assert.equal(resolverCalls, 1, 'the existing resolver is consulted exactly once')
  assert.equal(status.config.cloudflaredPresent, false)
  assert.equal(status.config.cloudflaredPath, '')
})

/* ------------------------------------------------------------------------- *
 * Per-OS install guidance and the Funnel policy
 * ------------------------------------------------------------------------- */

test('Windows install guidance is the winget command with the download fallback', () => {
  const os = installGuidance('win32')
  assert.equal(os.id, 'windows')
  assert.equal(os.label, 'Windows')
  const entry = os.install.find(item => item.command !== '')
  assert.equal(entry.command, 'winget install --id Tailscale.Tailscale -e')
  assert.equal(entry.url, 'https://tailscale.com/download')
  for (const item of os.install) {
    assert.equal(typeof item.label, 'string')
    assert.equal(typeof item.command, 'string')
    assert.equal(typeof item.url, 'string')
  }
})

test('macOS install guidance is the Homebrew cask plus the App Store link', () => {
  const os = installGuidance('darwin')
  assert.equal(os.id, 'macos')
  assert.equal(os.install[0].command, 'brew install --cask tailscale')
  assert.equal(os.install[0].url, 'https://tailscale.com/download')
  assert.ok(os.install.some(item => /apps\.apple\.com/u.test(item.url)), 'macOS must offer the App Store as well')
})

test('Linux install guidance is the official install script', () => {
  const os = installGuidance('linux')
  assert.equal(os.id, 'linux')
  assert.equal(os.install[0].command, 'curl -fsSL https://tailscale.com/install.sh | sh')
  assert.equal(os.install[0].url, 'https://tailscale.com/download')
})

test('an unknown platform still gets a copyable install command and a download link', () => {
  const os = installGuidance('freebsd')
  assert.equal(os.label, 'freebsd')
  assert.ok(os.install.some(item => item.command.includes('install.sh')))
  assert.ok(os.install.every(item => item.url === 'https://tailscale.com/download'))
})

test('the Funnel policy JSON is byte-exact and also offered merged with grants', () => {
  assert.equal(
    FUNNEL_POLICY_JSON,
    '{"nodeAttrs":[{"target":["autogroup:member"],"attr":["funnel"]}]}',
  )
  const acl = JSON.parse(FUNNEL_ACL_JSON)
  assert.deepEqual(acl.nodeAttrs, [{ target: ['autogroup:member'], attr: ['funnel'] }])
  assert.ok(Array.isArray(acl.grants) && acl.grants.length > 0, 'the merged sample keeps a grants block')
  assert.deepEqual(acl.grants[0].ip, ['*'])
})

/* ------------------------------------------------------------------------- *
 * Fixed commands only: the funnel runner
 * ------------------------------------------------------------------------- */

test('runFunnel runs exactly `tailscale funnel --bg <configured port>` with a 15 s timeout', async () => {
  const answers = healthyAnswers({ port: 8791 })
  answers['tailscale funnel --bg 8791'] = { stdout: `Available on the internet:\n${TS_URL}\n` }
  const fake = createFakeExecFile(answers)
  const setup = createSetup(fake.execFile, { config: { gatePort: 8791 } })

  const result = await setup.runFunnel()

  assert.equal(result.ok, true)
  assert.equal(result.port, 8791)
  assert.match(result.output, /Available on the internet/u)
  const runCall = fake.calls.find(call => call.key === 'tailscale funnel --bg 8791')
  assert.ok(runCall, `expected the funnel run; got ${fake.keys().join(' | ')}`)
  assert.deepEqual(runCall.args, ['funnel', '--bg', '8791'])
  assert.equal(runCall.options.timeout, FUNNEL_TIMEOUT_MS)
  assert.equal(runCall.options.shell, false)
  assert.equal(runCall.options.windowsHide, true)
})

test('runFunnel refuses with install guidance when Tailscale is missing', async () => {
  const fake = createFakeExecFile({})
  const setup = createSetup(fake.execFile)

  await assert.rejects(setup.runFunnel(), error => {
    assert.equal(error.status, 409)
    assert.match(error.message, /winget install --id Tailscale\.Tailscale -e/u)
    assert.match(error.message, /https:\/\/tailscale\.com\/download/u)
    return true
  })
  assert.ok(fake.calls.every(call => !call.key.includes('funnel --bg')), 'no funnel may run without Tailscale')
})

test('runFunnel refuses when the gate port is OS-assigned', async () => {
  const fake = createFakeExecFile(healthyAnswers())
  const setup = createSetup(fake.execFile, { config: { gatePort: 0, publicUrl: '' } })

  await assert.rejects(setup.runFunnel(), error => {
    assert.equal(error.status, 409)
    assert.match(error.message, /gate port/u)
    return true
  })
  assert.ok(fake.calls.every(call => !call.key.includes('funnel --bg')))
})

test('a failed funnel run is a 409 carrying the redacted output', async () => {
  const answers = healthyAnswers()
  answers['tailscale funnel --bg 8791'] = {
    code: 1,
    stdout: '',
    stderr: 'funnel not available; nodeAttrs "funnel" is required\n',
  }
  const fake = createFakeExecFile(answers)
  const setup = createSetup(fake.execFile, { config: { gatePort: 8791 } })

  await assert.rejects(setup.runFunnel(), error => {
    assert.equal(error.status, 409)
    assert.match(error.message, /nodeAttrs/u)
    assert.equal(error.result.ok, false)
    return true
  })
})

test('redactOutput strips auth keys and bounds the output', () => {
  assert.match(redactOutput('use tskey-auth-abc123 now'), /^use tskey-\[redacted\] now$/u)
  assert.equal(redactOutput('<html>?token=secret&x=1</html>'), '<html>?token=[redacted]&x=1</html>')
  assert.equal(redactOutput('authkey=tskey-zzz'), 'authkey=[redacted]')
  assert.equal(redactOutput('x'.repeat(5_000)).length, 2_000)
})

/* ------------------------------------------------------------------------- *
 * Pure helpers shared with the routes and the tools
 * ------------------------------------------------------------------------- */

test('effectiveGatePort prefers the configured port, then the public default', () => {
  assert.equal(effectiveGatePort({ gatePort: 8791, publicUrl: '' }), 8791)
  assert.equal(effectiveGatePort({ gatePort: 0, publicUrl: TS_URL }), DEFAULT_PUBLIC_GATE_PORT)
  assert.equal(effectiveGatePort({ gatePort: 0, publicUrl: '' }), null)
  assert.equal(effectiveGatePort(null), null)
})

test('computeNeeds covers the whole state machine in step order', () => {
  const base = {
    tailscale: { installed: true, running: true, suggestedUrl: TS_URL },
    funnel: { on: true, url: TS_URL, targetPort: 8791, matchesGatePort: true },
    config: { publicUrl: TS_URL, gatePort: 8791 },
  }
  assert.deepEqual(computeNeeds(base), ['done'])
  assert.deepEqual(computeNeeds({ ...base, tailscale: { ...base.tailscale, installed: false } }), ['install'])
  assert.deepEqual(computeNeeds({ ...base, tailscale: { ...base.tailscale, running: false } }), ['up'])
  assert.deepEqual(
    computeNeeds({
      ...base,
      funnel: { on: false, url: null, targetPort: null, matchesGatePort: false },
      config: { publicUrl: '', gatePort: 8791 },
    }),
    ['https', 'funnel-policy', 'funnel-run', 'apply'],
  )
  assert.deepEqual(
    computeNeeds({ ...base, funnel: { ...base.funnel, matchesGatePort: false }, config: { publicUrl: TS_URL } }),
    ['funnel-run'],
  )
})

test('normalizeSetupPatch validates the three writable keys and rejects the rest', () => {
  assert.deepEqual(normalizeSetupPatch({}), {})
  assert.deepEqual(normalizeSetupPatch({ publicUrl: `${TS_URL}/` }), { publicUrl: TS_URL })
  assert.deepEqual(normalizeSetupPatch({ gatePort: 8791, autoStart: false }), { gatePort: 8791, autoStart: false })
  for (const bad of [{ publicUrl: 'http://x' }, { publicUrl: TS_URL + '/pair' }, { publicUrl: '' }]) {
    assert.throws(() => normalizeSetupPatch(bad), error => error.status === 400, JSON.stringify(bad))
  }
  for (const bad of [{ gatePort: 0 }, { gatePort: 65_536 }, { gatePort: '8791' }, { autoStart: 'yes' }]) {
    assert.throws(() => normalizeSetupPatch(bad), error => error.status === 400, JSON.stringify(bad))
  }
  assert.throws(() => normalizeSetupPatch({ tunnelToken: 'x' }), /unknown setup key/u)
})

test('normalizePublicUrl keeps the service contract for public origins', () => {
  assert.equal(normalizePublicUrl(TS_URL), TS_URL)
  assert.equal(normalizePublicUrl(`${TS_URL}/`), TS_URL)
  for (const bad of ['demo.tailnet.ts.net', 'http://demo.tailnet.ts.net', `${TS_URL}/pair`, `${TS_URL}/?a=1`, `${TS_URL}/#x`]) {
    assert.throws(() => normalizePublicUrl(bad), /bare https origin/u, bad)
  }
})
