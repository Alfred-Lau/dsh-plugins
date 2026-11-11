import { Context } from '@deepseek-ai/cordis'
import * as ticket from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-ticket/lib/index.js'
import * as rate from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-rate/lib/index.js'
import * as memo from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-memo/lib/index.js'
import * as pii from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-pii/lib/index.js'
import * as policy from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-policy/lib/index.js'

const RULES = [{ match: 't-1042', blockedCommands: ['git'], dailyTokens: 200000, maxCalls: 4, mode: 'enforce' }]
const ctx = new Context()
ctx.provide('logger', { info(){}, warn(){}, error(){}, debug(){} })
const MASTER = 'master'
await ctx.plugin(ticket, { enabled: true, masterId: MASTER, workerPrefix: 'worker-', rules: RULES })
await ctx.plugin(rate, { enabled: true, mode: 'enforce', budget: { dailyTokens: 0, criticalAction: 'block-tools' }, toolStorm: { windowMs: 600000, maxCalls: 0 }, audit: { enabled: false }, ticket: { enabled: true, masterId: MASTER, rules: RULES } })
await ctx.plugin(memo, { enabled: true, mode: 'hint', defaultTtlMs: 600000, audit: { enabled: true, file: '/tmp/p6-memo.jsonl' }, ticket: { enabled: true, masterId: MASTER, isolation: 'ticket' } })
await ctx.plugin(pii, { enabled: true, mode: 'audit', outboundTools: ['bash'], audit: { enabled: false }, ticket: { enabled: true, masterId: MASTER, rules: [{ match: 't-1043', mode: 'block' }] } })
await ctx.plugin(policy, { enabled: true, defaultDecision: 'allow', failClosed: true, rules: [], ticket: { enabled: true, masterId: MASTER, useService: true }, audit: { enabled: false } })

const p = { tool: 'read', args: { path: 'src/auth/login.ts' }, sessionId: 'worker-t-1042' }
console.log('1st:', JSON.stringify(ctx.waterfall('tools/pre-execute', p, () => undefined)))
ctx.emit('tools/post-execute', { ...p, output: 'export function login() {}' })
console.log('2nd:', JSON.stringify(ctx.waterfall('tools/pre-execute', p, () => undefined)))
