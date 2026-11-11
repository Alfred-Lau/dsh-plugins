import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { attachPolicy } from '../lib/adapter.js'
import { PolicyEvaluator } from '../lib/evaluator.js'
import { AuditLogger } from '../lib/audit.js'
import type { PolicyConfig } from '../lib/types.js'

/**
 * Regression: the tool pipeline is the harness's, not ours.
 *
 * `@deepseek-ai/dsh-tools` calls these two channels as cordis waterfalls and
 * then dereferences the result unconditionally:
 *
 *   const gate = await ctx.waterfall(carrier, 'tools/pre-execute', exec,
 *     () => Promise.resolve({ kind: 'allow' }))
 *   ... gate.kind === 'ask' ...
 *
 *   const decision = await ctx.waterfall(carrier, 'tools/post-execute',
 *     exec, result, () => Promise.resolve({ kind: 'accept' }))
 *   const decisionContexts = decision.additionalContexts ?? []
 *
 * Two ways to break that, both of which this file pins down:
 *   - returning `undefined` (the harness then reads `.kind` off nothing), and
 *   - returning `{ decision }` instead of `{ kind }`, which silently disables
 *     the `ask` path because `gate.kind` is never `'ask'`.
 */

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

function attach(ctx: Context, config: PolicyConfig): void {
  const evaluator = new PolicyEvaluator(config)
  const audit = new AuditLogger({ enabled: false })
  attachPolicy(ctx as never, evaluator, audit, silentLogger as never)
}

function makeContext(): Context {
  const ctx = new Context()
  ctx.provide('logger', silentLogger)
  return ctx
}

test('pre-execute hands the harness a verdict discriminated by `kind`', () => {
  const ctx = makeContext()
  attach(ctx, {
    enabled: true,
    defaultDecision: 'allow',
    failClosed: true,
    rules: [{ id: 'deny-push', effect: 'deny', tools: ['bash'], commands: ['^git\\s+push'] }],
    audit: { enabled: false },
  })

  // Exactly how the harness invokes it, including the innermost default.
  const gate = ctx.waterfall(
    'tools/pre-execute',
    { name: 'bash', arguments: { command: 'git push origin main' } },
    () => ({ kind: 'allow' }),
  ) as Record<string, unknown>

  assert.equal(gate.kind, 'deny', 'the harness reads `gate.kind`')
  assert.equal(gate.decision, undefined, 'a `decision` field is invisible to the harness')
  assert.equal(typeof gate.reason, 'string')
})

test('pre-execute allow defers to the harness default instead of faking a decision', () => {
  const ctx = makeContext()
  attach(ctx, { enabled: true, defaultDecision: 'allow', failClosed: true, rules: [], audit: { enabled: false } })

  const gate = ctx.waterfall(
    'tools/pre-execute',
    { name: 'read', arguments: { path: 'src/a.ts' } },
    () => ({ kind: 'allow' }),
  ) as Record<string, unknown>

  assert.equal(gate.kind, 'allow')
})

test('an ask rule survives as `kind: ask` so the harness approval flow can fire', () => {
  const ctx = makeContext()
  attach(ctx, {
    enabled: true,
    defaultDecision: 'allow',
    failClosed: true,
    rules: [{ id: 'ask-web', effect: 'ask', tools: ['web_*'] }],
    audit: { enabled: false },
  })

  const gate = ctx.waterfall(
    'tools/pre-execute',
    { name: 'web_search', arguments: { query: 'weather' } },
    () => ({ kind: 'allow' }),
  ) as Record<string, unknown>

  // `gate.kind === 'ask'` is what triggers `serviceAsk` in the harness. With a
  // `decision` field this branch was dead code.
  assert.equal(gate.kind, 'ask')
})

test('post-execute always returns a decision the harness can dereference', () => {
  const ctx = makeContext()
  attach(ctx, {
    enabled: true,
    defaultDecision: 'allow',
    failClosed: true,
    rules: [{ id: 'deny-push', effect: 'deny', tools: ['bash'], commands: ['^git\\s+push'] }],
    audit: { enabled: false },
  })

  const decision = ctx.waterfall(
    'tools/post-execute',
    { name: 'bash', arguments: { command: 'echo hi' } },
    { content: [{ type: 'text', text: 'hi' }], isError: false },
    () => ({ kind: 'accept' }),
  ) as Record<string, unknown>

  assert.ok(decision, 'returning undefined here is what crashes every tool call')
  assert.equal(decision.kind, 'accept')
  // The harness does `decision.additionalContexts ?? []` on this value.
  assert.doesNotThrow(() => (decision as { additionalContexts?: unknown }).additionalContexts ?? [])
})

test('post-execute survives a payload it cannot parse', () => {
  const ctx = makeContext()
  attach(ctx, { enabled: true, defaultDecision: 'allow', failClosed: true, rules: [], audit: { enabled: false } })

  const decision = ctx.waterfall(
    'tools/post-execute',
    'not-an-execution',
    undefined,
    () => ({ kind: 'accept' }),
  ) as Record<string, unknown>

  assert.equal(decision?.kind, 'accept')
})

test('post-execute does not swallow a later listener’s block decision', () => {
  const ctx = makeContext()
  attach(ctx, { enabled: true, defaultDecision: 'allow', failClosed: true, rules: [], audit: { enabled: false } })
  // A second layer registered after us owns the post-execute decision.
  ctx.on('tools/post-execute', (_exec: unknown, _result: unknown, next?: () => unknown) => {
    next?.()
    return { kind: 'block', feedback: [{ type: 'text', text: 'rewritten' }] }
  })

  const decision = ctx.waterfall(
    'tools/post-execute',
    { name: 'read', arguments: { path: 'a' } },
    { content: [], isError: false },
    () => ({ kind: 'accept' }),
  ) as Record<string, unknown>

  assert.equal(decision.kind, 'block')
})
