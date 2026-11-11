import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import * as ticket from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-ticket/lib/index.js'
import * as trace from '/Users/liujian/CodeZone/dsh-plugins/packages/dsh-trace/lib/index.js'

const spans = []
const server = createServer((req, res) => {
  let b = ''
  req.on('data', c => b += c)
  req.on('end', () => { try { const p = JSON.parse(b); if (Array.isArray(p)) spans.push(...p) } catch(e){ console.log('parse err', b.slice(0,200)) } res.writeHead(200).end('{}') })
})
const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))

const ctx = new Context()
ctx.provide('logger', { info(){}, warn: (...a)=>console.log('WARN',...a), error: (...a)=>console.log('ERR',...a), debug(){} })
await ctx.plugin(ticket, { enabled: true, masterId: 'master', workerPrefix: 'worker-', rules: [] })
await ctx.plugin(trace, { enabled: true, httpUsage: { endpoint: `http://127.0.0.1:${port}/spans`, mode: 'spans' }, batch: { maxSpansPerBatch: 200 }, ticket: { enabled: true, masterId: 'master' } })

ctx.emit('session/event', { type: 'assistant', sessionId: 'worker-t-1042', usage: { input_tokens: 100, output_tokens: 10 }, model: 'deepseek-chat' })
ctx.emit('session/flush')
await new Promise(r => setTimeout(r, 600))
console.log('spans:', spans.length)
console.log(JSON.stringify(spans[0], null, 2)?.slice(0, 1500))
server.close()
