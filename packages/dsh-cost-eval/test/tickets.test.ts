import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateTickets, extractSpans, priceFor, DEFAULT_PRICING } from '../lib/tickets.js'
import type { SpanLike } from '../lib/tickets.js'

const llm = (ticketId: string | undefined, input: number, output: number, cacheRead = 0, model = 'deepseek-chat'): SpanLike => ({
  kind: 'llm',
  sessionId: ticketId ? `worker-${ticketId}` : 'session-plain',
  ...(ticketId ? { ticket: { role: 'worker', ticketId } } : {}),
  attributes: {
    'gen_ai.usage.input_tokens': input,
    'gen_ai.usage.output_tokens': output,
    ...(cacheRead ? { 'gen_ai.usage.details.cache_read': cacheRead } : {}),
    'gen_ai.response.model': model,
  },
})

const tool = (ticketId: string, failed = false): SpanLike => ({
  kind: 'tool',
  sessionId: `worker-${ticketId}`,
  ticket: { role: 'worker', ticketId },
  status: failed ? 'error' : 'ok',
  attributes: { 'gen_ai.tool.name': 'bash' },
})

test('spans fold into one row per ticket', () => {
  const report = aggregateTickets([
    llm('t-1', 1_000_000, 100_000),
    llm('t-1', 500_000, 50_000),
    tool('t-1'),
    llm('t-2', 200_000, 20_000),
    tool('t-2', true),
  ])

  assert.equal(report.totals.tickets, 2)
  const t1 = report.tickets.find(t => t.ticketId === 't-1')!
  const t2 = report.tickets.find(t => t.ticketId === 't-2')!
  assert.equal(t1.llmCalls, 2)
  assert.equal(t1.toolCalls, 1)
  assert.equal(t1.inputTokens, 1_500_000)
  assert.equal(t2.failedToolCalls, 1)
  // Most expensive first.
  assert.equal(report.tickets[0]!.ticketId, 't-1')
})

test('cost uses list prices and bills cache-read tokens at the cache rate', () => {
  // 1M input of which 1M is cache-read → billed entirely at the cache rate.
  const cached = aggregateTickets([llm('t-1', 1_000_000, 0, 1_000_000)])
  assert.equal(cached.totals.costUsd, 0.07)

  // No cache: 1M input at 0.27 + 1M output at 1.10.
  const plain = aggregateTickets([llm('t-2', 1_000_000, 1_000_000)])
  assert.equal(Math.round(plain.totals.costUsd * 100) / 100, 1.37)
})

test('cache-read is capped at the input total', () => {
  // A malformed payload claiming more cache-read than input must not produce a credit.
  const report = aggregateTickets([llm('t-1', 100_000, 0, 900_000)])
  assert.ok(report.totals.costUsd > 0)
  assert.equal(Math.round(report.totals.costUsd * 1e6), 7_000)
})

test('unknown models are reported, not silently costed at zero', () => {
  const report = aggregateTickets([llm('t-1', 1_000_000, 0, 0, 'mystery-model')])
  assert.deepEqual(report.unpriced, ['mystery-model'])
  assert.equal(report.tickets[0]!.hasUnpricedModel, true)
  assert.equal(report.totals.costUsd, 0)
})

test('vendor-prefixed model names resolve to their price', () => {
  assert.equal(priceFor('deepseek/deepseek-chat', DEFAULT_PRICING)?.input, 0.27)
  assert.equal(priceFor('DeepSeek-Chat', DEFAULT_PRICING)?.input, 0.27)
  assert.equal(priceFor('unknown', DEFAULT_PRICING), undefined)
})

test('a budget flags the tickets that exceed it', () => {
  const report = aggregateTickets(
    [llm('cheap', 1_000_000, 0), llm('pricey', 100_000_000, 0)],
    DEFAULT_PRICING,
    5,
  )
  assert.equal(report.budgetUsd, 5)
  assert.deepEqual(report.overBudget.map(t => t.ticketId), ['pricey'])
})

test('a budget with no overspend reports an empty list', () => {
  const report = aggregateTickets([llm('cheap', 1_000, 0)], DEFAULT_PRICING, 5)
  assert.deepEqual(report.overBudget, [])
})

test('router spans are grouped under (router)', () => {
  const report = aggregateTickets([
    { kind: 'llm', sessionId: 'master-1', ticket: { role: 'router' }, attributes: { 'gen_ai.usage.input_tokens': 10, 'gen_ai.response.model': 'deepseek-chat' } },
  ])
  assert.equal(report.tickets[0]!.ticketId, '(router)')
  assert.equal(report.tickets[0]!.role, 'router')
})

test('untagged spans are counted but not billed', () => {
  const report = aggregateTickets([llm(undefined, 1_000_000, 0), tool('t-1')])
  assert.equal(report.untaggedSpans, 1)
  assert.equal(report.totals.tickets, 1)
})

test('a worker span with no ticket id is treated as untagged', () => {
  const report = aggregateTickets([{ kind: 'llm', ticket: { role: 'worker' } }])
  assert.equal(report.untaggedSpans, 1)
  assert.equal(report.totals.tickets, 0)
})

test('extractSpans accepts a bare array, a { spans } wrapper, OTLP and CloudEvents', () => {
  assert.equal(extractSpans([llm('t-1', 1, 1)]).length, 1)
  assert.equal(extractSpans({ spans: [llm('t-1', 1, 1)] }).length, 1)
  assert.equal(extractSpans({ nothing: true }).length, 0)
  assert.equal(extractSpans(null).length, 0)

  const otlp = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                name: 'chat deepseek-chat',
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                attributes: [
                  { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
                  { key: 'gen_ai.usage.input_tokens', value: { intValue: '120' } },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
  const fromOtlp = extractSpans(otlp)
  assert.equal(fromOtlp.length, 1)
  assert.equal(fromOtlp[0]!.kind, 'llm')
  assert.equal(fromOtlp[0]!.attributes!['gen_ai.usage.input_tokens'], '120')
  assert.equal(fromOtlp[0]!.startTime, 1_700_000_000_000)
})

test('a full ticket lifecycle rolls up into one cost row', () => {
  const spans: SpanLike[] = [
    { kind: 'turn', sessionId: 'worker-t-9', ticket: { role: 'worker', ticketId: 't-9' }, startTime: 1 },
    llm('t-9', 800_000, 40_000),
    tool('t-9'),
    tool('t-9'),
    tool('t-9', true),
    llm('t-9', 300_000, 25_000, 200_000),
    { kind: 'turn', sessionId: 'worker-t-9', ticket: { role: 'worker', ticketId: 't-9' }, endTime: 9_000 },
  ]
  const report = aggregateTickets(spans)
  const row = report.tickets[0]!
  assert.equal(row.spans, 7)
  assert.equal(row.llmCalls, 2)
  assert.equal(row.toolCalls, 3)
  assert.equal(row.failedToolCalls, 1)
  assert.equal(row.inputTokens, 1_100_000)
  assert.equal(row.lastSeen, 9_000)
  assert.ok(row.costUsd > 0)
})
