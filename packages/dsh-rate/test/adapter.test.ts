import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachRateShield } from '../lib/adapter.js'
import { BackoffTracker } from '../lib/backoff.js'
import { UsageMeter } from '../lib/meter.js'
import { AuditLogger } from '../lib/audit.js'
import type { RateConfig } from '../lib/types.js'

interface RecordedListener {
  event: string
  fn: (payload: unknown) => unknown
}

function mockCtx() {
  const events: RecordedListener[] = []
  return { events, on(event: string, fn: (payload: unknown) => unknown) { events.push({ event, fn }) } }
}

function fakeLogger() {
  const warnings: string[] = []
  return {
    warnings,
    info() {}, warn(msg: string) { warnings.push(msg) }, error() {}, debug() {},
  } as never
}

function setup(cfg: RateConfig, dir: string) {
  const auditFile = join(dir, 'audit.jsonl')
  const ctx = mockCtx()
  const logger = fakeLogger()
  const meter = new UsageMeter()
  const backoff = new BackoffTracker(cfg.backoff)
  const audit = new AuditLogger({ enabled: cfg.audit?.enabled !== false, file: auditFile }, dir)
  attachRateShield(ctx, { config: cfg, meter, backoff, audit, logger })
  return { listeners: ctx.events, auditFile, logger, meter, backoff }
}

const pre = (ls: RecordedListener[]) => ls.find((l) => l.event === 'tools/pre-execute')!.fn
const evt = (ls: RecordedListener[]) => ls.find((l) => l.event === 'session/event')!.fn

const llm429 = { type: 'llm/end', error: 'HTTP 429 Too Many Requests' }
const llmOk = { type: 'llm/end', usage: { input_tokens: 100, output_tokens: 50 } }

test('monitor mode: backoff window open but calls continue (audited)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rate-'))
  const cfg: RateConfig = { enabled: true, mode: 'monitor' }
  const { listeners } = setup(cfg, dir)
  evt(listeners)(llm429)
  assert.equal(pre(listeners)({ tool: 'bash', args: {} }), undefined)
})

test('enforce mode: call inside backoff window is denied', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rate-'))
  const cfg: RateConfig = { enabled: true, mode: 'enforce' }
  const { listeners } = setup(cfg, dir)
  evt(listeners)(llm429)
  const v = pre(listeners)({ tool: 'bash', args: {} }) as { decision: string; ruleId: string; reason: string }
  assert.equal(v.decision, 'deny')
  assert.equal(v.ruleId, 'rate-backoff')
  assert.match(v.reason, /backoff window open/)
})

test('enforce mode: backoff resets after a successful completion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rate-'))
  const cfg: RateConfig = { enabled: true, mode: 'enforce' }
  const { listeners } = setup(cfg, dir)
  evt(listeners)(llm429)
  evt(listeners)(llmOk)
  assert.equal(pre(listeners)({ tool: 'bash', args: {} }), undefined)
})

test('budget: warns at warnAt and denies at 100% with block-tools', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rate-'))
  const cfg: RateConfig = {
    enabled: true,
    mode: 'enforce',
    budget: { dailyTokens: 200, warnAt: 0.8, criticalAction: 'block-tools' },
  }
  const { listeners, logger } = setup(cfg, dir)
  evt(listeners)(llmOk) // 150 tokens => 75%, below warnAt
  assert.equal(pre(listeners)({ tool: 'bash', args: {} }), undefined)
  evt(listeners)({ type: 'assistant/message', usage: { input_tokens: 60, output_tokens: 0 } }) // total 210 >= 200
  const v = pre(listeners)({ tool: 'bash', args: {} }) as { decision: string; ruleId: string }
  assert.equal(v.decision, 'deny')
  assert.equal(v.ruleId, 'rate-budget')
  assert.ok(logger.warnings.some((w: string) => /token budget at \d+%/.test(w)))
})

test('budget criticalAction log never denies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rate-'))
  const cfg: RateConfig = { enabled: true, mode: 'enforce', budget: { dailyTokens: 100, criticalAction: 'log' } }
  const { listeners } = setup(cfg, dir)
  evt(listeners)(llmOk)
  assert.equal(pre(listeners)({ tool: 'bash', args: {} }), undefined)
})

test('tool storm: over-limit calls denied in enforce', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rate-'))
  const cfg: RateConfig = { enabled: true, mode: 'enforce', toolStorm: { windowMs: 60_000, maxCalls: 2 } }
  const { listeners } = setup(cfg, dir)
  assert.equal(pre(listeners)({ tool: 'read', args: { i: 1 } }), undefined)
  assert.equal(pre(listeners)({ tool: 'read', args: { i: 2 } }), undefined)
  const v = pre(listeners)({ tool: 'read', args: { i: 3 } }) as { decision: string; ruleId: string }
  assert.equal(v.decision, 'deny')
  assert.equal(v.ruleId, 'rate-storm')
})

test('non-llm events are ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rate-'))
  const cfg: RateConfig = { enabled: true, mode: 'enforce' }
  const { listeners, backoff } = setup(cfg, dir)
  evt(listeners)({ type: 'tool/start', error: '429-ish text in a tool event' })
  assert.equal(backoff.streak, 0)
  assert.equal(pre(listeners)({ tool: 'bash', args: {} }), undefined)
})

test('unrecognized payloads never throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rate-'))
  const cfg: RateConfig = { enabled: true, mode: 'enforce' }
  const { listeners } = setup(cfg, dir)
  assert.equal(pre(listeners)('garbage'), undefined)
  assert.equal(evt(listeners)(42), undefined)
  assert.equal(evt(listeners)({ nope: 1 }), undefined)
})

test('audit trail records 429 and usage events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rate-'))
  const cfg: RateConfig = { enabled: true }
  const { listeners, auditFile } = setup(cfg, dir)
  evt(listeners)(llm429)
  evt(listeners)(llmOk)
  const lines = readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.some((l) => l.event === 'llm_429'))
  assert.ok(lines.some((l) => l.event === 'llm_usage' && l.tokens === 150))
})
