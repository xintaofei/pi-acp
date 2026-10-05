import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type {
  PiExit,
  PiRpcEvent,
  PiSessionStats,
  PromptDisposition,
  QueuedInputDisposition
} from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []
  readonly permissionRequests: unknown[] = []
  nextPermissionResponse: { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } = {
    outcome: { outcome: 'selected', optionId: 'allow' }
  }

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }

  async requestPermission(
    params: unknown
  ): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> {
    this.permissionRequests.push(params)
    return this.nextPermissionResponse
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []
  private exitHandlers: Array<(exit: PiExit) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  readonly extensionUiResponses: unknown[] = []
  abortCount = 0
  getSessionStatsCount = 0

  sessionStats: PiSessionStats = {}
  /** When set, `getSessionStats()` rejects with this error. */
  sessionStatsError: unknown = null

  /** What `prompt()` reports pi did with the prompt (pi 0.99+). */
  promptDisposition: PromptDisposition | undefined = 'started'
  /** When set, `prompt()` rejects with this error. */
  promptError: unknown = null
  /** When set, `prompt()` answers only once this settles (pi still preparing). */
  promptGate: Promise<void> | null = null

  readonly steers: Array<{ message: string; images: unknown[] }> = []
  steerDisposition: QueuedInputDisposition | undefined = 'queued'
  /**
   * When true, `steer()` stays unanswered until `answerSteers()` (or the child
   * exits, which fails it like the real process layer does).
   */
  holdSteers = false
  private heldSteers: Array<{
    resolve: (d: QueuedInputDisposition | undefined) => void
    reject: (e: unknown) => void
  }> = []
  clearQueueCount = 0
  /** What the next `clearQueue()` reports it removed. */
  clearQueueResult: { steering: string[]; followUp: string[] } = {
    steering: [],
    followUp: []
  }
  /** Call order of `clearQueue` / `abort`, to check cancel sequencing. */
  readonly controlCalls: string[] = []
  /** Every prompt / steer / clearQueue / abort, in the order they reached pi. */
  readonly callLog: string[] = []

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  onExit(handler: (exit: PiExit) => void): () => void {
    this.exitHandlers.push(handler)
    return () => {
      this.exitHandlers = this.exitHandlers.filter(h => h !== handler)
    }
  }

  /** Simulate the pi child exiting. */
  exit(exit: Partial<PiExit> = {}) {
    const info: PiExit = {
      code: exit.code ?? 1,
      signal: exit.signal ?? null,
      stderrTail: exit.stderrTail ?? ''
    }
    for (const h of this.heldSteers.splice(0)) h.reject(new Error('pi process exited'))
    for (const h of this.exitHandlers) h(info)
  }

  /** Answer every held `steer()` with `steerDisposition`. */
  answerSteers() {
    for (const h of this.heldSteers.splice(0)) h.resolve(this.steerDisposition)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<PromptDisposition | undefined> {
    this.prompts.push({ message, attachments })
    this.callLog.push(`prompt:${message}`)
    if (this.promptGate) await this.promptGate
    if (this.promptError) throw this.promptError
    return this.promptDisposition
  }

  async steer(message: string, images: unknown[] = []): Promise<QueuedInputDisposition | undefined> {
    this.steers.push({ message, images })
    this.callLog.push(`steer:${message}`)
    if (this.holdSteers) return new Promise((resolve, reject) => this.heldSteers.push({ resolve, reject }))
    return this.steerDisposition
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    this.clearQueueCount += 1
    this.controlCalls.push('clearQueue')
    this.callLog.push('clearQueue')
    const cleared = this.clearQueueResult
    this.clearQueueResult = { steering: [], followUp: [] }
    // pi reports its emptied queues before it answers.
    this.emit({ type: 'queue_update', steering: [], followUp: [] })
    return cleared
  }

  async abort(): Promise<void> {
    this.abortCount += 1
    this.controlCalls.push('abort')
    this.callLog.push('abort')
  }

  dispose() {}

  async sendExtensionUiResponse(response: unknown): Promise<void> {
    this.extensionUiResponses.push(response)
  }

  async getState(): Promise<any> {
    return {}
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    return ['medium', 'high']
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }

  async getSessionStats(): Promise<PiSessionStats> {
    this.getSessionStatsCount += 1
    if (this.sessionStatsError) throw this.sessionStatsError
    return this.sessionStats
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}
