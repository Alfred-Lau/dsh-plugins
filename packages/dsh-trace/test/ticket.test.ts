import test from 'node:test'
import assert from 'node:assert/strict'
import { SpanCollector } from '../lib/collector.js'
import { createSanitizer } from '../lib/sanitize.js'
import { DSH_ATTR } from '../lib/semconv.js'
import { makeScopeResolver, resolveTicketScope, ticketServiceOf } from '../lib/ticket.js'
import { buildLangfuseBatch } from '../lib/export/langfuse.js'
import type { SessionEventProjection, Span, TraceConfig } from '../lib/types.js'

const ts = (n: number) => 1_700_000_000_000 + n

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
    onSpan: span => spans.push(span),
  })
}

test('resolveTicketScope reads the worker-<ticketId> convention', () => {
  assert.deepEqual(resolveTicketScope('worker-t-42', {}), { role: 'worker', ticketId: 't-42' })
  assert.deepEqual(resolveTicketScope('worker-t-42', { masterId: 'm' }), { role: 'worker', ticketId: 't-42' })
})

test('resolveTicketScope only claims the router when masterId is configured', () => {
  assert.deepEqual(resolveTicketScope('master-1', { masterId: 'master-1' }), { role: 'router' })
  assert.equal(resolveTicketScope('master-1', {}), undefined)
})

test('resolveTicketScope ignores non-Super-agent sessions', () => {
  assert.equal(resolveTicketScope('session-abc', { masterId: 'master-1' }), undefined)
  assert.equal(resolveTicketScope('worker-', {}), undefined)
  assert.equal(resolveTicketScope(undefined, {}), undefined)
})

test('resolveTicketScope honours a custom worker prefix', () => {
  assert.deepEqual(resolveTicketScope('exec-9', { workerPrefix: 'exec-' }), { role: 'worker', ticketId: '9' })
  assert.equal(resolveTicketScope('worker-9', { workerPrefix: 'exec-' }), undefined)
})

test('ticketServiceOf finds a provided ticket service and tolerates its absence', () => {
  const service = { scopeOf: () => ({ role: 'worker' as const, ticketId: 'x' }) }
  assert.equal(ticketServiceOf({ get: (name: string) => (name === 'ticket' ? service : undefined) }), service)
  assert.equal(ticketServiceOf({ get: () => undefined }), undefined)
  assert.equal(ticketServiceOf({}), undefined)
  assert.equal(ticketServiceOf({ get: () => { throw new Error('nope') } }), undefined)
  assert.equal(ticketServiceOf(undefined), undefined)
})

test('makeScopeResolver prefers the shared ticket service over the local derivation', () => {
  const ctx = { get: (name: string) => (name === 'ticket' ? { scopeOf: () => ({ role: 'worker', ticketId: 'from-service' }) } : undefined) }
  const scopeOf = makeScopeResolver(ctx, {})
  assert.deepEqual(scopeOf?.('anything'), { role: 'worker', ticketId: 'from-service' })
})

test('makeScopeResolver falls back to the Session id when no service is loaded', () => {
  const scopeOf = makeScopeResolver({}, { masterId: 'master-1' })
  assert.deepEqual(scopeOf?.('worker-t-1'), { role: 'worker', ticketId: 't-1' })
  assert.deepEqual(scopeOf?.('master-1'), { role: 'router' })
})

test('makeScopeResolver returns undefined when tagging is disabled', () => {
  assert.equal(makeScopeResolver({}, { enabled: false }), undefined)
})

test('spans carry dsh.ticket.* attributes and the ticket object', () => {
  const spans: Span[] = []
  const c = makeCollector({}, spans)
  const projection: SessionEventProjection = {
    kind: 'turn', phase: 'start', sessionId: 'worker-t-7', ts: ts(0),
    ticket: { role: 'worker', ticketId: 't-7' },
  }
  c.feed(projection)
  c.feed({ ...projection, phase: 'end', ts: ts(5) })

  assert.equal(spans.length, 1)
  const span = spans[0]!
  assert.equal(span.attributes[DSH_ATTR.ticketId], 't-7')
  assert.equal(span.attributes[DSH_ATTR.ticketRole], 'worker')
  assert.deepEqual(span.ticket, { role: 'worker', ticketId: 't-7' })
})

test('router spans carry the role but no ticket id', () => {
  const spans: Span[] = []
  const c = makeCollector({}, spans)
  c.feed({ kind: 'turn', phase: 'start', sessionId: 'master-1', ts: ts(0), ticket: { role: 'router' } })
  c.feed({ kind: 'turn', phase: 'end', sessionId: 'master-1', ts: ts(3), ticket: { role: 'router' } })

  const span = spans[0]!
  assert.equal(span.attributes[DSH_ATTR.ticketRole], 'router')
  assert.equal(span.attributes[DSH_ATTR.ticketId], undefined)
})

test('metadata.ticket=false suppresses ticket attributes', () => {
  const spans: Span[] = []
  const c = makeCollector({ metadata: { sessionId: true, model: true, ticket: false } }, spans)
  c.feed({ kind: 'turn', phase: 'start', sessionId: 'worker-t-7', ts: ts(0), ticket: { role: 'worker', ticketId: 't-7' } })
  c.feed({ kind: 'turn', phase: 'end', sessionId: 'worker-t-7', ts: ts(2), ticket: { role: 'worker', ticketId: 't-7' } })

  assert.equal(spans[0]!.attributes[DSH_ATTR.ticketId], undefined)
  assert.equal(spans[0]!.ticket, undefined)
})

test('Langfuse traces are tagged with the ticket', () => {
  const spans: Span[] = []
  const c = makeCollector({}, spans)
  c.feed({ kind: 'turn', phase: 'start', sessionId: 'worker-t-9', ts: ts(0), ticket: { role: 'worker', ticketId: 't-9' } })
  c.feed({ kind: 'turn', phase: 'end', sessionId: 'worker-t-9', ts: ts(4), ticket: { role: 'worker', ticketId: 't-9' } })

  const batch = buildLangfuseBatch(spans, { publicKey: 'p', secretKey: 's', tags: ['nightly'] })
  const body = batch[0]!.body as Record<string, unknown>
  assert.deepEqual(body.tags, ['nightly', 'dsh-ticket:t-9'])
})
