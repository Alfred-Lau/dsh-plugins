import test from 'node:test'
import assert from 'node:assert/strict'
import { SpanCollector } from '../lib/collector.js'
import { createSanitizer } from '../lib/sanitize.js'
import { ATTR } from '../lib/semconv.js'
import type { SessionEventProjection, Span, TraceConfig } from '../lib/types.js'

function makeCollector(config: Partial<TraceConfig> = {}, spans: Span[] = []): SpanCollector {
  return new SpanCollector({
    config: {
      enabled: true,
      capture: { turns: true, steps: true, tools: true, llm: true },
      llm: { prompt: true, completion: true },
      metadata: { sessionId: true, model: true },
      sanitize: { enabled: true },
      ...config,
    } as TraceConfig,
    sanitizer: createSanitizer({ enabled: true }),
    onSpan: (span) => spans.push(span),
  })
}

const ts = (n: number) => 1_700_000_000_000 + n

test('turn start/end produce one completed turn span with deterministic traceId', () => {
  const spans: Span[] = []
  const c = makeCollector({}, spans)
  c.feed({ kind: 'turn', phase: 'start', sessionId: 's1', ts: ts(0) })
  c.feed({ kind: 'turn', phase: 'end', sessionId: 's1', ts: ts(5) })
  assert.equal(spans.length, 1)
  const span = spans[0]!
  assert.equal(span.kind, 'turn')
  assert.equal(span.sessionId, 's1')
  assert.equal(span.startTime, ts(0))
  assert.equal(span.endTime, ts(5))
  assert.match(span.traceId, /^[0-9a-f]{32}$/)
  assert.match(span.spanId, /^[0-9a-f]{16}$/)
})

test('tool start/end pair emits an execute_tool span with sanitized payload', () => {
  const spans: Span[] = []
  const c = makeCollector({}, spans)
  c.feed({ kind: 'turn', phase: 'start', sessionId: 's1', ts: ts(0) })
  c.feed({
    kind: 'tool', phase: 'start', sessionId: 's1', ts: ts(1),
    tool: { name: 'bash', callId: 'c1', args: { command: 'ls', apiKey: 'sk-should-vanish' } },
  })
  c.feed({
    kind: 'tool', phase: 'end', sessionId: 's1', ts: ts(3),
    tool: { name: 'bash', callId: 'c1', result: 'file.txt', durationMs: 2 },
  })
  const tool = spans.find((s) => s.kind === 'tool')
  assert.ok(tool, 'tool span should be emitted')
  assert.equal(tool!.name, 'execute_tool bash')
  assert.equal(tool!.attributes[ATTR.toolName], 'bash')
  const input = String(tool!.attributes['dsh.trace.tool_input'])
  assert.ok(!input.includes('sk-should-vanish'), 'tool args must be sanitized')
  assert.equal(tool!.attributes['dsh.trace.tool_output'], 'file.txt')
  assert.equal(tool!.status, 'ok')
})

test('llm end event emits a chat generation span honoring the token invariant', () => {
  const spans: Span[] = []
  const c = makeCollector({}, spans)
  c.feed({
    kind: 'llm', phase: 'end', sessionId: 's1', ts: ts(2),
    llm: {
      provider: 'deepseek', model: 'deepseek-chat',
      inputTokens: 100, outputTokens: 40, cacheReadTokens: 60, reasoningTokens: 10,
      prompt: 'hello', completion: 'hi',
    },
  })
  const llm = spans.find((s) => s.kind === 'llm')
  assert.ok(llm)
  assert.equal(llm!.name, 'chat deepseek-chat')
  assert.equal(llm!.attributes[ATTR.operation], 'chat')
  assert.equal(llm!.attributes[ATTR.provider], 'deepseek')
  assert.equal(llm!.attributes[ATTR.usageInput], 100, 'input tokens keep their own total')
  assert.equal(llm!.attributes[ATTR.usageOutput], 40)
  assert.equal(llm!.attributes[ATTR.usageCacheRead], 60, 'cache read is a detail, not added again')
  assert.equal(llm!.attributes[ATTR.usageReasoning], 10, 'reasoning is a detail of output')
})

test('error tool call marks span status error', () => {
  const spans: Span[] = []
  const c = makeCollector({}, spans)
  c.feed({ kind: 'turn', phase: 'start', sessionId: 's1', ts: ts(0) })
  c.feed({
    kind: 'tool', phase: 'end', sessionId: 's1', ts: ts(1),
    tool: { name: 'bash', callId: 'cx', error: 'boom' },
  })
  const tool = spans.find((s) => s.kind === 'tool')
  assert.equal(tool!.status, 'error')
  assert.equal(tool!.errorMessage, 'boom')
})

test('capture flags suppress span kinds', () => {
  const spans: Span[] = []
  const c = makeCollector({ capture: { turns: false, steps: false, tools: false, llm: false } }, spans)
  c.feed({ kind: 'turn', phase: 'start', sessionId: 's1', ts: ts(0) })
  c.feed({ kind: 'tool', phase: 'end', sessionId: 's1', ts: ts(1), tool: { name: 'bash' } })
  c.feed({ kind: 'llm', phase: 'end', sessionId: 's1', ts: ts(2), llm: { model: 'm' } })
  assert.equal(spans.length, 0)
})

test('closeAll closes dangling spans', () => {
  const spans: Span[] = []
  const c = makeCollector({}, spans)
  c.feed({ kind: 'turn', phase: 'start', sessionId: 's1', ts: ts(0) })
  c.feed({ kind: 'tool', phase: 'start', sessionId: 's1', ts: ts(1), tool: { name: 'bash', callId: 'c1' } })
  assert.equal(spans.length, 0)
  c.closeAll()
  assert.equal(spans.filter((s) => s.kind === 'turn').length, 1)
  assert.equal(spans.filter((s) => s.kind === 'tool').length, 1)
})

test('projections with unknown session id still flow through', () => {
  const spans: Span[] = []
  const c = makeCollector({}, spans)
  const raw = { sessionId: undefined } as unknown as SessionEventProjection
  c.feed({ ...raw, kind: 'turn', phase: 'start', ts: ts(0), sessionId: 'fallback' })
  c.feed({ kind: 'turn', phase: 'end', ts: ts(1), sessionId: 'fallback' })
  assert.equal(spans.length, 1)
})
