import { Context } from '@deepseek-ai/cordis'
import * as pii from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-pii/lib/index.js'
const ctx = new Context()
ctx.provide('logger', { info: (...a) => console.log('INFO', ...a), warn: (...a) => console.log('WARN', ...a), error: console.log, debug(){} })
const fork = ctx.plugin(pii, { enabled: true, mode: 'audit', outboundTools: ['bash'], audit: { enabled: false }, ticket: { enabled: true, masterId: 'master', rules: [{ match: 't-1043', mode: 'block' }] } })
await fork
console.log('fork state:', fork.state ?? fork.status ?? Object.keys(fork))
const hooks = ctx.events?._hooks?.['tools/pre-execute']
console.log('listeners:', hooks?.length)
