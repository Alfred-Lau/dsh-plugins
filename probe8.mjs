import { Context } from '@deepseek-ai/cordis'
import * as ticket from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-ticket/lib/index.js'
import { makeScopeResolver } from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-trace/lib/ticket.js'
import { projectSessionEvent } from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-trace/lib/event-map.js'
import { Config as TraceConfig } from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-trace/lib/config-schema.js'

const ctx = new Context()
ctx.provide('logger', { info(){}, warn: console.log, error: console.log, debug(){} })
await ctx.plugin(ticket, { enabled: true, masterId: 'master', workerPrefix: 'worker-', rules: [] })

const parsed = TraceConfig({ enabled: true, httpUsage: { endpoint: 'http://127.0.0.1:1/x', mode: 'spans' }, ticket: { enabled: true, masterId: 'master' } })
console.log('parsed.ticket =', JSON.stringify(parsed.ticket))

const scopeOf = makeScopeResolver(ctx, parsed.ticket ?? {})
console.log('scopeOf exists:', !!scopeOf)
console.log('scope:', JSON.stringify(scopeOf?.('worker-t-1042')))
const proj = projectSessionEvent({ type: 'assistant', sessionId: 'worker-t-1042', usage: { input_tokens: 1, output_tokens: 1 }, model: 'm' })
console.log('proj.kind:', proj?.kind)
