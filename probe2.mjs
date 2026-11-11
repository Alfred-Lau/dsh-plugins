import { Context } from '@deepseek-ai/cordis'
import * as ticket from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-ticket/lib/index.js'
import * as memo from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-memo/lib/index.js'
import * as pii from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-pii/lib/index.js'

const log = { info(){}, warn(){}, error(){}, debug(){} }
const ctx = new Context()
ctx.provide('logger', log)
await ctx.plugin(ticket, { enabled: true, masterId: 'master', workerPrefix: 'worker-', rules: [] })
await ctx.plugin(memo, { enabled: true, mode: 'hint', defaultTtlMs: 600000, audit: { enabled: false } })
await ctx.plugin(pii, { enabled: true, mode: 'audit', outboundTools: ['bash'], audit: { enabled: false }, ticket: { enabled: true, masterId: 'master', rules: [{ match: 't-1043', mode: 'block' }] } })

const p = { tool: 'read', args: { path: 'a.ts' }, sessionId: 'worker-t-1042' }
console.log('1st pre:', JSON.stringify(ctx.waterfall('tools/pre-execute', p, () => undefined)))
ctx.emit('tools/post-execute', { ...p, output: 'hello' })
console.log('2nd pre:', JSON.stringify(ctx.waterfall('tools/pre-execute', p, () => undefined)))

const p2 = { tool: 'bash', args: { command: 'gh pr comment --body "bob@example.com"' }, sessionId: 'worker-t-1043' }
console.log('pii pre:', JSON.stringify(ctx.waterfall('tools/pre-execute', p2, () => undefined)))

import { makeTicketScope } from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-pii/lib/ticket-scope.js'
const h = makeTicketScope(ctx, { enabled: true, masterId: 'master', rules: [{ match: 't-1043', mode: 'block' }] })
console.log('handle:', h?.source)
const sc = h.scopeOf('worker-t-1043')
console.log('scope:', JSON.stringify(sc))
console.log('rule:', JSON.stringify(h.ruleFor(sc)))
