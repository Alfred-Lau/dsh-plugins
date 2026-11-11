import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { attachPolicy } from '../lib/adapter.js'
import { PolicyEvaluator } from '../lib/evaluator.js'
import { AuditLogger } from '../lib/audit.js'
import type { PolicyConfig } from '../lib/types.js'

/**
 * Regression: `tools/pre-execute` is a Cordis waterfall. A listener that
 * returns `undefined` ends the chain there, so with several governance plugins
 * installed only the first one ever spoke. Every "no objection" path must call
 * `next()` instead.
 */

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

function attach(ctx: Context, config: PolicyConfig): void {
  const evaluator = new PolicyEvaluator(config)
  const audit = new AuditLogger({ enabled: false })
  attachPolicy(ctx as never, evaluator, audit, silentLogger as never)
}

test('a permissive policy layer still lets a later deny rule speak', () => {
  const ctx = new Context()
  ctx.provide('logger', silentLogger)
  // First layer allows everything it sees; the second denies `git push`.
  attach(ctx, { enabled: true, defaultDecision: 'allow', failClosed: true, rules: [], audit: { enabled: false } })
  attach(ctx, {
    enabled: true,
    defaultDecision: 'allow',
    failClosed: true,
    rules: [{ id: 'deny-push', effect: 'deny', tools: ['bash'], commands: ['^git\\s+push'] }],
    audit: { enabled: false },
  })

  const verdict = ctx.waterfall(
    'tools/pre-execute',
    { tool: 'bash', args: { command: 'git push origin main' }, sessionId: 's1' },
    () => undefined,
  ) as { kind?: string; ruleId?: string } | undefined

  assert.equal(verdict?.kind, 'deny')
  assert.equal(verdict?.ruleId, 'deny-push')
})

test('an allow from an earlier layer does not short-circuit a later deny', () => {
  const ctx = new Context()
  ctx.provide('logger', silentLogger)
  attach(ctx, {
    enabled: true,
    defaultDecision: 'allow',
    failClosed: true,
    rules: [{ id: 'allow-all-bash', effect: 'allow', priority: 1, tools: ['bash'] }],
    audit: { enabled: false },
  })
  attach(ctx, {
    enabled: true,
    defaultDecision: 'allow',
    failClosed: true,
    rules: [{ id: 'deny-push', effect: 'deny', tools: ['bash'], commands: ['^git\\s+push'] }],
    audit: { enabled: false },
  })

  const verdict = ctx.waterfall(
    'tools/pre-execute',
    { tool: 'bash', args: { command: 'git push origin main' }, sessionId: 's1' },
    () => undefined,
  ) as { kind?: string } | undefined

  assert.equal(verdict?.kind, 'deny')
})

test('with nothing to say the chain reaches the innermost handler', () => {
  const ctx = new Context()
  ctx.provide('logger', silentLogger)
  attach(ctx, { enabled: true, defaultDecision: 'allow', failClosed: true, rules: [], audit: { enabled: false } })

  let reached = false
  const verdict = ctx.waterfall(
    'tools/pre-execute',
    { tool: 'read', args: { path: 'a.ts' }, sessionId: 's1' },
    () => {
      reached = true
      return { kind: 'deny', ruleId: 'harness-default' }
    },
  ) as { ruleId?: string } | undefined

  assert.equal(reached, true)
  assert.equal(verdict?.ruleId, 'harness-default')
})
