import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachRateShield, parseToolCall } from '../lib/adapter.js'
import { BackoffTracker } from '../lib/backoff.js'
import { UsageMeter } from '../lib/meter.js'
import { AuditLogger } from '../lib/audit.js'
import { bucketOf, globMatch, makeTicketScope, resolveTicketScope, ruleForTicket } from '../lib/ticket-scope.js'
import type { RateConfig } from '../lib/types.js'

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never

interface Listener {
  event: string
  fn: (payload: unknown) => unknown
}

function mockCtx(service?: Record<string, unknown>) {
  const events: Listener[] = []
  return {
    events,
    on(event: string, fn: (payload: unknown) => unknown) {
      events.push({ event, fn })
    },
    get(name: string) {
      return name === 'ticket' ? service : undefined
    },
  }
}

function setup(config: RateConfig, service?: Record<string, unknown>) {
  const ctx = mockCtx(service)
  const meter = new UsageMeter()
  const backoff = new BackoffTracker(config.backoff)
  const dir = mkdtempSync(join(tmpdir(), 'rate-'))
  const audit = new AuditLogger({ enabled: false, file: join(dir, 'a.jsonl') }, dir)
  const ticketScope = makeTicketScope(ctx as never, config.ticket)
  attachRateShield(ctx, { config, meter, backoff, audit, logger, ...(ticketScope ? { ticketScope } : {}) })
  const pre = ctx.events.find((e) => e.event === 'tools/pre-execute')!.fn
  const onEvent = ctx.events.find((e) => e.event === 'session/event')!.fn
  return { pre, onEvent, meter }
}

// --- scope helpers -------------------------------------------------------

test('resolveTicketScope reads worker-<ticketId> and the router', () => {
  assert.deepEqual(resolveTicketScope('worker-t-1'), { role: 'worker', sessionId: 'worker-t-1', ticketId: 't-1' })
  assert.deepEqual(resolveTicketScope('master', { masterId: 'master' }), { role: 'router', sessionId: 'master' })
  assert.equal(resolveTicketScope('master'), undefined)
  assert.equal(resolveTicketScope('worker-'), undefined)
  assert.equal(resolveTicketScope('plain'), undefined)
  assert.equal(resolveTicketScope(42), undefined)
})

test('globMatch stays inside one segment unless ** is used', () => {
  assert.ok(globMatch('fix-*', 'fix-login'))
  assert.ok(!globMatch('fix-*', 'fix/login'))
  assert.ok(globMatch('fix/**', 'fix/login'))
  assert.ok(globMatch('fix/**', 'fix/a/b'))
  assert.ok(!globMatch('fix/*', 'fix/a/b'))
  assert.ok(globMatch('*', 'anything'))
  assert.ok(globMatch('t-?', 't-1'))
  assert.ok(!globMatch('t-?', 't-12'))
})

test('ruleForTicket matches the router on the literal "router"', () => {
  const rules = [{ match: 'fix-*', maxCalls: 5 }, { match: 'router', maxCalls: 100 }]
  assert.equal(ruleForTicket(rules, { role: 'worker', sessionId: 'worker-fix-a', ticketId: 'fix-a' })?.maxCalls, 5)
  assert.equal(ruleForTicket(rules, { role: 'router', sessionId: 'm' })?.maxCalls, 100)
  assert.equal(ruleForTicket(rules, { role: 'worker', sessionId: 'worker-x', ticketId: 'x' }), undefined)
})

test('bucketOf uses the ticket id, or "router"', () => {
  assert.equal(bucketOf({ role: 'worker', sessionId: 'worker-a', ticketId: 'a' }), 'a')
  assert.equal(bucketOf({ role: 'router', sessionId: 'm' }), 'router')
  assert.equal(bucketOf(undefined), undefined)
})

test('makeTicketScope prefers the shared service rule table', () => {
  const handle = makeTicketScope(
    { get: () => ({ scopeOf: () => ({ role: 'worker', sessionId: 'worker-z', ticketId: 'z' }), rules: [{ match: '*', maxCalls: 7 }] }) } as never,
    { rules: [{ match: '*', maxCalls: 1 }] },
  )
  assert.equal(handle?.source, 'service')
  assert.equal(handle?.ruleFor(handle.scopeOf('anything'))?.maxCalls, 7)
})

test('makeTicketScope is off when disabled', () => {
  assert.equal(makeTicketScope({ get: () => undefined } as never, { enabled: false }), undefined)
})

// --- meter bucketing -----------------------------------------------------

test('meter keeps global and per-ticket totals apart', () => {
  const meter = new UsageMeter()
  const now = new Date('2026-01-01T00:00:00Z')
  meter.addTokens(100, now)
  meter.addTokens(100, now, 't-1')
  meter.addTokens(50, now, 't-2')
  assert.equal(meter.tokensToday(now), 100)
  assert.equal(meter.tokensToday(now, 't-1'), 100)
  assert.equal(meter.tokensToday(now, 't-2'), 50)
})

test('storm windows are counted per bucket', () => {
  const meter = new UsageMeter()
  const now = 1_000_000
  assert.equal(meter.recordToolCall(now, 60_000, 'a'), 1)
  assert.equal(meter.recordToolCall(now, 60_000, 'a'), 2)
  assert.equal(meter.recordToolCall(now, 60_000, 'b'), 1)
  assert.equal(meter.recordToolCall(now + 120_000, 60_000, 'a'), 1)
})

// --- enforcement ---------------------------------------------------------

test('one ticket exhausting its allowance does not block another ticket', () => {
  const { pre, onEvent } = setup({
    enabled: true,
    mode: 'enforce',
    budget: { dailyTokens: 0, criticalAction: 'block-tools' },
    ticket: { rules: [{ match: 'fix-*', dailyTokens: 1000 }] },
  })

  onEvent({ type: 'assistant', sessionId: 'worker-fix-1', usage: { input_tokens: 1000, output_tokens: 0 } })

  const denied = pre({ tool: 'bash', args: { command: 'ls' }, sessionId: 'worker-fix-1' }) as { kind: string; ruleId?: string } | undefined
  assert.equal(denied?.kind, 'deny')
  assert.equal(denied?.ruleId, 'rate-budget:ticket:fix-*')

  // A different ticket has its own untouched allowance.
  assert.equal(pre({ tool: 'bash', args: { command: 'ls' }, sessionId: 'worker-fix-2' }), undefined)
  // A session outside Super-agent falls back to the global budget (0 = off).
  assert.equal(pre({ tool: 'bash', args: { command: 'ls' }, sessionId: 'plain' }), undefined)
})

test('a ticket rule can tighten the mode to enforce while the global mode is monitor', () => {
  const { pre } = setup({
    enabled: true,
    mode: 'monitor',
    toolStorm: { maxCalls: 1, windowMs: 60_000 },
    ticket: { rules: [{ match: 'review-*', mode: 'enforce', maxCalls: 1 }] },
  })

  // Global monitor: never denies, even past the storm limit.
  assert.equal(pre({ tool: 'read', args: {}, sessionId: 'plain' }), undefined)
  assert.equal(pre({ tool: 'read', args: {}, sessionId: 'plain' }), undefined)

  // The review ticket enforces its own window.
  assert.equal(pre({ tool: 'read', args: {}, sessionId: 'worker-review-1' }), undefined)
  const denied = pre({ tool: 'read', args: {}, sessionId: 'worker-review-1' }) as { kind: string; ruleId?: string } | undefined
  assert.equal(denied?.kind, 'deny')
  assert.equal(denied?.ruleId, 'rate-storm:ticket:review-*')
})

test('a ticket storm window leaves other tickets unaffected', () => {
  const { pre } = setup({
    enabled: true,
    mode: 'enforce',
    ticket: { rules: [{ match: 'busy-*', maxCalls: 2 }] },
    toolStorm: { maxCalls: 100, windowMs: 60_000 },
  })

  assert.equal(pre({ tool: 'read', args: {}, sessionId: 'worker-busy-1' }), undefined)
  assert.equal(pre({ tool: 'read', args: {}, sessionId: 'worker-busy-1' }), undefined)
  const denied = pre({ tool: 'read', args: {}, sessionId: 'worker-busy-1' }) as { kind: string } | undefined
  assert.equal(denied?.kind, 'deny')

  // A quiet ticket keeps working.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(pre({ tool: 'read', args: {}, sessionId: 'worker-calm-1' }), undefined)
  }
})

test('the global budget still applies to a ticket without its own allowance', () => {
  const { pre, onEvent } = setup({
    enabled: true,
    mode: 'enforce',
    budget: { dailyTokens: 500, criticalAction: 'block-tools' },
    ticket: { rules: [{ match: 'special-*', dailyTokens: 10_000 }] },
  })

  onEvent({ type: 'assistant', sessionId: 'worker-plain-1', usage: { input_tokens: 500, output_tokens: 0 } })

  const denied = pre({ tool: 'bash', args: {}, sessionId: 'worker-plain-1' }) as { kind: string; ruleId?: string } | undefined
  assert.equal(denied?.kind, 'deny')
  assert.equal(denied?.ruleId, 'rate-budget')

  // The special ticket has its own larger allowance, and the global one is
  // already spent — the tighter of the two still governs it.
  const special = pre({ tool: 'bash', args: {}, sessionId: 'worker-special-1' }) as { kind: string; ruleId?: string } | undefined
  assert.equal(special?.kind, 'deny')
  assert.equal(special?.ruleId, 'rate-budget')
})

test('parseToolCall tolerates the shapes the pipeline emits', () => {
  assert.deepEqual(parseToolCall({ tool: 'bash', args: { command: 'ls' }, sessionId: 's' }), {
    tool: 'bash',
    args: { command: 'ls' },
    sessionId: 's',
  })
  assert.equal(parseToolCall({ args: {} }), null)
  assert.equal(parseToolCall('nope'), null)
})
