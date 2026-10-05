import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  maybeGet(_id: string) {
    return this.session
  }
  get(_id: string) {
    return this.session
  }
}

test('PiAcpAgent: /steering is handled adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getState = async () => ({ steeringMode: 'one-at-a-time' })

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/steering' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Steering mode: one-at-a-time/)
})

test('PiAcpAgent: /name sets session display name adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setTo: string | null = null
  proc.setSessionName = async (name: string) => {
    setTo = name
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/name My Session' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  assert.equal(setTo, 'My Session')
  const info = conn.updates.find(u => (u as any).update?.sessionUpdate === 'session_info_update')
  assert.equal((info as any)?.update?.title, 'My Session')

  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Session name set: My Session/)
})

function compactHarness(compact: () => Promise<unknown>, compaction: boolean) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.compact = compact
  const agent = new PiAcpAgent(asAgentConn(conn))
  Reflect.set(agent, 'clientCaps', { notices: false, compaction })
  ;(agent as any).sessions = new FakeSessions({
    sessionId: 's1',
    proc,
    fileCommands: [],
    publishContextUsage: async () => {}
  }) as any
  const run = () =>
    agent.prompt({
      sessionId: 's1',
      prompt: [{ type: 'text', text: '/compact' }]
    } as any)
  return { conn, proc, run }
}

test('PiAcpAgent: /compact that pi refuses is answered, not a failed turn', async () => {
  const { conn, run } = compactHarness(async () => {
    throw new Error('pi compact failed: Compaction failed: Nothing to compact (session too small)')
  }, true)

  const res = await run()

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(
    (conn.updates.at(-1) as any).update.content.text,
    'Compaction failed: Nothing to compact (session too small)'
  )
})

test('PiAcpAgent: /compact leaves the summary to the card when the client shows one', async () => {
  const result = { tokensBefore: 1234, summary: 'The story so far.' }
  for (const compaction of [true, false]) {
    const { conn, run } = compactHarness(async () => result, compaction)
    const res = await run()
    assert.equal(res.stopReason, 'end_turn')
    const text: string = (conn.updates.at(-1) as any).update.content.text
    assert.match(text, /^Compaction completed\.\nTokens before: 1234/)
    assert.equal(text.includes('The story so far.'), !compaction, `${compaction}`)
  }
})
