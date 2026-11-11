import test from 'node:test'
import assert from 'node:assert/strict'
import { makeTicketScope, resolveTicketScope, ruleForTicket } from '../lib/ticket-scope.js'

const rules = [
  { match: 'review-*', mode: 'block' as const, outboundTools: ['bash', 'http*'] },
  { match: 'fix-*', mode: 'audit' as const, minMatches: 3 },
  { match: '*', mode: 'block' as const },
]

test('resolveTicketScope reads worker-<ticketId>', () => {
  assert.deepEqual(resolveTicketScope('worker-t-1', {}), { role: 'worker', ticketId: 't-1' })
})

test('resolveTicketScope needs masterId to claim the router', () => {
  assert.deepEqual(resolveTicketScope('m-1', { masterId: 'm-1' }), { role: 'router' })
  assert.equal(resolveTicketScope('m-1', {}), undefined)
})

test('resolveTicketScope ignores plain sessions and bare prefixes', () => {
  assert.equal(resolveTicketScope('session-x', { masterId: 'm-1' }), undefined)
  assert.equal(resolveTicketScope('worker-', {}), undefined)
  assert.equal(resolveTicketScope(undefined, {}), undefined)
})

test('ruleForTicket takes the first glob match, router included', () => {
  assert.equal(ruleForTicket({ role: 'worker', ticketId: 'review-pr' }, rules)?.mode, 'block')
  assert.equal(ruleForTicket({ role: 'worker', ticketId: 'fix-login' }, rules)?.minMatches, 3)
  assert.equal(ruleForTicket({ role: 'worker', ticketId: 'chore-x' }, rules)?.mode, 'block')
  assert.equal(ruleForTicket({ role: 'router' }, rules)?.mode, 'block')
  assert.equal(ruleForTicket(undefined, rules), undefined)
})

test('makeTicketScope prefers the shared service', () => {
  const service = { scopeOf: () => ({ role: 'worker' as const, ticketId: 'from-service' }) }
  const handle = makeTicketScope({ get: (n: string) => (n === 'ticket' ? service : undefined) }, { rules })
  assert.equal(handle?.source, 'dsh-ticket-context')
  assert.deepEqual(handle?.scopeOf('anything'), { role: 'worker', ticketId: 'from-service' })
})

test('makeTicketScope falls back to the Session id', () => {
  const handle = makeTicketScope({}, { masterId: 'm-1', rules })
  assert.equal(handle?.source, 'config')
  assert.deepEqual(handle?.scopeOf('worker-t-9'), { role: 'worker', ticketId: 't-9' })
  assert.equal(handle?.ruleFor({ role: 'worker', ticketId: 'review-pr' })?.mode, 'block')
})

test('makeTicketScope returns undefined when disabled', () => {
  assert.equal(makeTicketScope({}, { enabled: false }), undefined)
})

test('a service without a rule table still resolves scopes', () => {
  const service = { scopeOf: () => ({ role: 'worker' as const, ticketId: 'x' }) }
  const handle = makeTicketScope({ get: () => service }, { rules })
  assert.equal(handle?.ruleFor({ role: 'worker', ticketId: 'review-pr' })?.mode, 'block')
})
