/**
 * Integration test: loads the plugin into a real Cordis context and checks
 * that the `ticket` service actually lands on `ctx` — the seam the other
 * governance plugins inject.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'

const config = {
  enabled: true,
  masterId: 'master-1',
  workerPrefix: 'worker-',
  rules: [{ match: 'fix-*', blockedCommands: ['git'] }],
}

test('the plugin publishes a ticket service on ctx', async () => {
  const ctx = new Context()
  await ctx.plugin(plugin, config)

  assert.equal(typeof ctx.ticket, 'object')
  assert.equal(ctx.ticket.masterId, 'master-1')
  assert.equal(ctx.ticket.workerPrefix, 'worker-')
})

test('the service resolves scopes and rules', async () => {
  const ctx = new Context()
  await ctx.plugin(plugin, config)

  assert.deepEqual(ctx.ticket.scopeOf('worker-t-1'), { role: 'worker', sessionId: 'worker-t-1', ticketId: 't-1' })
  assert.deepEqual(ctx.ticket.scopeOf('master-1'), { role: 'router', sessionId: 'master-1' })
  assert.equal(ctx.ticket.scopeOf('unrelated'), undefined)

  assert.deepEqual(ctx.ticket.scopeFrom({ sessionId: 'worker-t-2' })?.ticketId, 't-2')
  assert.deepEqual(ctx.ticket.policyFor('fix-login')?.rule.blockedCommands, ['git'])
  assert.equal(ctx.ticket.policyFor('review-login'), undefined)
})

test('disabling the plugin leaves ctx.ticket unset', async () => {
  const ctx = new Context()
  await ctx.plugin(plugin, { ...config, enabled: false })

  assert.equal(ctx.ticket, undefined)
})
