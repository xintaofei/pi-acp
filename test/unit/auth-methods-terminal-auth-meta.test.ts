import test from 'node:test'
import assert from 'node:assert/strict'
import { getAuthMethods, PI_SETUP_METHOD_ID } from '../../src/acp/auth.js'

test('getAuthMethods: includes Zed terminal-auth metadata when enabled', () => {
  const methods = getAuthMethods({ supportsTerminalAuthMeta: true })
  assert.equal(methods.length, 1)
  const m: any = methods[0]

  assert.equal(m.id, PI_SETUP_METHOD_ID)
  assert.ok(m._meta)
  assert.ok(m._meta['terminal-auth'])
  assert.ok(typeof m._meta['terminal-auth'].command === 'string')
  // `[script, '--terminal-login']` when launched as `node <script>.js`, the bare flag otherwise.
  assert.equal(m._meta['terminal-auth'].args.at(-1), '--terminal-login')
  assert.equal(m._meta['terminal-auth'].label, 'Launch pi')
})

test('getAuthMethods: terminal-auth relaunches the codeg-pi-acp bin when not started as a .js file', () => {
  const argv = process.argv
  // What a global npm install looks like on macOS/Linux: the bin is a symlink without .js.
  process.argv = ['/usr/local/bin/node', '/usr/local/bin/codeg-pi-acp']
  try {
    const m: any = getAuthMethods({ supportsTerminalAuthMeta: true })[0]
    assert.equal(m._meta['terminal-auth'].command, 'codeg-pi-acp')
    assert.deepEqual(m._meta['terminal-auth'].args, ['--terminal-login'])
  } finally {
    process.argv = argv
  }
})

test('getAuthMethods: omits Zed terminal-auth metadata when disabled', () => {
  const methods = getAuthMethods({ supportsTerminalAuthMeta: false })
  const m: any = methods[0]
  assert.ok(!m._meta || !m._meta['terminal-auth'])
})
