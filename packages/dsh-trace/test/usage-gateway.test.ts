import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { buildUsageEvents, HttpUsageBackend } from '../lib/export/usage-gateway.js'
import type { Span } from '../lib/types.js'

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

function fakeLogger() {
  const warns: string[] = []
  return {
    logger: { info: () => {}, warn: (m: string) => warns.push(m), error: () => {}, debug: () => {} },
    warns,
  }
}

test('buildUsageEvents projects an LLM span into an OpenMeter-compatible CloudEvent', () => {
  const s = span({
    spanId: '1234567890abcdef',
    attributes: {
      'gen_ai.request.model': 'deepseek-v4',
      'gen_ai.usage.input_tokens': 320,
      'gen_ai.usage.output_tokens': 96,
      'gen_ai.usage.details.cache_read': 200,
      'gen_ai.usage.details.reasoning': 30,
    },
  })
  const [ev] = buildUsageEvents([s], {})
  assert.ok(ev)
  assert.equal(ev.specversion, '1.0')
  assert.equal(ev.id, '1234567890abcdef')
  assert.equal(ev.type, 'com.dsh.llm.usage')
  assert.equal(ev.source, 'deepseek-harness')
  assert.equal(ev.subject, 's1')
  assert.equal(ev.time, new Date(1_700_000_000_050).toISOString())
  assert.deepEqual(
    { ...ev.data },
    {
      sessionId: 's1',
      spanId: '1234567890abcdef',
      model: 'deepseek-v4',
      status: 'ok',
      inputTokens: 320,
      outputTokens: 96,
      cacheReadTokens: 200,
      reasoningTokens: 30,
      totalTokens: 416,
    },
  )
})

test('buildUsageEvents defaults event type/source from config and skips non-LLM spans', () => {
  const tool = span({ kind: 'tool', name: 'execute_tool bash', attributes: { 'gen_ai.tool.name': 'bash' } })
  const turn = span({ kind: 'turn', name: 'invoke_agent turn 1' })
  const events = buildUsageEvents([tool, turn], { eventType: 'my.usage', eventSource: 'my-harness' })
  assert.equal(events.length, 0)

  const llm = span({})
  const [ev] = buildUsageEvents([tool, llm, turn], { eventType: 'my.usage', eventSource: 'my-harness' })
  assert.ok(ev)
  assert.equal(ev.type, 'my.usage')
  assert.equal(ev.source, 'my-harness')
})

test('buildUsageEvents reports zero tokens for a failed call and omits absent details', () => {
  const failed = span({ status: 'error', errorMessage: 'boom', attributes: { 'gen_ai.request.model': 'deepseek-chat' } })
  const [ev] = buildUsageEvents([failed], {})
  assert.ok(ev)
  assert.equal(ev.data.inputTokens, 0)
  assert.equal(ev.data.outputTokens, 0)
  assert.equal(ev.data.totalTokens, 0)
  assert.equal(ev.data.model, 'deepseek-chat')
  assert.equal(ev.data.cacheReadTokens, undefined)
  assert.equal(ev.data.reasoningTokens, undefined)
})

test('HttpUsageBackend posts CloudEvents array for usage mode', async () => {
  const bodies: unknown[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      bodies.push(JSON.parse(raw))
      res.writeHead(200).end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  assert.ok(addr && typeof addr === 'object')
  const url = `http://127.0.0.1:${addr.port}/events`
  const { logger } = fakeLogger()
  const backend = new HttpUsageBackend(
    { endpoint: url, mode: 'usage' },
    { logger, retry: { maxAttempts: 1, baseDelayMs: 1, factor: 1, maxDelayMs: 1 } },
  )
  try {
    backend.push(span({}))
    backend.push(span({ kind: 'tool', name: 'execute_tool bash' }))
    await backend.flush('test')
    assert.equal(bodies.length, 1)
    const arr = bodies[0] as unknown[]
    assert.equal(arr.length, 1, 'tool span filtered out in usage mode')
    const ev = arr[0] as { specversion: string; data: { inputTokens: number } }
    assert.equal(ev.specversion, '1.0')
    assert.equal(ev.data.inputTokens, 100)
  } finally {
    server.close()
    await new Promise((r) => server.close(r))
  }
})

test('HttpUsageBackend sends raw span arrays in spans mode and warns once on fatal failure', async () => {
  const { logger, warns } = fakeLogger()
  const backend = new HttpUsageBackend(
    { endpoint: 'http://127.0.0.1:1/none' },
    { logger, retry: { maxAttempts: 1, baseDelayMs: 1, factor: 1, maxDelayMs: 1 } },
  )
  backend.push(span({}))
  await backend.flush('test')
  assert.equal(warns.length, 1)
  assert.match(warns[0]!, /dropped 1 record/)
})
