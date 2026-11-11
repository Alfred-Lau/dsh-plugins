import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchGlob, policyFor, scopeOf, sessionIdOf } from '../lib/index.js'

test('worker session resolves to its ticket', () => {
  assert.deepEqual(scopeOf('worker-t-42'), { role: 'worker', sessionId: 'worker-t-42', ticketId: 't-42' })
})

test('master session resolves to the router when masterId is configured', () => {
  assert.deepEqual(scopeOf('master-1', { masterId: 'master-1' }), { role: 'router', sessionId: 'master-1' })
})

test('masterId is ignored for a different session', () => {
  assert.equal(scopeOf('master-2', { masterId: 'master-1' }), undefined)
})

test('without masterId the router is simply not recognised', () => {
  assert.equal(scopeOf('master-1'), undefined)
})

test('a bare worker prefix carries no ticket and is not a scope', () => {
  assert.equal(scopeOf('worker-'), undefined)
})

test('ordinary harness sessions have no scope', () => {
  assert.equal(scopeOf('session-abc'), undefined)
  assert.equal(scopeOf(''), undefined)
  assert.equal(scopeOf(undefined), undefined)
  assert.equal(scopeOf(42), undefined)
})

test('worker prefix is configurable', () => {
  assert.deepEqual(scopeOf('exec-t9', { workerPrefix: 'exec-' }), { role: 'worker', sessionId: 'exec-t9', ticketId: 't9' })
  // The default prefix no longer matches once overridden.
  assert.equal(scopeOf('worker-t9', { workerPrefix: 'exec-' }), undefined)
})

test('sessionIdOf reads every payload key the harness has used', () => {
  assert.equal(sessionIdOf({ sessionId: 'worker-a' }), 'worker-a')
  assert.equal(sessionIdOf({ session_id: 'worker-b' }), 'worker-b')
  assert.equal(sessionIdOf({ session: 'worker-c' }), 'worker-c')
})

test('sessionIdOf ignores absent, empty and non-object payloads', () => {
  assert.equal(sessionIdOf({ tool: 'bash' }), undefined)
  assert.equal(sessionIdOf({ sessionId: '' }), undefined)
  assert.equal(sessionIdOf(null), undefined)
  assert.equal(sessionIdOf('worker-a'), undefined)
})

test('matchGlob handles literals, wildcards and regex metacharacters', () => {
  assert.ok(matchGlob('fix-*', 'fix-login'))
  assert.ok(matchGlob('fix-*', 'fix-'))
  assert.ok(!matchGlob('fix-*', 'review-login'))
  assert.ok(matchGlob('*', 'anything'))
  assert.ok(matchGlob('t-??', 't-42'))
  assert.ok(!matchGlob('t-??', 't-421'))
  // Dots are literals, not "any character".
  assert.ok(matchGlob('a.b', 'a.b'))
  assert.ok(!matchGlob('a.b', 'axb'))
})

test('policyFor returns the first matching rule', () => {
  const rules = [
    { match: 'fix-*', blockedCommands: ['git'] },
    { match: 'fix-login', blockedCommands: ['npm'] },
    { match: '*', blockedCommands: ['rm'] },
  ]
  assert.deepEqual(policyFor('fix-login', rules)?.rule.blockedCommands, ['git'])
  assert.deepEqual(policyFor('review-pr', rules)?.rule.blockedCommands, ['rm'])
})

test('policyFor returns undefined when nothing matches', () => {
  assert.equal(policyFor('fix-login', [{ match: 'review-*' }]), undefined)
  assert.equal(policyFor('fix-login'), undefined)
})
