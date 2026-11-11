import test from 'node:test'
import assert from 'node:assert/strict'
import { projectSessionEvent } from '../lib/event-map.js'
import { SpanCollector } from '../lib/collector.js'
import { createSanitizer } from '../lib/sanitize.js'
import type { Span, TraceConfig } from '../lib/types.js'

/**
 * The `session/event` hook is a two-argument broadcast, and the payloads below
 * are copied verbatim from a probe run inside a live harness. The projection
 * used to take a single flat object, so every one of these produced null and
 * the plugin exported nothing — while the flat fixtures kept passing. These
 * tests pin the real shapes so that regression cannot come back quietly.
 */

const SESSION = { header: { id: 'session-4dbfd94d', cwd: '/tmp/ws' } }
const t0 = 1_700_000_000_000

function broadcast(event: unknown) {
  return projectSessionEvent(SESSION, event)
}

function makeCollector(spans: Span[]): SpanCollector {
  return new SpanCollector({
    config: {
      enabled: true,
      capture: { turns: true, steps: true, tools: true, llm: true },
      llm: { prompt: true, completion: true },
      metadata: { sessionId: true, model: true },
      sanitize: { enabled: true },
    } as TraceConfig,
    sanitizer: createSanitizer({ enabled: true }),
    onSpan: (span) => spans.push(span),
  })
}

test('tool/call projects a tool start carrying the session id and parsed args', () => {
  const p = broadcast({
    type: 'tool/call',
    seq: 12,
    time: t0,
    data: {
      turn: 1,
      step: 1,
      callId: 'call_00_dHxxrQavbdFK5qBjTQCh7443',
      name: 'bash',
      arguments: '{"command": "echo probe-run", "description": "Run echo"}',
    },
  })
  assert.ok(p, 'a real tool/call must not be dropped')
  assert.equal(p.kind, 'tool')
  assert.equal(p.phase, 'start')
  // Identity comes from the Session object, not from the event.
  assert.equal(p.sessionId, 'session-4dbfd94d')
  assert.equal(p.ts, t0)
  assert.equal(p.turn, 1)
  assert.equal(p.step, 1)
  assert.equal(p.tool?.name, 'bash')
  assert.equal(p.tool?.callId, 'call_00_dHxxrQavbdFK5qBjTQCh7443')
  // dsh serialises arguments as a JSON string; spans want a real object.
  assert.deepEqual(p.tool?.args, { command: 'echo probe-run', description: 'Run echo' })
})

test('tool/result projects an end keyed only by the callId inside message.source', () => {
  const p = broadcast({
    type: 'tool/result',
    seq: 13,
    time: t0 + 40,
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId: 'call_00_dHxxrQavbdFK5qBjTQCh7443' },
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_00_dHxxrQavbdFK5qBjTQCh7443',
            content: [{ type: 'text', text: 'probe-run\n' }],
            isError: false,
          },
        ],
        role: 'user',
        id: 'ea6c7d30-376c-48df-a6b5-2dae0c3c06c5',
      },
    },
  })
  assert.ok(p, 'a real tool/result must not be dropped')
  assert.equal(p.kind, 'tool')
  assert.equal(p.phase, 'end')
  assert.equal(p.tool?.callId, 'call_00_dHxxrQavbdFK5qBjTQCh7443')
  assert.equal(p.tool?.result, 'probe-run\n')
  assert.equal(p.tool?.error, undefined)
})

test('tool/result marks failures and keeps the start event name on the span', () => {
  const spans: Span[] = []
  const c = makeCollector(spans)
  c.feed(broadcast({
    type: 'tool/call', time: t0,
    data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"exit 1"}' },
  })!)
  c.feed(broadcast({
    type: 'tool/result', time: t0 + 10,
    data: {
      turn: 1, step: 1,
      message: {
        source: { kind: 'tool', callId: 'c1' },
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'boom' }], isError: true }],
      },
    },
  })!)

  assert.equal(spans.length, 1)
  const span = spans[0]!
  assert.equal(span.kind, 'tool')
  assert.equal(span.status, 'error')
  assert.equal(span.errorMessage, 'boom')
  // The result event has no name; merging it must not blank the span's name.
  assert.equal(span.attributes['gen_ai.tool.name'], 'bash')
  assert.match(span.name, /bash/)
})

test('request/context opens an llm span that assistant/message closes with usage', () => {
  const spans: Span[] = []
  const c = makeCollector(spans)
  c.feed(broadcast({
    type: 'turn/start', time: t0, data: { turn: 1 },
  })!)
  c.feed(broadcast({
    type: 'request/context', time: t0 + 5,
    data: { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 128000 },
  })!)
  c.feed(broadcast({
    type: 'assistant/message', time: t0 + 900,
    data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      usage: { input_tokens: 1200, output_tokens: 34, cache_read_input_tokens: 900 },
      stream: false,
    },
  })!)
  c.feed(broadcast({ type: 'turn/end', time: t0 + 1000, data: { turn: 1, reason: 'complete' } })!)

  const llm = spans.find((s) => s.kind === 'llm')
  assert.ok(llm, 'the request/assistant pair must produce an llm span')
  assert.equal(llm.attributes['gen_ai.provider.name'], 'deepseek')
  assert.equal(llm.attributes['gen_ai.request.model'], 'deepseek-chat')
  assert.equal(llm.attributes['gen_ai.usage.input_tokens'], 1200)
  assert.equal(llm.attributes['gen_ai.usage.output_tokens'], 34)
  assert.equal(llm.endTime - llm.startTime, 895)
})

test('turn and step events project with the phase their type names', () => {
  const start = broadcast({ type: 'turn/start', time: t0, data: { turn: 2 } })
  const end = broadcast({ type: 'turn/end', time: t0 + 5, data: { turn: 2, reason: 'complete' } })
  const step = broadcast({ type: 'step/start', time: t0 + 1, data: { turn: 2, step: 3 } })
  assert.equal(start?.kind, 'turn')
  assert.equal(start?.phase, 'start')
  assert.equal(end?.phase, 'end')
  assert.equal(step?.kind, 'step')
  assert.equal(step?.step, 3)
})

test('events this plugin does not model stay dropped', () => {
  assert.equal(broadcast({ type: 'sandbox/mode', time: t0, data: { mode: 'workspace-write' } }), null)
  assert.equal(broadcast({ type: 'session/title', time: t0, data: { title: 'hi' } }), null)
  // A single flat object is still accepted for the existing fixtures…
  assert.ok(projectSessionEvent({ type: 'turn/start', turn: 1, sessionId: 's1' }))
  // …but neither shape on its own is allowed to throw.
  assert.equal(projectSessionEvent({}), null)
  assert.equal(projectSessionEvent(null, undefined), null)
})
