import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const tick = () => new Promise(r => setTimeout(r, 0))

function harness(clientCaps = { notices: false, compaction: false }) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    clientCaps
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
  assert.deepEqual(await session.promptTurn('/my-extension-command'), {
    stopReason: 'end_turn',
    handled: true
  })
  assert.equal(session.hasActiveTurn, false)
  // An ordinary turn is not marked.
  proc.promptDisposition = 'started'
  const turn = session.promptTurn('hi')
  await tick()
  proc.emit({ type: 'agent_settled' })
  assert.deepEqual(await turn, { stopReason: 'end_turn', handled: false })
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
  const { proc, updates } = harness({ notices: false, compaction: true })
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
  assert.deepEqual(done.summary, [{ type: 'text', text: 'The story so far.' }])
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

test('without the compaction extension, only automatic compaction is announced, in prose', async () => {
  const { proc, updates } = harness()
  proc.emit({ type: 'compaction_start', reason: 'threshold' })
  proc.emit({
    type: 'compaction_end',
    reason: 'threshold',
    result: { summary: 's', tokensBefore: 1 },
    aborted: false,
    willRetry: false
  })
  // A manual /compact answers through its own command reply.
  proc.emit({ type: 'compaction_start', reason: 'manual' })
  proc.emit({
    type: 'compaction_end',
    reason: 'manual',
    result: { summary: 's' },
    aborted: false,
    willRetry: false
  })
  await tick()
  assert.deepEqual(
    updates().map(u => [u.sessionUpdate, u.content?.text]),
    [
      ['agent_message_chunk', 'Context nearing limit, running automatic compaction...'],
      ['agent_message_chunk', 'Automatic compaction finished; context was summarized to continue the session.']
    ]
  )
})

test('an extension notification is a notice for a client that takes them', async () => {
  const { proc, updates } = harness({ notices: true, compaction: false })
  proc.emit({
    type: 'extension_ui_request',
    id: 'n1',
    method: 'notify',
    message: 'Released pi-caffeinate',
    notifyType: 'warning'
  })
  await tick()
  const [notice] = updates()
  assert.equal(notice.sessionUpdate, 'notice')
  assert.equal(notice.severity, 'warning')
  assert.equal(notice.title, 'Released pi-caffeinate')
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'n1', cancelled: true }])
})

test('an extension notification stays a marked chunk for any other client', async () => {
  const { proc, updates } = harness()
  proc.emit({
    type: 'extension_ui_request',
    id: 'n1',
    method: 'notify',
    message: 'hello'
  })
  await tick()
  const [chunk] = updates()
  assert.equal(chunk.sessionUpdate, 'agent_message_chunk')
  assert.equal(chunk.content.text, 'hello')
  assert.deepEqual(chunk._meta, { piAcp: { notify: { level: 'info' } } })
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

test('steering: answered injected as soon as pi queues it; pi delivers it within the run', async () => {
  const { proc, session } = harness()
  const turn = session.prompt('work')
  await tick()
  proc.emit({ type: 'agent_start' })
  // The client's request does not wait for delivery: it holds up the client's
  // connection (cancel included) for as long as the current tool runs.
  assert.equal(await session.steer('also this'), 'injected')
  assert.deepEqual(proc.steers, [{ message: 'also this', images: [] }])
  proc.emit({ type: 'queue_update', steering: ['also this'], followUp: [] })
  // pi takes it off the queue right before delivering it as a user message.
  proc.emit({ type: 'queue_update', steering: [], followUp: [] })
  assert.equal(session.hasActiveTurn, true)
  proc.emit(assistantEnd('stop'))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.equal(proc.clearQueueCount, 0)
  assert.equal(proc.prompts.length, 1)
})

test('steering: a steer still queued when the run settles runs as a continuation of the same turn', async () => {
  const { proc, session } = harness()
  const turn = session.prompt('work')
  let settled = false
  void turn.then(() => (settled = true))
  await tick()
  const image = { type: 'image', data: 'AAA', mimeType: 'image/png' }
  assert.equal(await session.steer('too late', [image]), 'injected')
  proc.emit({ type: 'queue_update', steering: ['too late'], followUp: [] })
  proc.clearQueueResult = { steering: ['too late'], followUp: [] }
  proc.emit(assistantEnd('stop'))
  proc.emit({ type: 'agent_settled' })
  await tick()
  // Taken back from pi's queue (it would ride along with the NEXT prompt) and
  // sent again, images included, with the turn still open.
  assert.equal(proc.clearQueueCount, 1)
  assert.deepEqual(proc.prompts.at(-1), {
    message: 'too late',
    attachments: [image]
  })
  assert.equal(settled, false)
  assert.equal(session.hasActiveTurn, true)

  proc.emit({ type: 'agent_start' })
  proc.emit(assistantEnd('stop'))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.equal(proc.clearQueueCount, 1)
})

test('steering: settling waits for a steer pi has not answered yet', async () => {
  const { proc, session } = harness()
  const turn = session.prompt('work')
  await tick()
  proc.holdSteers = true
  const steer = session.steer('racing the end')
  await tick()
  proc.emit(assistantEnd('stop'))
  proc.emit({ type: 'agent_settled' })
  await tick()
  assert.equal(session.hasActiveTurn, true)
  // pi queued it only after its run had settled.
  proc.emit({
    type: 'queue_update',
    steering: ['racing the end'],
    followUp: []
  })
  proc.clearQueueResult = { steering: ['racing the end'], followUp: [] }
  proc.answerSteers()
  assert.equal(await steer, 'injected')
  await tick()
  assert.equal(proc.prompts.at(-1)?.message, 'racing the end')
  proc.emit(assistantEnd('stop'))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
})

test('steering: a steer pi delivered leaves nothing to continue with', async () => {
  const { proc, session } = harness()
  const turn = session.prompt('work')
  await tick()
  assert.equal(await session.steer('on time'), 'injected')
  proc.emit({ type: 'queue_update', steering: ['on time'], followUp: [] })
  proc.emit({ type: 'queue_update', steering: [], followUp: [] })
  proc.emit(assistantEnd('stop'))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.equal(proc.clearQueueCount, 0)
  assert.equal(proc.prompts.length, 1)
})

test('steering: a steer with no text is handed back; pi could not track it', async () => {
  const { proc, session } = harness()
  const turn = session.prompt('work')
  await tick()
  const image = { type: 'image', data: 'AAA', mimeType: 'image/png' }
  assert.equal(await session.steer('  ', [image]), 'promptRequired')
  assert.equal(proc.steers.length, 0)
  proc.emit({ type: 'agent_settled' })
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

test('steering: cancel takes queued steers back BEFORE aborting (pi would run them next time)', async () => {
  const { proc, session } = harness()
  const turn = session.prompt('work')
  await tick()
  assert.equal(await session.steer('queued'), 'injected')
  proc.emit({ type: 'queue_update', steering: ['queued'], followUp: [] })
  await session.cancel()
  assert.deepEqual(proc.controlCalls, ['clearQueue', 'abort'])
  // Ending, so a steer now is the client's to keep.
  assert.equal(await session.steer('late'), 'promptRequired')
  proc.emit(assistantEnd('aborted'))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'cancelled')
  assert.equal(proc.prompts.length, 1)
})

test("steering: cancel leaves pi's queue alone when every steer was delivered", async () => {
  const { proc, session } = harness()
  const turn = session.prompt('work')
  await tick()
  assert.equal(await session.steer('delivered'), 'injected')
  proc.emit({ type: 'queue_update', steering: ['delivered'], followUp: [] })
  proc.emit({ type: 'queue_update', steering: [], followUp: [] })
  await session.cancel()
  assert.deepEqual(proc.controlCalls, ['abort'])
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'cancelled')
})

test('steering: a steer pi never answered before it exited is handed back', async () => {
  const { proc, session } = harness()
  const turn = session.prompt('work')
  await tick()
  proc.holdSteers = true
  const steer = session.steer('lost')
  await tick()
  proc.exit({ code: null, signal: 'SIGKILL' })
  assert.equal(await steer, 'promptRequired')
  await assert.rejects(turn, /pi process exited/)
})

test('a refused prompt takes back the steers pi took for it, and starts the next prompt', async () => {
  const { proc, session } = harness()
  let release!: () => void
  proc.promptGate = new Promise<void>(r => (release = r))
  proc.promptError = new Error('pi prompt failed: No model selected')
  const first = session.prompt('first')
  await tick()
  assert.equal(await session.steer('for first'), 'injected')
  proc.emit({ type: 'queue_update', steering: ['for first'], followUp: [] })
  const second = assert.rejects(session.prompt('second'), /No model selected/)
  release()
  await assert.rejects(first, /No model selected/)
  await tick()
  assert.equal(proc.clearQueueCount, 1)
  // The prompt queued behind it is not stranded: it gets pi's own answer.
  assert.equal(proc.prompts.at(-1)?.message, 'second')
  await second
})

test('cancelled while pi was still preparing the prompt: the run is aborted once it starts', async () => {
  const { proc, session } = harness()
  let release!: () => void
  proc.promptGate = new Promise<void>(r => (release = r))
  const turn = session.prompt('work')
  await tick()
  await session.cancel()
  assert.equal(proc.abortCount, 1)
  release()
  await tick()
  assert.equal(proc.abortCount, 2)
  proc.emit(assistantEnd('aborted'))
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'cancelled')
})

test('agent: initialize advertises steering and HTTP MCP; _session/steering routes to the session', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  const init = await agent.initialize({
    protocolVersion: 1,
    clientCapabilities: { session: { notices: {}, compaction: {} } }
  } as any)
  assert.deepEqual((init as any)._meta, { steering: { supported: true } })
  assert.deepEqual(Reflect.get(agent, 'clientCaps'), {
    notices: true,
    compaction: true
  })
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
