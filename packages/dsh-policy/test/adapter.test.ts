import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachPolicy } from '../lib/adapter.js'
import { PolicyEvaluator } from '../lib/evaluator.js'
import { AuditLogger } from '../lib/audit.js'
import type { PolicyConfig } from '../lib/types.js'

interface RecordedListener {
  event: string
  fn: (payload: unknown) => unknown
}

function mockCtx(): { events: RecordedListener[]; on: (event: string, fn: (payload: unknown) => unknown) => void } {
  const events: RecordedListener[] = []
  return {
    events,
    on(event, fn) {
      events.push({ event, fn })
    },
  }
}

const cfg: PolicyConfig = {
  enabled: true,
  rules: [
    { id: 'deny-force-push', effect: 'deny', tools: ['bash'], commands: ['git\\s+push\\s+--force'] },
    { id: 'allow-tests', effect: 'allow', priority: 10, tools: ['bash'], commands: ['^pnpm\\b'] },
  ],
  defaultDecision: 'ask',
  failClosed: true,
  audit: { enabled: true },
}

function setup(dir: string): { listeners: RecordedListener[]; auditFile: string } {
  const auditFile = join(dir, 'audit.jsonl')
  const ctx = mockCtx()
  const evaluator = new PolicyEvaluator(cfg)
  const audit = new AuditLogger({ enabled: true, file: auditFile }, dir)
  attachPolicy(ctx, evaluator, audit, fakeLogger())
  return { listeners: ctx.events, auditFile }
}

function fakeLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }
}

test('registers pre/post-execute listeners', () => {
  const { listeners } = setup(mkdtempSync(join(tmpdir(), 'dsh-adapter-')))
  assert.deepEqual(listeners.map((l) => l.event).sort(), ['tools/post-execute', 'tools/pre-execute'])
})

test('pre-execute: deny returns deny verdict', () => {
  const { listeners } = setup(mkdtempSync(join(tmpdir(), 'dsh-adapter-')))
  const pre = listeners.find((l) => l.event === 'tools/pre-execute')!
  const verdict = pre.fn({ tool: 'bash', args: { command: 'git push --force origin main' }, sessionId: 's1' })
  assert.equal((verdict as { decision: string }).decision, 'deny')
  assert.equal((verdict as { ruleId?: string }).ruleId, 'deny-force-push')
})

test('pre-execute: allow short-circuits allowed dev commands', () => {
  const { listeners } = setup(mkdtempSync(join(tmpdir(), 'dsh-adapter-')))
  const pre = listeners.find((l) => l.event === 'tools/pre-execute')!
  const verdict = pre.fn({ tool: 'bash', args: { command: 'pnpm test' } }) as { decision: string }
  assert.equal(verdict.decision, 'allow')
})

test('pre-execute: unmatched call falls back to default ask', () => {
  const { listeners } = setup(mkdtempSync(join(tmpdir(), 'dsh-adapter-')))
  const pre = listeners.find((l) => l.event === 'tools/pre-execute')!
  const verdict = pre.fn({ tool: 'web_search', args: { query: 'weather' } }) as { decision: string }
  assert.equal(verdict.decision, 'ask')
})

test('pre-execute: unrecognized payload is passed through untouched', () => {
  const { listeners } = setup(mkdtempSync(join(tmpdir(), 'dsh-adapter-')))
  const pre = listeners.find((l) => l.event === 'tools/pre-execute')!
  assert.equal(pre.fn('garbage'), undefined)
  assert.equal(pre.fn({ unrelated: true }), undefined)
  assert.equal(pre.fn(null), undefined)
})

test('decisions and outcomes land in the audit trail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-adapter-'))
  const { listeners, auditFile } = setup(dir)
  const pre = listeners.find((l) => l.event === 'tools/pre-execute')!
  const post = listeners.find((l) => l.event === 'tools/post-execute')!
  pre.fn({ tool: 'bash', args: { command: 'git push --force' }, sessionId: 's9' })
  pre.fn({ tool: 'bash', args: { command: 'pnpm build' }, sessionId: 's9' })
  post.fn({ tool: 'bash', status: 'ok', sessionId: 's9' })

  const lines = readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const decisions = lines.filter((e) => e.phase === 'decision')
  assert.equal(decisions.length, 2)
  assert.equal(decisions[0]!.decision, 'deny')
  assert.equal(decisions[1]!.decision, 'allow')
  assert.equal(decisions[0]!.session_id, 's9')
  const outcomes = lines.filter((e) => e.phase === 'outcome')
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0]!.outcome, 'ok')
})
