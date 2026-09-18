import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTracesPayload } from '../lib/export/otlp.js'
import { buildLangfuseBatch } from '../lib/export/langfuse.js'
import type { OtlpConfig, LangfuseConfig, Span } from '../lib/types.js'

function span(partial: Partial<Span>): Span {
  return {
    spanId: 'a'.repeat(16),
    traceId: 'b'.repeat(32),
    name: 'chat deepseek-chat',
    kind: 'llm',
    sessionId: 's1',
    turn: 1,
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_000_050,
    status: 'ok',
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'deepseek-chat',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 40,
    },
    ...partial,
  }
}

const otlpCfg: OtlpConfig = { endpoint: 'http://127.0.0.1:4318', serviceName: 'deepseek-harness' }
const lfCfg: LangfuseConfig = { publicKey: 'pk', secretKey: 'sk', baseUrl: 'https://lf.example' }

test('OTLP payload shape follows OTLP/HTTP JSON conventions', () => {
  const payload = buildTracesPayload(
    [span({}), span({ kind: 'turn', name: 'invoke_agent turn 1', parentSpanId: undefined })],
    otlpCfg,
  )
  assert.equal(payload.resourceSpans.length, 1)
  const rs = payload.resourceSpans[0]!
  const svc = rs.resource.attributes.find((a) => a.key === 'service.name')
  assert.equal((svc?.value as { stringValue?: string })?.stringValue, 'deepseek-harness')

  const spans = rs.scopeSpans[0]!.spans
  assert.equal(spans.length, 2)
  const llm = spans[0]!
  assert.equal(llm.traceId, 'b'.repeat(32))
  assert.equal(llm.spanId, 'a'.repeat(16))
  assert.equal(llm.kind, 1, 'SPAN_KIND_INTERNAL')
  assert.equal(llm.startTimeUnixNano, String(1_700_000_000_000n * 1_000_000n))
  assert.equal(llm.status.code, 1, 'OK')

  const inTok = llm.attributes.find((a) => a.key === 'gen_ai.usage.input_tokens')
  assert.equal((inTok?.value as { intValue?: string })?.intValue, '100', 'int64 values are strings in OTLP JSON')
})

test('error spans carry status code 2 and message', () => {
  const payload = buildTracesPayload([span({ status: 'error', errorMessage: 'boom' })], otlpCfg)
  const st = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.status
  assert.equal(st.code, 2)
  assert.equal(st.message, 'boom')
})

test('Langfuse batch puts traces first and maps generations', () => {
  const batch = buildLangfuseBatch(
    [
      span({ kind: 'llm', name: 'chat deepseek-chat' }),
      span({ kind: 'tool', name: 'execute_tool bash', traceId: 'b'.repeat(32), spanId: 'c'.repeat(16), parentSpanId: 'c'.repeat(16) }),
      span({ kind: 'turn', name: 'invoke_agent turn 1', traceId: 'b'.repeat(32) }),
    ],
    lfCfg,
  )
  assert.equal(batch[0]!.type, 'trace-create')
  assert.equal(batch[0]!.body.session_id, 's1')
  assert.ok(batch.slice(1).every((e) => e.type !== 'trace-create'), 'observations come after traces')

  const gen = batch.find((e) => e.type === 'generation-create')!
  assert.equal(gen.body.model, 'deepseek-chat')
  assert.equal((gen.body.usage as { input?: number }).input, 100)
  assert.equal((gen.body.usage as { unit?: string }).unit, 'TOKENS')

  const tool = batch.find((e) => e.type === 'span-create')!
  assert.equal(tool.body.trace_id, 'b'.repeat(32))
  assert.equal(tool.body.parent_observation_id, 'c'.repeat(16))
})

test('Langfuse tags and release flow into trace body', () => {
  const batch = buildLangfuseBatch([span({ kind: 'turn' })], {
    ...lfCfg,
    release: 'v0.1.0',
    tags: ['dsh', 'dev'],
  })
  assert.equal(batch[0]!.body.release, 'v0.1.0')
  assert.deepEqual(batch[0]!.body.tags, ['dsh', 'dev'])
})
