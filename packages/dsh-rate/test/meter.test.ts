import test from 'node:test'
import assert from 'node:assert/strict'
import { BackoffTracker } from '../lib/backoff.js'
import { UsageMeter } from '../lib/meter.js'

test('backoff grows exponentially and caps', () => {
  const t = new BackoffTracker({ baseMs: 1000, factor: 2, maxMs: 4000 })
  assert.equal(t.onRateLimited(0), 1000)
  assert.equal(t.onRateLimited(0), 2000)
  assert.equal(t.onRateLimited(0), 4000)
  assert.equal(t.onRateLimited(0), 4000) // capped
  assert.equal(t.streak, 4)
})

test('backoff remaining window decays and resets on success', () => {
  const t = new BackoffTracker({ baseMs: 1000, factor: 2, maxMs: 4000 })
  t.onRateLimited(1000)
  assert.equal(t.remainingMs(1500), 500)
  assert.equal(t.remainingMs(2000), 0)
  t.onRateLimited(2000)
  t.onSuccess()
  assert.equal(t.remainingMs(2001), 0)
  assert.equal(t.streak, 0)
})

test('disabled tracker never blocks', () => {
  const t = new BackoffTracker({ enabled: false, baseMs: 1000 })
  t.onRateLimited(0)
  assert.equal(t.remainingMs(0), 0)
})

test('meter projects tokens and 429s from dsh-ish events', () => {
  const a = UsageMeter.projectTokens({
    type: 'assistant/message',
    usage: { input_tokens: 100, output_tokens: 50 },
  })
  assert.equal(a?.tokens, 150)
  assert.equal(a?.isRateLimited, false)

  const b = UsageMeter.projectTokens({
    type: 'llm/end',
    error: 'HTTP 429 rate limit exceeded',
    usage: { inputTokens: 10, outputTokens: 5 },
  })
  assert.equal(b?.isRateLimited, true)

  const c = UsageMeter.projectTokens({ type: 'tool/start', tool: { name: 'x' } })
  assert.equal(c, null)
})

test('meter aggregates tokens per UTC day', () => {
  const m = new UsageMeter()
  assert.equal(m.addTokens(100, new Date('2026-09-19T10:00:00Z')), 100)
  assert.equal(m.addTokens(50, new Date('2026-09-19T23:00:00Z')), 150)
  assert.equal(m.tokensToday(new Date('2026-09-19T23:59:00Z')), 150)
  assert.equal(m.tokensToday(new Date('2026-09-20T00:01:00Z')), 0)
})

test('tool storm window counts and prunes', () => {
  const m = new UsageMeter()
  assert.equal(m.recordToolCall(1000, 60_000), 1)
  assert.equal(m.recordToolCall(2000, 60_000), 2)
  assert.equal(m.recordToolCall(61_500, 60_000), 2) // first call pruned
})
