/**
 * Contract tests for pair/host/setup-tool.js — `pair_setup_status` and
 * `pair_setup_apply`.
 *
 * Pinned here:
 *   - the schemas: status takes no arguments, apply accepts only the three
 *     writable keys, and both are closed (`additionalProperties: false`);
 *   - status forwards the detection object and never throws;
 *   - apply validates through the setup service, never throws, and is limited to
 *     one call per ten seconds;
 *   - neither tool can run a command: there is no `command`/`args` parameter and
 *     the setup service is the only thing that may execute anything.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { APPLY_RATE_LIMIT_MS, registerSetupTool } from '../host/setup-tool.js'
import { FUNNEL_POLICY_JSON } from '../host/setup.js'

const TS_URL = 'https://studio.tailnet-abc.ts.net'

const DETECTION = {
  ok: true,
  platform: 'win32',
  os: { id: 'windows', label: 'Windows', install: [] },
  tailscale: {
    installed: true,
    version: '1.68.1',
    running: true,
    dnsName: 'studio.tailnet-abc.ts.net',
    suggestedUrl: TS_URL,
    tailscaleIPs: [],
    binary: 'tailscale',
  },
  funnel: { on: true, url: TS_URL, targetPort: 8791, matchesGatePort: true },
  config: {
    gatePort: 8791,
    effectiveGatePort: 8791,
    publicUrl: '',
    autoStart: true,
    cloudflaredPath: '',
    cloudflaredPresent: false,
    cloudflaredVerified: false,
  },
  needs: ['apply'],
  docs: { setupUrl: 'https://tailscale.com/download' },
  policy: { json: FUNNEL_POLICY_JSON, acl: '{}\n' },
}

function createFakeRegistry() {
  const registrations = []
  return {
    registrations,
    register(definition, options = {}) {
      const entry = { definition, options, disposed: false }
      registrations.push(entry)
      return () => {
        entry.disposed = true
      }
    },
  }
}

function createFakeSetup(overrides = {}) {
  const calls = []
  return {
    calls,
    async status() {
      calls.push(['status'])
      if (overrides.statusThrows === true) throw new Error('tailscale is not installed')
      return { ...DETECTION, ...(overrides.statusPatch ?? {}) }
    },
    async apply(patch) {
      calls.push(['apply', patch])
      if (overrides.applyThrows === true) {
        throw Object.assign(new Error('publicUrl must be a bare https origin'), { status: 400 })
      }
      return { ...DETECTION, ...(overrides.appliedPatch ?? {}), needs: ['done'] }
    },
  }
}

function createTools(options = {}) {
  const registry = createFakeRegistry()
  const setup = createFakeSetup(options.setup ?? {})
  const dispose = registerSetupTool({ tools: registry }, setup, options.tool)
  const statusTool = registry.registrations.find(entry => entry.definition.name === 'pair_setup_status')
  const applyTool = registry.registrations.find(entry => entry.definition.name === 'pair_setup_apply')
  return { registry, setup, dispose, statusTool, applyTool }
}

/* ------------------------------------------------------------------------- *
 * Registration and schemas
 * ------------------------------------------------------------------------- */

test('registers both tools once and unregisters them on dispose', () => {
  const { registry, dispose } = createTools()

  assert.deepEqual(registry.registrations.map(entry => entry.definition.name), ['pair_setup_status', 'pair_setup_apply'])
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.ok(registry.registrations.every(entry => entry.disposed === true))
})

test('a missing or incomplete tool registry yields null instead of throwing', () => {
  const setup = createFakeSetup()
  assert.equal(registerSetupTool(null, setup), null)
  assert.equal(registerSetupTool({}, setup), null)
  assert.equal(registerSetupTool({ tools: {} }, setup), null)
  assert.equal(registerSetupTool({ tools: { register() {} } }, null), null)
  assert.equal(registerSetupTool({ tools: { register() {} } }, {}), null)
  const throwing = {
    tools: {
      register() {
        throw new Error('registry is full')
      },
    },
  }
  assert.equal(registerSetupTool(throwing, setup), null)
})

test('the status tool takes no arguments and the apply tool only the three writable keys', () => {
  const { statusTool, applyTool } = createTools()

  assert.deepEqual(statusTool.definition.parameters.properties, {})
  assert.equal(statusTool.definition.parameters.additionalProperties, false)
  assert.deepEqual(Object.keys(applyTool.definition.parameters.properties).sort(), ['autoStart', 'gatePort', 'publicUrl'])
  assert.equal(applyTool.definition.parameters.additionalProperties, false)
  assert.deepEqual(applyTool.definition.parameters.required, [])
  assert.equal(applyTool.definition.parameters.properties.gatePort.type, 'integer')

  // No tool exposes a command surface: an agent cannot ask for an argv.
  for (const tool of [statusTool, applyTool]) {
    const serialized = JSON.stringify(tool.definition)
    for (const forbidden of ['"command"', '"args"', '"exec"', '"shell"']) {
      assert.ok(!serialized.includes(forbidden), `${tool.definition.name} must not expose ${forbidden}`)
    }
  }
})

test('both tools render a readable line from their output', () => {
  const { statusTool, applyTool } = createTools()

  const statusText = statusTool.definition.output.render({}, DETECTION)[0].text
  assert.match(statusText, /needs: apply/u)
  assert.match(statusText, /tailscale 1\.68\.1 \(running\)/u)
  assert.match(statusText, /funnel on/u)
  assert.match(statusText, /publicUrl: \(not set\)/u)

  const rejected = applyTool.definition.output.render({}, { ok: false, error: 'gate port 7000 is already in use' })[0].text
  assert.match(rejected, /apply rejected: gate port 7000/u)
  const applied = applyTool.definition.output.render({}, { ...DETECTION, needs: ['done'] })[0].text
  assert.match(applied, /^applied — needs: done/u)
})

/* ------------------------------------------------------------------------- *
 * pair_setup_status
 * ------------------------------------------------------------------------- */

test('pair_setup_status returns the detection object and calls the service once', async () => {
  const { statusTool, setup } = createTools()

  const value = await statusTool.definition.execute({})

  assert.deepEqual(setup.calls, [['status']])
  assert.deepEqual(value, DETECTION)
  assert.equal(value.policy.json, FUNNEL_POLICY_JSON)
})

test('pair_setup_status never throws: a failing detection degrades to an error field', async () => {
  const { statusTool } = createTools({ setup: { statusThrows: true } })

  const value = await statusTool.definition.execute()

  assert.equal(value.ok, false)
  assert.match(value.error, /not installed/u)
  assert.deepEqual(value.needs, ['install'])
})

test('pair_setup_status bounds a very long binary path', async () => {
  const longPath = `C:\\${'a'.repeat(400)}\\tailscale.exe`
  const { statusTool } = createTools({ setup: { statusPatch: { tailscale: { ...DETECTION.tailscale, binary: longPath } } } })

  const value = await statusTool.definition.execute()

  assert.ok(value.tailscale.binary.length <= 260, 'the returned path must be bounded')
  assert.match(value.tailscale.binary, /…$/u)
})

/* ------------------------------------------------------------------------- *
 * pair_setup_apply
 * ------------------------------------------------------------------------- */

test('pair_setup_apply validates through the setup service and returns the fresh status', async () => {
  const { applyTool, setup } = createTools()

  const value = await applyTool.definition.execute({ publicUrl: TS_URL, gatePort: 8791 })

  assert.deepEqual(setup.calls, [['apply', { publicUrl: TS_URL, gatePort: 8791 }]])
  assert.equal(value.ok, true)
  assert.deepEqual(value.needs, ['done'])
})

test('pair_setup_apply reports a validation failure without throwing', async () => {
  const { applyTool } = createTools({ setup: { applyThrows: true } })

  const value = await applyTool.definition.execute({ publicUrl: 'http://plain' })

  assert.equal(value.ok, false)
  assert.match(value.error, /https origin/u)
})

test('pair_setup_apply is limited to one call per ten seconds', async () => {
  let clock = 1_000_000
  const { applyTool, setup } = createTools({ tool: { now: () => clock } })

  const first = await applyTool.definition.execute({ publicUrl: TS_URL })
  assert.equal(first.ok, true)

  const second = await applyTool.definition.execute({ publicUrl: TS_URL })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'rate-limited')
  assert.ok(second.retryAfter >= 1)
  assert.equal(setup.calls.filter(call => call[0] === 'apply').length, 1, 'a rate-limited call must not reach the service')

  clock += APPLY_RATE_LIMIT_MS - 1
  assert.equal((await applyTool.definition.execute({ publicUrl: TS_URL })).reason, 'rate-limited')

  clock += 1
  const third = await applyTool.definition.execute({ publicUrl: TS_URL })
  assert.equal(third.ok, true, 'the limit must release after ten seconds')
  assert.equal(setup.calls.filter(call => call[0] === 'apply').length, 2)
})

test('the rate limit is per registration, so a second registry is not blocked', async () => {
  const first = createTools({ tool: { now: () => 5_000 } })
  const second = createTools({ tool: { now: () => 5_000 } })

  assert.equal((await first.applyTool.definition.execute({ publicUrl: TS_URL })).ok, true)
  assert.equal((await second.applyTool.definition.execute({ publicUrl: TS_URL })).ok, true)
})
