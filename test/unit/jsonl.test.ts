import test from 'node:test'
import assert from 'node:assert/strict'
import { JsonlSplitter } from '../../src/pi-rpc/jsonl.js'

function split(chunks: Buffer[], end = true): string[] {
  const lines: string[] = []
  const splitter = new JsonlSplitter(line => lines.push(line))
  for (const chunk of chunks) splitter.push(chunk)
  if (end) splitter.end()
  return lines
}

test('JsonlSplitter: keeps U+2028/U+2029 inside a record (readline would split there)', () => {
  const record = JSON.stringify({ text: 'a b c' })
  const lines = split([Buffer.from(`${record}\n{"n":2}\n`)])
  assert.deepEqual(lines, [record, '{"n":2}'])
  assert.equal(JSON.parse(lines[0]!).text, 'a b c')
})

test('JsonlSplitter: strips one CR before LF and nothing else', () => {
  assert.deepEqual(split([Buffer.from('{"a":1}\r\n{"b":"x\\r"}\n')]), ['{"a":1}', '{"b":"x\\r"}'])
})

test('JsonlSplitter: reassembles a record and a multi-byte character split across chunks', () => {
  const bytes = Buffer.from('{"t":"你好"}\n', 'utf8')
  // Cut inside the 3-byte encoding of 你.
  const cut = bytes.indexOf(Buffer.from('你', 'utf8')) + 1
  const lines = split([bytes.subarray(0, cut), bytes.subarray(cut)])
  assert.deepEqual(lines, ['{"t":"你好"}'])
})

test('JsonlSplitter: a record without a final LF is delivered at end, not before', () => {
  const lines: string[] = []
  const splitter = new JsonlSplitter(line => lines.push(line))
  splitter.push(Buffer.from('{"a":1}\n{"b":2}'))
  assert.deepEqual(lines, ['{"a":1}'])
  splitter.end()
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}'])
  splitter.end()
  assert.equal(lines.length, 2)
})
