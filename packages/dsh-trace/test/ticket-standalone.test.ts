import test from 'node:test'
import assert from 'node:assert/strict'
import { SpanCollector } from '../lib/collector.js'
import { createSanitizer } from '../lib/sanitize.js'
import { DSH_ATTR } from '../lib/semconv.js'
import type { Span, TraceConfig } from '../lib/types.js'

/**
 * Regression: an LLM completion that arrives without a matching start event is
 * emitted as a standalone span. That path used to build its attribute map by
 * hand and skip `addMetadata`, so the span lost both `dsh.session.id` and the
 * ticket tag — exactly the case where a session only reports completions.
 */
function makeCollector(spans: Span[]): SpanCollector {
  return new SpanCollector({
    config: {
      enabled: true,
      capture: { turns: true, steps: true, tools: true, llm: true },
      llm: { prompt: true, completion: true },
      metadata: { sessionId: true, model: true, ticket: true },
      sanitize: { enabled: true },
    } as TraceConfig,
    sanitizer: createSanitizer({ enabled: true }),
    onSpan: (span) => spans.push(span),
  })
}

test('a standalone llm end event keeps the session id and ticket attributes', () => {
  const spans: Span[] = []
  const c = makeCollector(spans)
  c.feed({
    kind: 'llm',
    phase: 'end',
    sessionId: 'worker-t-1042',
    ts: 1_700_000_000_500,
    ticket: { role: 'worker', ticketId: 't-1042' },
    llm: { model: 'deepseek-chat', usage: { inputTokens: 100, outputTokens: 10 } },
  })
  assert.equal(spans.length, 1)
  const span = spans[0]!
  assert.equal(span.kind, 'llm')
  assert.equal(span.attributes[DSH_ATTR.sessionId], 'worker-t-1042')
  assert.equal(span.attributes[DSH_ATTR.ticketId], 't-1042')
  assert.equal(span.attributes[DSH_ATTR.ticketRole], 'worker')
  assert.deepEqual(span.ticket, { role: 'worker', ticketId: 't-1042' })
})

test('a standalone llm end event for the router is tagged with the router role', () => {
  const spans: Span[] = []
  const c = makeCollector(spans)
  c.feed({
    kind: 'llm',
    phase: 'end',
    sessionId: 'master',
    ts: 1_700_000_000_500,
    ticket: { role: 'router' },
    llm: { model: 'deepseek-chat' },
  })
  assert.equal(spans[0]!.attributes[DSH_ATTR.ticketRole], 'router')
  assert.equal(spans[0]!.attributes[DSH_ATTR.ticketId], undefined)
})
