import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoStore, cacheKey, preview } from '../lib/store.js'
import { compileGlob } from '../lib/adapter.js'

test('same tool+args => same key; different args => different key', () => {
  const a = cacheKey('read_file', { path: '/tmp/x' })
  const b = cacheKey('read_file', { path: '/tmp/x' })
  const c = cacheKey('read_file', { path: '/tmp/y' })
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('key is stable across key order', () => {
  assert.equal(cacheKey('t', { a: 1, b: 2 }), cacheKey('t', { b: 2, a: 1 }))
})

test('TTL expiry', () => {
  const s = new MemoStore({ defaultTtlMs: 1000 }, compileGlob)
  s.store('t', { x: 1 }, 'val', 1000)
  assert.ok(s.lookup('t', { x: 1 }, 1500).entry)
  assert.equal(s.lookup('t', { x: 1 }, 2500).entry, undefined)
})

test('per-tool TTL wins over default', () => {
  const s = new MemoStore({ defaultTtlMs: 1000, perToolTtl: [{ tool: 'search*', ttlMs: 5000 }] }, compileGlob)
  assert.equal(s.ttlFor('search_web'), 5000)
  assert.equal(s.ttlFor('read'), 1000)
})

test('ttl 0 disables storing for that tool', () => {
  const s = new MemoStore({ perToolTtl: [{ tool: 'bash', ttlMs: 0 }] }, compileGlob)
  assert.equal(s.store('bash', {}, 'x', 1000), undefined)
})

test('LRU eviction beyond capacity', () => {
  const s = new MemoStore({ maxEntries: 2, defaultTtlMs: 10_000 }, compileGlob)
  s.store('t', { i: 1 }, 'a', 1000)
  s.store('t', { i: 2 }, 'b', 2000)
  assert.ok(s.lookup('t', { i: 1 }, 2500).entry) // refresh 1
  s.store('t', { i: 3 }, 'c', 3000) // evicts 2
  assert.equal(s.lookup('t', { i: 2 }, 3500).entry, undefined)
  assert.ok(s.lookup('t', { i: 1 }, 3500).entry !== undefined)
  assert.ok(s.lookup('t', { i: 3 }, 3500).entry !== undefined)
  assert.equal(s.evictionCount, 1)
})

test('hit counter increments on lookup', () => {
  const s = new MemoStore({ defaultTtlMs: 1000 }, compileGlob)
  s.store('t', {}, 'v', 1000)
  s.lookup('t', {}, 1100)
  const { entry } = s.lookup('t', {}, 1200)
  assert.equal(entry?.hits, 2)
})

test('preview bounds output', () => {
  assert.equal(preview('short', 10), 'short')
  assert.ok(preview('x'.repeat(200), 100).length <= 101)
  assert.equal(preview(undefined, 10), 'undefined')
})
