import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { attachMemo, compileGlob } from '../lib/adapter.js'
import { MemoStore } from '../lib/store.js'
import { AuditLogger } from '../lib/audit.js'
import type { MemoConfig } from '../lib/types.js'

/**
 * Regression: `tools/post-execute` is a cordis waterfall in the harness, and
 * the harness dereferences whatever comes back:
 *
 *   const decision = await ctx.waterfall(carrier, 'tools/post-execute',
 *     exec, result, () => Promise.resolve({ kind: 'accept' }))
 *   const decisionContexts = decision.additionalContexts ?? []
 *
 * Filling the cache is a side effect; the decision always belongs to the chain.
 * A listener that stores and then `return`s hands the harness `undefined` and
 * breaks every tool call.
 */

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as never

function makeContext(config: MemoConfig): { ctx: Context; store: MemoStore } {
  const ctx = new Context()
  ctx.provide('logger', silentLogger)
  const store = new MemoStore(config, compileGlob)
  const audit = new AuditLogger({ enabled: false })
  attachMemo(ctx as never, { config, store, audit, logger: silentLogger })
  return { ctx, store }
}

function postExec(ctx: Context, exec: unknown, result: unknown): Record<string, unknown> {
  return ctx.waterfall('tools/post-execute', exec, result, () => ({ kind: 'accept' })) as Record<string, unknown>
}

test('post-execute returns the harness default and still fills the cache', () => {
  const { ctx, store } = makeContext({ enabled: true, mode: 'hint' })

  const decision = postExec(
    ctx,
    { name: 'read', arguments: { path: 'src/a.ts' }, sessionId: 's1' },
    { content: [{ type: 'text', text: 'export const a = 1' }], isError: false },
  )

  assert.ok(decision, 'returning undefined here crashes every tool call')
  assert.equal(decision.kind, 'accept')
  assert.doesNotThrow(() => (decision as { additionalContexts?: unknown }).additionalContexts ?? [])

  // The side effect that makes the plugin worth having must still happen.
  const { entry } = store.lookup('read', { path: 'src/a.ts' }, Date.now(), '')
  assert.ok(entry, 'the result should have been stored')
})

test('post-execute returns a decision for an excluded tool', () => {
  const { ctx } = makeContext({ enabled: true, mode: 'hint', excludeTools: ['bash'] })

  const decision = postExec(
    ctx,
    { name: 'bash', arguments: { command: 'ls' }, sessionId: 's1' },
    { content: [], isError: false },
  )

  assert.equal(decision.kind, 'accept')
})

test('post-execute returns a decision when the tool errored', () => {
  const { ctx, store } = makeContext({ enabled: true, mode: 'hint' })

  const decision = postExec(
    ctx,
    { name: 'read', arguments: { path: 'missing.ts' }, sessionId: 's1' },
    { content: [], isError: true, error: { message: 'ENOENT' } },
  )

  assert.equal(decision.kind, 'accept')
  const { entry } = store.lookup('read', { path: 'missing.ts' }, Date.now(), '')
  assert.equal(entry, undefined, 'a failed call must not be cached')
})

test('post-execute returns a decision for a payload it cannot parse', () => {
  const { ctx } = makeContext({ enabled: true, mode: 'hint' })

  const decision = postExec(ctx, 'garbage', undefined)

  assert.equal(decision?.kind, 'accept')
})
