import test from 'node:test'
import assert from 'node:assert/strict'
import { attachMemo } from '../lib/adapter.js'
import { MemoStore } from '../lib/store.js'
import { AuditLogger } from '../lib/audit.js'
import type { MemoConfig } from '../lib/types.js'

/**
 * Regression: schemastery fills an absent `excludeTools` with `[]`, so
 * `config.excludeTools ?? DEFAULT_EXCLUDE_TOOLS` resolved to the empty array —
 * "not configured" silently became "nothing excluded". That made `bash`
 * cacheable, and a stale test result could be replayed to a later call.
 * Empty must mean "use the defaults".
 */

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

interface Listener {
  fn: (payload: unknown, next?: () => unknown) => unknown
}

function setup(config: Partial<MemoConfig>): { fire: (payload: unknown) => unknown; emitResult: (payload: unknown) => void } {
  const pre: Listener[] = []
  const post: Listener[] = []
  const ctx = {
    on(event: string, fn: Listener) {
      if (event === 'tools/pre-execute') pre.push({ fn })
      else post.push({ fn })
    },
    get() {
      return undefined
    },
  }
  const full = { enabled: true, mode: 'hint', defaultTtlMs: 600_000, ...config } as MemoConfig
  const store = new MemoStore(full, (g) => new RegExp(`^${g.replace(/\*/g, '.*')}$`))
  const audit = new AuditLogger({ enabled: false })
  attachMemo(ctx as never, { config: full, store, audit, logger: silentLogger as never })
  return {
    fire: (payload) => pre[0]!.fn(payload, () => undefined),
    emitResult: (payload) => post.forEach((l) => l.fn(payload)),
  }
}

test('without excludeTools configured, bash is still excluded by the defaults', () => {
  const { fire, emitResult } = setup({})
  const call = { tool: 'bash', args: { command: 'npm test' }, sessionId: 'worker-t-1' }
  assert.equal(fire(call), undefined, 'first call runs')
  emitResult({ ...call, output: 'all green' })
  assert.equal(fire(call), undefined, 'the result must not be replayed from cache')
})

test('without excludeTools configured, read is still cacheable', () => {
  const { fire, emitResult } = setup({})
  const call = { tool: 'read', args: { path: 'a.ts' }, sessionId: 'worker-t-1' }
  assert.equal(fire(call), undefined)
  emitResult({ ...call, output: 'contents' })
  const verdict = fire(call) as { ruleId?: string } | undefined
  assert.equal(verdict?.ruleId, 'memo-hint')
})

test('an explicit excludeTools list replaces the defaults', () => {
  const { fire, emitResult } = setup({ excludeTools: ['read*'] })
  const bash = { tool: 'bash', args: { command: 'npm test' }, sessionId: 'worker-t-1' }
  fire(bash)
  emitResult({ ...bash, output: 'ok' })
  assert.equal((fire(bash) as { ruleId?: string } | undefined)?.ruleId, 'memo-hint', 'bash is no longer excluded')

  const read = { tool: 'read', args: { path: 'a.ts' }, sessionId: 'worker-t-1' }
  fire(read)
  emitResult({ ...read, output: 'contents' })
  assert.equal(fire(read), undefined, 'read is now excluded')
})
