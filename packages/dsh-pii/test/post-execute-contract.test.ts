import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { attachPiiGate } from '../lib/adapter.js'
import { compileDetectors, PiiDetector } from '../lib/detector.js'
import { AuditLogger } from '../lib/audit.js'
import type { PiiConfig } from '../lib/types.js'

/**
 * Regression: `tools/post-execute` is a cordis waterfall in the harness, and
 * the harness dereferences whatever comes back:
 *
 *   const decision = await ctx.waterfall(carrier, 'tools/post-execute',
 *     exec, result, () => Promise.resolve({ kind: 'accept' }))
 *   const decisionContexts = decision.additionalContexts ?? []
 *
 * A listener that scans and then `return`s hands the harness `undefined` and
 * takes down every tool call — the exact failure reported in issue #1. The
 * scan is a side effect; the decision always belongs to the chain.
 */

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as never
const ALL_ON = {
  email: true, phone_cn: true, phone_intl: true, cn_id: true,
  credit_card: true, api_key: true, ssn: true, ipv4: false, iban: false,
}

function makeContext(config: PiiConfig): Context {
  const ctx = new Context()
  ctx.provide('logger', silentLogger)
  const detector = new PiiDetector(compileDetectors({ detectors: config.detectors ?? ALL_ON, ...config }))
  const audit = new AuditLogger({ enabled: false })
  attachPiiGate(ctx as never, { config, detector, audit, logger: silentLogger })
  return ctx
}

function postExec(ctx: Context, exec: unknown, result: unknown): Record<string, unknown> {
  return ctx.waterfall('tools/post-execute', exec, result, () => ({ kind: 'accept' })) as Record<string, unknown>
}

test('post-execute returns the harness default when the output is clean', () => {
  const ctx = makeContext({ enabled: true, mode: 'audit', scanResults: true })

  const decision = postExec(
    ctx,
    { name: 'read', arguments: { path: 'a.ts' } },
    { content: [{ type: 'text', text: 'nothing personal here' }], isError: false },
  )

  assert.ok(decision, 'returning undefined here crashes every tool call')
  assert.equal(decision.kind, 'accept')
  assert.doesNotThrow(() => (decision as { additionalContexts?: unknown }).additionalContexts ?? [])
})

test('post-execute still returns a decision after finding PII in the output', () => {
  const ctx = makeContext({ enabled: true, mode: 'audit', scanResults: true })

  const decision = postExec(
    ctx,
    { name: 'read', arguments: { path: 'contacts.csv' } },
    { content: [{ type: 'text', text: 'reach me at bob@example.com' }], isError: false },
  )

  assert.equal(decision.kind, 'accept')
})

test('post-execute returns a decision when scanning is switched off', () => {
  const ctx = makeContext({ enabled: true, mode: 'audit', scanResults: false })

  const decision = postExec(ctx, { name: 'read', arguments: {} }, { content: [], isError: false })

  assert.equal(decision.kind, 'accept')
})

test('post-execute returns a decision for a payload it cannot parse', () => {
  const ctx = makeContext({ enabled: true, mode: 'audit', scanResults: true })

  const decision = postExec(ctx, 'garbage', undefined)

  assert.equal(decision?.kind, 'accept')
})
