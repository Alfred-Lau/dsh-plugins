import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachMemo, compileGlob } from '../lib/adapter.js'
import { MemoStore, cacheKey } from '../lib/store.js'
import { AuditLogger } from '../lib/audit.js'
import { bucketFor, makeTicketScope, resolveTicketScope } from '../lib/ticket-scope.js'
import type { MemoConfig } from '../lib/types.js'

const logger = { info() {}, warn() {}, error() {}, debug() {} } as never

interface Listener {
  event: string
  fn: (payload: unknown) => unknown
}

function mockCtx(service?: Record<string, unknown>) {
  const events: Listener[] = []
  return {
    events,
    on(event: string, fn: (payload: unknown) => unknown) {
      events.push({ event, fn })
    },
    get(name: string) {
      return name === 'ticket' ? service : undefined
    },
  }
}

function setup(config: MemoConfig, service?: Record<string, unknown>) {
  const ctx = mockCtx(service)
  const store = new MemoStore(config, compileGlob)
  const dir = mkdtempSync(join(tmpdir(), 'memo-'))
  const audit = new AuditLogger({ enabled: false, file: join(dir, 'a.jsonl') }, dir)
  const ticketScope = makeTicketScope(ctx as never, config.ticket)
  attachMemo(ctx, { config, store, audit, logger, ...(ticketScope ? { ticketScope } : {}) })
  return {
    store,
    pre: ctx.events.find((e) => e.event === 'tools/pre-execute')!.fn,
    post: ctx.events.find((e) => e.event === 'tools/post-execute')!.fn,
  }
}

// --- scope helpers -------------------------------------------------------

test('resolveTicketScope reads worker-<ticketId> and the router', () => {
  assert.deepEqual(resolveTicketScope('worker-t-1'), { role: 'worker', sessionId: 'worker-t-1', ticketId: 't-1' })
  assert.deepEqual(resolveTicketScope('master', { masterId: 'master' }), { role: 'router', sessionId: 'master' })
  assert.equal(resolveTicketScope('plain'), undefined)
  assert.equal(resolveTicketScope('worker-'), undefined)
})

test('bucketFor isolates tickets, sessions, or nothing', () => {
  assert.equal(bucketFor('worker-a', {}), 'ticket:a')
  assert.equal(bucketFor('worker-a', { isolation: 'session' }), 'session:worker-a')
  assert.equal(bucketFor('worker-a', { isolation: 'none' }), '')
  assert.equal(bucketFor('worker-a', { enabled: false }), '')
  assert.equal(bucketFor('plain', {}), '')
  assert.equal(bucketFor('master', { masterId: 'master' }), 'ticket:router')
})

test('cacheKey differs across buckets and is stable inside one', () => {
  assert.equal(cacheKey('read', { path: 'a' }, 'ticket:a'), cacheKey('read', { path: 'a' }, 'ticket:a'))
  assert.notEqual(cacheKey('read', { path: 'a' }, 'ticket:a'), cacheKey('read', { path: 'a' }, 'ticket:b'))
  assert.notEqual(cacheKey('read', { path: 'a' }, 'ticket:a'), cacheKey('read', { path: 'a' }))
})

test('makeTicketScope prefers the shared service', () => {
  const handle = makeTicketScope(
    { get: () => ({ scopeOf: () => ({ role: 'worker', sessionId: 'worker-z', ticketId: 'z' }) }) } as never,
    {},
  )
  assert.equal(handle?.source, 'service')
  assert.equal(handle?.bucketOf('whatever'), 'ticket:z')
})

// --- isolation through the adapter ---------------------------------------

test('a cached result is never served to a different ticket', () => {
  const { pre, post } = setup({ enabled: true, mode: 'hint' })
  const args = { path: 'config/secrets.env' }

  post({ tool: 'read', args, output: 'API_KEY=sk-live', sessionId: 'worker-t-a' })
  // Same tool, same args, different ticket: must miss.
  assert.equal(pre({ tool: 'read', args, sessionId: 'worker-t-b' }), undefined)
  // The ticket that stored it hits.
  const hit = pre({ tool: 'read', args, sessionId: 'worker-t-a' }) as { decision: string; memoized?: boolean } | undefined
  assert.equal(hit?.decision, 'deny')
  assert.equal(hit?.memoized, true)
})

test('isolation: none restores the shared cache', () => {
  const { pre, post } = setup({ enabled: true, mode: 'hint', ticket: { isolation: 'none' } })
  const args = { path: 'README.md' }
  post({ tool: 'read', args, output: '# hi', sessionId: 'worker-t-a' })
  const hit = pre({ tool: 'read', args, sessionId: 'worker-t-b' }) as { decision: string } | undefined
  assert.equal(hit?.decision, 'deny')
})

test('isolation: session also separates the router from its workers', () => {
  const { pre, post } = setup({ enabled: true, mode: 'hint', ticket: { isolation: 'session', masterId: 'master' } })
  const args = { path: 'plan.md' }
  post({ tool: 'read', args, output: 'plan', sessionId: 'worker-t-a' })
  assert.equal(pre({ tool: 'read', args, sessionId: 'master' }), undefined)
  const hit = pre({ tool: 'read', args, sessionId: 'worker-t-a' }) as { decision: string } | undefined
  assert.equal(hit?.decision, 'deny')
})

test('a plain session keeps the shared cache', () => {
  const { pre, post } = setup({ enabled: true, mode: 'hint' })
  const args = { path: 'a.txt' }
  post({ tool: 'read', args, output: 'A', sessionId: 'plain-1' })
  const hit = pre({ tool: 'read', args, sessionId: 'plain-2' }) as { decision: string } | undefined
  assert.equal(hit?.decision, 'deny')
})

test('the shared service decides the bucket when it is loaded', () => {
  const { pre, post } = setup(
    { enabled: true, mode: 'hint' },
    { scopeOf: (sid: unknown) => (sid === 'anything-a' ? { role: 'worker', sessionId: 'anything-a', ticketId: 'shared' } : undefined) },
  )
  const args = { path: 'x.txt' }
  post({ tool: 'read', args, output: 'X', sessionId: 'anything-a' })
  // A different Session id that the service maps to the same ticket hits.
  const hit = pre({ tool: 'read', args, sessionId: 'anything-b' }) as { decision: string } | undefined
  assert.equal(hit, undefined)
})

test('disabling ticket isolation keeps the old single-bucket behaviour', () => {
  const { pre, post } = setup({ enabled: true, mode: 'hint', ticket: { enabled: false } })
  const args = { path: 'y.txt' }
  post({ tool: 'read', args, output: 'Y', sessionId: 'worker-t-a' })
  const hit = pre({ tool: 'read', args, sessionId: 'worker-t-b' }) as { decision: string } | undefined
  assert.equal(hit?.decision, 'deny')
})

test('capacity is one global LRU bound shared by all buckets', () => {
  // Bucketing isolates *keys*, not memory: maxEntries still caps the whole
  // store, so a busy ticket can evict another ticket's entries. That is the
  // intended trade — one memory ceiling for the process.
  const store = new MemoStore({ maxEntries: 2, defaultTtlMs: 60_000 }, compileGlob)
  const now = 1_000_000
  store.store('read', { p: 1 }, 'a', now, 'ticket:a')
  store.store('read', { p: 2 }, 'b', now, 'ticket:b')
  store.store('read', { p: 3 }, 'c', now, 'ticket:a')
  assert.equal(store.size, 2)
  assert.equal(store.lookup('read', { p: 1 }, now, 'ticket:a').entry, undefined)
  assert.equal(store.lookup('read', { p: 3 }, now, 'ticket:a').entry?.value, 'c')
  assert.equal(store.lookup('read', { p: 2 }, now, 'ticket:b').entry?.value, 'b')
})
