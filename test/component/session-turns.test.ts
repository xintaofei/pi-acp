import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const tick = () => new Promise(r => setTimeout(r, 0))

function harness() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  const updates = () => conn.updates.map(u => u.update as any)
  return { conn, proc, session, updates }
}

function assistantEnd(stopReason: string, errorMessage?: string) {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      stopReason,
      ...(errorMessage ? { errorMessage } : {})
    }
  }
}

test("a turn whose last assistant message errored rejects with pi's own words", async () => {
  const { proc, session } = harness()
  const turn = session.prompt('hi')
  await tick()
  proc.emit({ type: 'agent_start' })
  proc.emit(assistantEnd('error', '400: {"message":"bad request"}'))
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await assert.rejects(turn, (err: any) => {
    assert.equal(err.code, -32603)
    assert.equal(err.message, '400: {"message":"bad request"}')
    return true
  })
})

test('a retried error that later succeeds ends the turn normally', async () => {
  const { proc, session } = harness()
  const turn = session.prompt('hi')
  await tick()
  proc.emit(assistantEnd('error', '529 overloaded'))
  proc.emit(assistantEnd('stop'))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
})

test('length maps to max_tokens and aborted to cancelled', async () => {
  for (const [stop, expected] of [
    ['length', 'max_tokens'],
    ['aborted', 'cancelled'],
    ['toolUse', 'end_turn']
  ] as const) {
    const { proc, session } = harness()
    const turn = session.prompt('hi')
    await tick()
    proc.emit(assistantEnd(stop))
    proc.emit({ type: 'agent_settled' })
    assert.equal(await turn, expected, stop)
  }
})

test('a prompt pi handled without a run settles at once (no agent_settled comes)', async () => {
  const { proc, session } = harness()
  proc.promptDisposition = 'handled'
  assert.equal(await session.prompt('/my-extension-command'), 'end_turn')
  assert.equal(session.hasActiveTurn, false)
})

test('a prompt pi rejected outright rejects the turn with the reason', async () => {
  const { proc, session } = harness()
  proc.promptError = new Error('pi prompt failed: No model selected')
  await assert.rejects(session.prompt('hi'), /No model selected/)
  assert.equal(session.hasActiveTurn, false)
})

test('pi exiting mid-turn rejects the turn and every later prompt', async () => {
  const { proc, session } = harness()
  const turn = session.prompt('hi')
  await tick()
  proc.exit({ code: 1, stderrTail: 'boom: out of memory\n' })
  await assert.rejects(turn, (err: any) => {
    assert.match(err.message, /pi process exited \(code=1, signal=null\)/)
    assert.match(err.message, /out of memory/)
    return true
  })
  await assert.rejects(session.prompt('again'), /pi process exited/)
})

test('nested tool calls (codemode) name their parent call in _meta', async () => {
  const { proc, updates } = harness()
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'call_1/1',
    toolName: 'read',
    args: { path: 'a.txt' },
    parentToolCallId: 'call_1'
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'call_1/1',
    toolName: 'read',
    result: { content: [{ type: 'text', text: 'body' }] },
    isError: false
  })
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'call_1/2',
    toolName: 'bash',
    args: { command: 'ls' },
    parentToolCallId: 'call_1'
  })
  await tick()
  const [start, end, bash] = updates()
  assert.equal(start.sessionUpdate, 'tool_call')
  assert.deepEqual(start._meta, { piAcp: { parentToolCallId: 'call_1' } })
  assert.equal(end.status, 'completed')
  assert.deepEqual(end._meta, { piAcp: { parentToolCallId: 'call_1' } })
  assert.equal(bash.sessionUpdate, 'tool_call')
  assert.equal(bash._meta.piAcp.parentToolCallId, 'call_1')
  assert.ok(bash._meta.terminal_info, 'a nested bash keeps its terminal channel')
})

test("a partial result without text (codemode's call list) is not printed as JSON", async () => {
  const { proc, updates } = harness()
  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 'cm',
    toolName: 'codemode',
    args: { code: 'return 1' }
  })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 'cm',
    toolName: 'codemode',
    partialResult: {
      content: [],
      details: { calls: [{ id: 'cm/1', name: 'bash', status: 'running' }] }
    }
  })
  proc.emit({
    type: 'tool_execution_update',
    toolCallId: 'cm',
    toolName: 'codemode',
    partialResult: { content: [{ type: 'text', text: 'partial' }] }
  })
  await tick()
  const frames = updates()
  assert.equal(frames.length, 2, JSON.stringify(frames))
  assert.equal(frames[1].content[0].content.text, 'partial')
})

test('toolcall_start (delta-only wire) shows a pending card before the arguments', async () => {
  const { proc, updates } = harness()
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      contentIndex: 0,
      id: 'c1',
      toolName: 'write'
    }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: '{'
    }
  })
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: {
        id: 'c1',
        name: 'write',
        arguments: { path: '/tmp/x.txt', content: 'x' }
      }
    }
  })
  // bash waits for its command before it is announced.
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      contentIndex: 1,
      id: 'c2',
      toolName: 'bash'
    }
  })
  await tick()
  const frames = updates()
  assert.equal(frames.length, 2, JSON.stringify(frames))
  assert.equal(frames[0].sessionUpdate, 'tool_call')
  assert.equal(frames[0].status, 'pending')
  assert.equal(frames[0].title, 'write')
  assert.equal(frames[0].rawInput, undefined)
  assert.equal(frames[1].sessionUpdate, 'tool_call_update')
  assert.deepEqual(frames[1].rawInput, { path: '/tmp/x.txt', content: 'x' })
  assert.deepEqual(frames[1].locations, [{ path: '/tmp/x.txt' }])
})

test('compaction is reported as one compaction_update card per compaction', async () => {
  const { proc, updates } = harness()
  proc.emit({ type: 'compaction_start', reason: 'threshold' })
  proc.emit({
    type: 'compaction_end',
    reason: 'threshold',
    result: {
      summary: 'The story so far.',
      tokensBefore: 150000,
      estimatedTokensAfter: 32000
    },
    aborted: false,
    willRetry: false
  })
  proc.emit({ type: 'compaction_start', reason: 'manual' })
  proc.emit({
    type: 'compaction_end',
    reason: 'manual',
    aborted: false,
    willRetry: false,
    errorMessage: 'summarization failed'
  })
  await tick()
  const [start, done, start2, failed] = updates()
  assert.equal(start.sessionUpdate, 'compaction_update')
  assert.equal(start.status, 'in_progress')
  assert.equal(done.compactionId, start.compactionId)
  assert.equal(done.status, 'completed')
  assert.deepEqual(done.summary, { type: 'text', text: 'The story so far.' })
  assert.equal(done._meta.contextCompaction.trigger, 'automatic')
  assert.equal(done._meta.contextCompaction.preTokens, 150000)
  assert.equal(done._meta.contextCompaction.postTokens, 32000)
  assert.equal(typeof done._meta.contextCompaction.durationMs, 'number')
  assert.notEqual(start2.compactionId, start.compactionId)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error, 'summarization failed')
  assert.equal(failed._meta.contextCompaction.trigger, 'manual')
  assert.equal(failed._meta.contextCompaction.error, 'summarization failed')
})

test("a final retry failure adds no 'resuming' line; a recovery still does", async () => {
  const { proc, updates } = harness()
  proc.emit({
    type: 'auto_retry_end',
    success: false,
    attempt: 3,
    finalError: 'x'
  })
  proc.emit({ type: 'auto_retry_end', success: true, attempt: 2 })
  await tick()
  const frames = updates()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].content.text, 'Retry finished, resuming.')
})

test('steering: no running turn means promptRequired, and nothing reaches pi', async () => {
  const { proc, session } = harness()
  assert.equal(await session.steer('more'), 'promptRequired')
  assert.equal(proc.steers.length, 0)
})

test('steering: a steer pi delivers into the run is injected; the turn stays open', async () => {
  const { proc, session } = harness()
  const turn = session.prompt('work')
  await tick()
  proc.emit({ type: 'agent_start' })
  const steer = session.steer('also this')
  await tick()
  assert.deepEqual(proc.steers, [{ message: 'also this', images: [] }])
  proc.emit({ type: 'queue_update', steering: ['also this'], followUp: [] })
  // pi takes it off the queue right before delivering it as a user message.
  proc.emit({ type: 'queue_update', steering: [], followUp: [] })
  assert.equal(await steer, 'injected')
  assert.equal(session.hasActiveTurn, true)
  proc.emit(assistantEnd('stop'))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.equal(proc.clearQueueCount, 0)
})

test('steering: a steer still queued when the run settles is taken back as promptRequired', async () => {
  const { proc, session } = harness()
  const turn = session.prompt('work')
  await tick()
  const steer = session.steer('too late')
  await tick()
  proc.emit({ type: 'queue_update', steering: ['too late'], followUp: [] })
  proc.emit(assistantEnd('stop'))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await steer, 'promptRequired')
  assert.equal(proc.clearQueueCount, 1)
  assert.equal(await turn, 'end_turn')
})

test('steering: a steer an input handler consumed counts as injected', async () => {
  const { proc, session } = harness()
  const turn = session.prompt('work')
  await tick()
  proc.steerDisposition = 'handled'
  assert.equal(await session.steer('handled by extension'), 'injected')
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.equal(proc.clearQueueCount, 0)
})

test('steering: cancel takes queued steers back BEFORE aborting (pi would run them)', async () => {
  const { proc, session } = harness()
  const turn = session.prompt('work')
  await tick()
  const steer = session.steer('queued')
  await tick()
  proc.emit({ type: 'queue_update', steering: ['queued'], followUp: [] })
  await session.cancel()
  assert.equal(await steer, 'promptRequired')
  assert.deepEqual(proc.controlCalls, ['clearQueue', 'abort'])
  proc.emit(assistantEnd('aborted'))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'cancelled')
})

test('steering: pi exiting hands every pending steer back', async () => {
  const { proc, session } = harness()
  const turn = session.prompt('work')
  await tick()
  const steer = session.steer('lost')
  await tick()
  proc.exit({ code: null, signal: 'SIGKILL' })
  assert.equal(await steer, 'promptRequired')
  await assert.rejects(turn, /pi process exited/)
})

test('agent: initialize advertises steering and HTTP MCP; _session/steering routes to the session', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const init = await agent.initialize({ protocolVersion: 1 } as any)
  assert.deepEqual((init as any)._meta, { steering: { supported: true } })
  assert.deepEqual(init.agentCapabilities?.mcpCapabilities, {
    http: true,
    sse: false
  })
  assert.equal(init.agentInfo?.name, 'codeg-pi-acp')

  // No such session: the content stays the client's.
  assert.deepEqual(
    await agent.extMethod('_session/steering', {
      sessionId: 'nope',
      prompt: [{ type: 'text', text: 'x' }]
    }),
    { outcome: 'promptRequired', reason: 'noRunningTurn' }
  )
  await assert.rejects(agent.extMethod('_unknown/method', {}), {
    code: -32601
  })
})
