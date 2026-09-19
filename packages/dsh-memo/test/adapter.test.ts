import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachMemo, compileGlob } from '../lib/adapter.js'
import { MemoStore } from '../lib/store.js'
import { AuditLogger } from '../lib/audit.js'
import type { MemoConfig } from '../lib/types.js'

interface RecordedListener {
  event: string
  fn: (payload: unknown) => unknown
}

function mockCtx() {
  const events: RecordedListener[] = []
  return { events, on(event: string, fn: (payload: unknown) => unknown) { events.push({ event, fn }) } }
}

function fakeLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} } as never
}

function setup(cfg: MemoConfig, dir: string) {
  const auditFile = join(dir, 'audit.jsonl')
  const ctx = mockCtx()
  const store = new MemoStore(cfg, compileGlob)
  const audit = new AuditLogger({ enabled: cfg.audit?.enabled !== false, file: auditFile }, dir)
  attachMemo(ctx, { config: cfg, store, audit, logger: fakeLogger() })
  return { listeners: ctx.events, auditFile, store }
}

const pre = (ls: RecordedListener[]) => ls.find((l) => l.event === 'tools/pre-execute')!.fn
const post = (ls: RecordedListener[]) => ls.find((l) => l.event === 'tools/post-execute')!.fn

test('store then hit: hint mode denies with cached preview and fresh-flag guidance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-'))
  const cfg: MemoConfig = { enabled: true, mode: 'hint', excludeTools: [] }
  const { listeners } = setup(cfg, dir)
  post(listeners)({ tool: 'read_file', args: { path: '/a' }, result: 'file body' })
  const v = pre(listeners)({ tool: 'read_file', args: { path: '/a' } }) as { decision: string; reason: string }
  assert.equal(v.decision, 'deny')
  assert.match(v.reason, /cache HIT/)
  assert.match(v.reason, /file body/)
  assert.match(v.reason, /_memoFresh/)
})

test('miss returns undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-'))
  const cfg: MemoConfig = { enabled: true, excludeTools: [] }
  const { listeners } = setup(cfg, dir)
  assert.equal(pre(listeners)({ tool: 'read_file', args: { path: '/never' } }), undefined)
})

test('fresh flag bypasses lookup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-'))
  const cfg: MemoConfig = { enabled: true, excludeTools: [] }
  const { listeners } = setup(cfg, dir)
  post(listeners)({ tool: 'read_file', args: { path: '/a' }, result: 'body' })
  assert.equal(pre(listeners)({ tool: 'read_file', args: { path: '/a', _memoFresh: true } }), undefined)
})

test('excluded (mutating) tools never cache nor serve', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-'))
  const cfg: MemoConfig = { enabled: true }
  const { listeners, store } = setup(cfg, dir)
  post(listeners)({ tool: 'bash', args: { command: 'ls' }, result: 'out' })
  assert.equal(store.size, 0)
  assert.equal(pre(listeners)({ tool: 'bash', args: { command: 'ls' } }), undefined)
})

test('includeTools allowlist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-'))
  const cfg: MemoConfig = { enabled: true, includeTools: ['read*'], excludeTools: [] }
  const { listeners, store } = setup(cfg, dir)
  post(listeners)({ tool: 'glob', args: { p: 'x' }, result: [] })
  post(listeners)({ tool: 'read_file', args: { p: 'y' }, result: 'ok' })
  assert.equal(store.size, 1)
})

test('error results are not cached', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-'))
  const cfg: MemoConfig = { enabled: true, excludeTools: [] }
  const { listeners, store } = setup(cfg, dir)
  post(listeners)({ tool: 'read_file', args: { path: '/nope' }, result: null, error: 'ENOENT' })
  assert.equal(store.size, 0)
})

test('inject mode carries the cached result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-'))
  const cfg: MemoConfig = { enabled: true, mode: 'inject', excludeTools: [] }
  const { listeners } = setup(cfg, dir)
  post(listeners)({ tool: 'read_file', args: { path: '/a' }, result: { body: 'x' } })
  const v = pre(listeners)({ tool: 'read_file', args: { path: '/a' } }) as { decision: string; result: unknown; memoized: boolean }
  assert.equal(v.decision, 'allow')
  assert.equal(v.memoized, true)
  assert.deepEqual(v.result, { body: 'x' })
})

test('default exclude list keeps http out of the cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-'))
  const cfg: MemoConfig = { enabled: true }
  const { listeners, store } = setup(cfg, dir)
  post(listeners)({ tool: 'http_get', args: { url: 'https://x' }, result: 'page' })
  assert.equal(store.size, 0)
})

test('audit trail records hit and store events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-'))
  const cfg: MemoConfig = { enabled: true, excludeTools: [] }
  const { listeners, auditFile } = setup(cfg, dir)
  post(listeners)({ tool: 'read_file', args: { path: '/a' }, result: 'b' })
  pre(listeners)({ tool: 'read_file', args: { path: '/a' } })
  const lines = readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.some((l) => l.event === 'store'))
  assert.ok(lines.some((l) => l.event === 'hit'))
})

test('unrecognized payloads never throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memo-'))
  const cfg: MemoConfig = { enabled: true }
  const { listeners } = setup(cfg, dir)
  assert.equal(pre(listeners)('garbage'), undefined)
  assert.equal(post(listeners)({}), undefined)
})

test('compileGlob semantics match pii package', () => {
  assert.ok(compileGlob('write*').test('write_file'))
  assert.ok(!compileGlob('write*').test('write/deep'))
})
