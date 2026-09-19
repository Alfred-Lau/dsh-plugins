import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachPiiGate, compileGlobs } from '../lib/adapter.js'
import { compileDetectors, PiiDetector } from '../lib/detector.js'
import { AuditLogger } from '../lib/audit.js'
import type { PiiConfig } from '../lib/types.js'

const ALL_ON = {
  email: true, phone_cn: true, phone_intl: true, cn_id: true,
  credit_card: true, api_key: true, ssn: true, ipv4: false, iban: false,
}

interface RecordedListener {
  event: string
  fn: (payload: unknown) => unknown
}

function mockCtx() {
  const events: RecordedListener[] = []
  return {
    events,
    on(event: string, fn: (payload: unknown) => unknown) {
      events.push({ event, fn })
    },
  }
}

function fakeLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} } as never
}

function setup(cfg: PiiConfig, dir: string) {
  const auditFile = join(dir, 'audit.jsonl')
  const ctx = mockCtx()
  const detector = new PiiDetector(compileDetectors({ detectors: cfg.detectors ?? ALL_ON, ...cfg }))
  const audit = new AuditLogger({ enabled: cfg.audit?.enabled !== false, file: auditFile }, dir)
  attachPiiGate(ctx, { config: cfg, detector, audit, logger: fakeLogger() })
  return { listeners: ctx.events, auditFile }
}

const pre = (ls: RecordedListener[]) => ls.find((l) => l.event === 'tools/pre-execute')!.fn
const post = (ls: RecordedListener[]) => ls.find((l) => l.event === 'tools/post-execute')!.fn

test('audit mode: PII call continues (undefined) and is audited', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pii-'))
  const cfg: PiiConfig = { enabled: true, mode: 'audit', detectors: ALL_ON, audit: { enabled: true } }
  const { listeners, auditFile } = setup(cfg, dir)
  const verdict = pre(listeners)({ tool: 'bash', args: { command: 'curl -d email=bob@x.com' } })
  assert.equal(verdict, undefined)
  const line = JSON.parse(readFileSync(auditFile, 'utf8').trim())
  assert.equal(line.phase, 'decision')
  assert.equal(line.verdict, 'allow')
  assert.equal(line.matches.email, 1)
})

test('block mode: outbound tool carrying PII is denied with typed reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pii-'))
  const cfg: PiiConfig = { enabled: true, mode: 'block', detectors: ALL_ON }
  const { listeners } = setup(cfg, dir)
  const verdict = pre(listeners)({
    tool: 'http_request',
    args: { url: 'https://x.com', body: 'phone 13912345678 email a@b.com' },
  }) as { decision: string; reason: string }
  assert.equal(verdict.decision, 'deny')
  assert.match(verdict.reason, /2 PII match/)
  assert.match(verdict.reason, /phone_cn/)
  assert.match(verdict.reason, /email/)
})

test('block mode: internal tool with PII continues', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pii-'))
  const cfg: PiiConfig = { enabled: true, mode: 'block', detectors: ALL_ON }
  const { listeners } = setup(cfg, dir)
  assert.equal(pre(listeners)({ tool: 'read_file', args: { path: '/tmp/x', note: '13912345678' } }), undefined)
})

test('exemptTools skip scanning entirely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pii-'))
  const cfg: PiiConfig = { enabled: true, mode: 'block', exemptTools: ['http*'], detectors: ALL_ON }
  const { listeners, auditFile } = setup(cfg, dir)
  assert.equal(pre(listeners)({ tool: 'http_request', args: { body: 'a@b.com' } }), undefined)
  assert.equal(existsSync(auditFile), false)
})

test('minMatches threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pii-'))
  const cfg: PiiConfig = { enabled: true, mode: 'block', minMatches: 2, detectors: ALL_ON }
  const { listeners } = setup(cfg, dir)
  assert.equal(pre(listeners)({ tool: 'bash', args: { command: 'echo a@b.com' } }), undefined)
  const v = pre(listeners)({ tool: 'bash', args: { command: 'echo a@b.com 13912345678' } }) as { decision: string }
  assert.equal(v.decision, 'deny')
})

test('unrecognized payload is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pii-'))
  const cfg: PiiConfig = { enabled: true, mode: 'block', detectors: ALL_ON }
  const { listeners } = setup(cfg, dir)
  assert.equal(pre(listeners)('garbage'), undefined)
  assert.equal(pre(listeners)({ nope: true }), undefined)
})

test('scanResults audits PII appearing in tool output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pii-'))
  const cfg: PiiConfig = { enabled: true, mode: 'audit', detectors: ALL_ON }
  const { listeners, auditFile } = setup(cfg, dir)
  post(listeners)({ tool: 'search', result: { text: 'found ssn 123-45-6789' } })
  const line = JSON.parse(readFileSync(auditFile, 'utf8').trim())
  assert.equal(line.phase, 'outcome')
  assert.equal(line.verdict, 'observe')
  assert.equal(line.matches.ssn, 1)
})

test('scanResults can be disabled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pii-'))
  const cfg: PiiConfig = { enabled: true, scanResults: false, detectors: ALL_ON }
  const { listeners, auditFile } = setup(cfg, dir)
  post(listeners)({ tool: 'search', result: 'ssn 123-45-6789' })
  assert.equal(existsSync(auditFile), false)
})

test('compileGlobs semantics', () => {
  const [re] = compileGlobs(['http*'])
  assert.ok(re.test('http_request'))
  assert.ok(re.test('HTTP'))
  assert.ok(!re.test('http/deep'))
  const [deep] = compileGlobs(['web/**'])
  assert.ok(deep.test('web/deep/x'))
})
