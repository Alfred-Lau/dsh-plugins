import { Context } from '@deepseek-ai/cordis'
import * as ticket from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-ticket/lib/index.js'
import * as pii from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-pii/lib/index.js'

const ctx = new Context()
ctx.provide('logger', { info: (...a) => console.log('INFO', ...a), warn: (...a) => console.log('WARN', ...a), error: console.log, debug(){} })
await ctx.plugin(ticket, { enabled: true, masterId: 'master', workerPrefix: 'worker-', rules: [] })
await ctx.plugin(pii, { enabled: true, mode: 'audit', outboundTools: ['bash'], audit: { enabled: false }, ticket: { enabled: true, masterId: 'master', rules: [{ match: 't-1043', mode: 'block' }] } })
const p2 = { tool: 'bash', args: { command: 'gh pr comment --body "bob@example.com"' }, sessionId: 'worker-t-1043' }
console.log('pii pre:', JSON.stringify(ctx.waterfall('tools/pre-execute', p2, () => undefined)))
