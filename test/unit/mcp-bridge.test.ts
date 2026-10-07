import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  BRIDGE_CONFIG_ENV,
  McpBridgeLaunch,
  PI_TOO_OLD_MARKER,
  escapePiConfigValue,
  piTooOldMessage,
  toBridgeServers,
  type BridgeConfig
} from '../../src/acp/mcp-bridge.js'
import mcpBridge from '../../src/pi-extension/mcp-bridge.js'

afterEach(() => {
  delete process.env[BRIDGE_CONFIG_ENV]
})

test('escapePiConfigValue: every $ and a leading ! reach pi as literals', () => {
  assert.equal(escapePiConfigValue('plain'), 'plain')
  assert.equal(escapePiConfigValue('$HOME'), '$$HOME')
  assert.equal(escapePiConfigValue('${TOKEN}x'), '$${TOKEN}x')
  assert.equal(escapePiConfigValue('!rm -rf'), '$!rm -rf')
  assert.equal(escapePiConfigValue('a!b'), 'a!b')
  assert.equal(escapePiConfigValue('$$'), '$$$$')
  // A leading `$!` in the input is a literal `$` then a literal `!`.
  assert.equal(escapePiConfigValue('$!x'), '$$!x')
})

test('toBridgeServers: maps stdio and http, skips sse and unknown transports', () => {
  const { servers, skipped } = toBridgeServers([
    {
      name: 'codeg-mcp',
      command: '/bin/codeg-mcp',
      args: ['--token', 't'],
      env: [{ name: 'K', value: '$V' }]
    },
    {
      type: 'http',
      name: 'docs',
      url: 'https://example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer !x' }]
    },
    {
      type: 'sse',
      name: 'legacy',
      url: 'https://example.com/sse',
      headers: []
    },
    { type: 'acp', name: 'nested', id: 'x' } as never
  ])
  assert.deepEqual(servers, [
    {
      name: 'codeg-mcp',
      config: {
        command: '/bin/codeg-mcp',
        args: ['--token', 't'],
        env: { K: '$$V' },
        exposure: 'direct'
      }
    },
    {
      name: 'docs',
      config: {
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer !x' },
        exposure: 'direct'
      }
    }
  ])
  assert.deepEqual(
    skipped.map(s => s.name),
    ['legacy', 'nested']
  )
})

test('toBridgeServers: names pi would reject are made valid and kept distinct', () => {
  const { servers } = toBridgeServers([
    { name: 'my server.v2', command: 'a', args: [], env: [] },
    { name: 'dup-name', command: 'b', args: [], env: [] },
    { name: 'dup_name', command: 'c', args: [], env: [] }
  ])
  assert.deepEqual(
    servers.map(s => s.name),
    ['my_server_v2', 'dup-name', 'dup_name_2']
  )
})

test('McpBridgeLaunch: config is private and the report reflects the extension', () => {
  const launch = McpBridgeLaunch.prepare([
    { name: 'a', command: 'x', args: [], env: [] },
    { type: 'sse', name: 'b', url: 'u', headers: [] }
  ])
  const configPath = launch.env[BRIDGE_CONFIG_ENV]!
  assert.ok(existsSync(configPath))
  if (process.platform !== 'win32') {
    assert.equal(statSync(configPath).mode & 0o777, 0o600)
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as BridgeConfig
  writeFileSync(
    config.statusPath,
    JSON.stringify({
      version: 1,
      unsupported: false,
      registered: ['a'],
      failed: []
    })
  )

  const outcome = launch.collect()
  assert.equal(outcome.piSupportsMcp, true)
  assert.deepEqual(outcome.report, {
    registered: ['a'],
    skipped: [{ name: 'b', reason: 'pi does not support the SSE transport' }],
    unsupported: false
  })
  assert.equal(existsSync(dirname(configPath)), false)
})

test('McpBridgeLaunch: an old pi is reported unsupported; no status proves nothing', () => {
  const old = McpBridgeLaunch.prepare([])
  const config = JSON.parse(readFileSync(old.env[BRIDGE_CONFIG_ENV]!, 'utf8')) as BridgeConfig
  writeFileSync(
    config.statusPath,
    JSON.stringify({
      version: 1,
      unsupported: true,
      registered: [],
      failed: []
    })
  )
  assert.deepEqual(old.collect(), { report: null, piSupportsMcp: false })

  const silent = McpBridgeLaunch.prepare([{ name: 'a', command: 'x', args: [], env: [] }])
  const outcome = silent.collect()
  assert.equal(outcome.piSupportsMcp, null)
  assert.equal(outcome.report?.registered.length, 0)
  assert.match(outcome.report?.skipped[0]?.reason ?? '', /did not load/)
})

test('piTooOldMessage carries the stable marker', () => {
  assert.ok(piTooOldMessage().startsWith(PI_TOO_OLD_MARKER))
})

test('MCP bridge extension: registers, reports, and leaves nothing behind', () => {
  const launch = McpBridgeLaunch.prepare([
    { name: 'ok', command: 'x', args: [], env: [] },
    { name: 'bad', command: 'y', args: [], env: [] }
  ])
  const configPath = launch.env[BRIDGE_CONFIG_ENV]!
  process.env[BRIDGE_CONFIG_ENV] = configPath
  const registered: Array<{ name: string; config: unknown }> = []

  mcpBridge({
    registerMcpServer(name: string, config: unknown) {
      if (name === 'bad') throw new Error('invalid config')
      registered.push({ name, config })
    }
  })

  // The env var and the config file are gone before pi can hand them on.
  assert.equal(process.env[BRIDGE_CONFIG_ENV], undefined)
  assert.equal(existsSync(configPath), false)
  assert.deepEqual(
    registered.map(r => r.name),
    ['ok']
  )
  const outcome = launch.collect()
  assert.equal(outcome.piSupportsMcp, true)
  assert.deepEqual(outcome.report?.registered, ['ok'])
  assert.deepEqual(outcome.report?.skipped, [{ name: 'bad', reason: 'invalid config' }])
})

test('MCP bridge extension: a pi without registerMcpServer is reported unsupported', () => {
  const launch = McpBridgeLaunch.prepare([])
  process.env[BRIDGE_CONFIG_ENV] = launch.env[BRIDGE_CONFIG_ENV]
  mcpBridge({})
  assert.deepEqual(launch.collect(), { report: null, piSupportsMcp: false })
})

test('MCP bridge extension: without the env var it does nothing', () => {
  let called = false
  mcpBridge({
    registerMcpServer() {
      called = true
    }
  })
  assert.equal(called, false)
})
