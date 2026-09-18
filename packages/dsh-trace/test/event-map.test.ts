import test from 'node:test'
import assert from 'node:assert/strict'
import { projectSessionEvent } from '../lib/event-map.js'

test('maps tool events (snake_case and camelCase payloads)', () => {
  const a = projectSessionEvent({
    type: 'tool/start', sessionId: 's1', ts: 123,
    toolName: 'bash', args: { command: 'ls' },
  })
  assert.ok(a)
  assert.equal(a.kind, 'tool')
  assert.equal(a.phase, 'start')
  assert.equal(a.tool?.name, 'bash')

  const b = projectSessionEvent({
    type: 'tool_end', session_id: 's2', timestamp: 456,
    name: 'write_file', result: 'ok', error: undefined,
  })
  assert.ok(b)
  assert.equal(b.kind, 'tool')
  assert.equal(b.phase, 'end')
  assert.equal(b.tool?.name, 'write_file')
  assert.equal(b.tool?.result, 'ok')
})

test('maps llm/message events with usage (snake_case usage keys)', () => {
  const p = projectSessionEvent({
    type: 'assistant/message', sessionId: 's1',
    model: 'deepseek-reasoner',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4, reasoning_tokens: 2 },
  })
  assert.ok(p)
  assert.equal(p.kind, 'llm')
  assert.equal(p.phase, 'end')
  assert.equal(p.llm?.model, 'deepseek-reasoner')
  assert.equal(p.llm?.inputTokens, 10)
  assert.equal(p.llm?.cacheReadTokens, 4)
  assert.equal(p.llm?.reasoningTokens, 2)
})

test('maps turn and step events with phase inference', () => {
  const start = projectSessionEvent({ type: 'session/turn', sessionId: 's1' })
  assert.ok(start)
  assert.equal(start.kind, 'turn')
  assert.equal(start.phase, 'start')

  const end = projectSessionEvent({ type: 'step/complete', sessionId: 's1' })
  assert.ok(end)
  assert.equal(end.kind, 'step')
  assert.equal(end.phase, 'end')
})

test('returns null for non-objects and unknown channels', () => {
  assert.equal(projectSessionEvent(null), null)
  assert.equal(projectSessionEvent('nope'), null)
  assert.equal(projectSessionEvent({ type: 'unknown/thing' }), null)
  assert.equal(projectSessionEvent({}), null)
})

test('defaults missing timestamps and session ids', () => {
  const p = projectSessionEvent({ type: 'tool/end', tool: { name: 'bash' } })
  assert.ok(p)
  assert.ok(p.ts > 0)
  assert.equal(p.sessionId, 'unknown')
})
