import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRpcProcess, type PiExit } from '../../src/pi-rpc/process.js'

/**
 * A stand-in `pi --mode rpc`: answers `get_state`, and on `prompt` runs
 * `onPrompt` (a JS statement) with `reply` in scope.
 */
function fakePi(onPrompt: string): { command: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-exit-'))
  const command = join(dir, 'pi')
  writeFileSync(
    command,
    `#!/usr/bin/env node
const reply = (cmd, data, done) =>
  process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, command: cmd.type, success: true, data }) + "\\n", done)
let buffered = ""
process.stdin.on("data", (chunk) => {
  buffered += chunk
  let end
  while ((end = buffered.indexOf("\\n")) >= 0) {
    const cmd = JSON.parse(buffered.slice(0, end))
    buffered = buffered.slice(end + 1)
    if (cmd.type === "get_state") reply(cmd, {})
    if (cmd.type === "prompt") { ${onPrompt} }
  }
})
`
  )
  chmodSync(command, 0o755)
  return {
    command,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

const posixOnly = (name: string, fn: () => Promise<void>) => test(name, { skip: process.platform === 'win32' }, fn)

posixOnly("pi's last response and dying words arrive before its exit is reported", async () => {
  const pi = fakePi(`
    process.stderr.write("fatal: out of cheese\\n")
    reply(cmd, { disposition: "started" }, () => process.exit(3))
  `)
  try {
    const proc = await PiRpcProcess.spawn({
      cwd: process.cwd(),
      piCommand: pi.command
    })
    const exited = new Promise<PiExit>(resolve => proc.onExit(resolve))
    assert.equal(await proc.prompt('hi'), 'started')
    const exit = await exited
    assert.equal(exit.code, 3)
    assert.match(exit.stderrTail, /out of cheese/)
    await assert.rejects(proc.prompt('again'), /pi process exited \(code=3/)
  } finally {
    pi.cleanup()
  }
})

posixOnly("a grandchild holding pi's pipes open does not hide its exit", async () => {
  const pi = fakePi(`
    require("node:child_process")
      .spawn("sleep", ["5"], { stdio: "inherit", detached: true })
      .unref()
    process.exit(7)
  `)
  try {
    const proc = await PiRpcProcess.spawn({
      cwd: process.cwd(),
      piCommand: pi.command
    })
    const exited = new Promise<PiExit>(resolve => proc.onExit(resolve))
    const started = Date.now()
    await assert.rejects(proc.prompt('hi'), /pi process exited \(code=7/)
    assert.equal((await exited).code, 7)
    assert.ok(Date.now() - started < 3_000, 'reported well before the grandchild exits')
  } finally {
    pi.cleanup()
  }
})
