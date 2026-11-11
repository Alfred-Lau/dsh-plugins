/**
 * One dsh-superagent ticket, replayed through the governance plane.
 *
 * This is a *replay*, not a live Super-agent run: Super-agent needs a GitHub App
 * and an LLM key, and neither belongs in a demo. What it does exercise is the
 * real thing — the seven packages loaded into a real Cordis context, receiving
 * the same `session/event` broadcasts and `tools/pre-execute` payloads the
 * harness emits, with the Session ids Super-agent actually uses
 * (`worker-<ticketId>` and the router's master id). Spans are exported over
 * HTTP by dsh-trace into a collector this script runs, so the ticket tags are
 * verified end to end rather than asserted.
 *
 * Run: node examples/superagent-governance/run.mjs [--json]
 */

import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as trace from '../../packages/dsh-trace/lib/index.js'
import * as policy from '../../packages/dsh-policy/lib/index.js'
import * as pii from '../../packages/dsh-pii/lib/index.js'
import * as rate from '../../packages/dsh-rate/lib/index.js'
import * as memo from '../../packages/dsh-memo/lib/index.js'
import * as ticket from '../../packages/dsh-ticket/lib/index.js'
import { aggregateTickets } from '../../packages/dsh-cost-eval/lib/tickets.js'
import { renderTicketReportMarkdown } from '../../packages/dsh-cost-eval/lib/render.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'output')

const MASTER = 'master'
const T_LOGIN = 'worker-t-1042'
const T_REVIEW = 'worker-t-1043'
const T_BILLING = 'worker-t-1044'

/** The ticket table: one row per ticket, which is the whole point of the plane. */
const RULES = [
  { match: 't-1042', blockedCommands: ['git'], dailyTokens: 200_000, maxCalls: 4, mode: 'enforce' },
  { match: 't-1043', blockedCommands: ['git'], dailyTokens: 120_000, maxCalls: 4, mode: 'enforce' },
  { match: 't-1044', blockedCommands: [], dailyTokens: 200_000, maxCalls: 30, mode: 'enforce' },
]

function silentLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} }
}

/** Local OTLP-less collector: dsh-trace posts a span array, we keep it. */
async function startCollector() {
  const spans = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body)
        if (Array.isArray(parsed)) spans.push(...parsed)
      } catch {
        /* ignore malformed batches */
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
  return { spans, port, close: () => new Promise((r) => server.close(r)) }
}

async function boot({ governed, port }) {
  const ctx = new Context()
  ctx.provide('logger', silentLogger())

  const configs = {
    ticket: { enabled: governed, masterId: MASTER, workerPrefix: 'worker-', rules: RULES },
    trace: {
      enabled: true,
      httpUsage: { endpoint: `http://127.0.0.1:${port}/spans`, mode: 'spans' },
      batch: { maxSpansPerBatch: 200 },
      ticket: { enabled: governed, masterId: MASTER },
    },
    rate: {
      enabled: governed,
      mode: 'enforce',
      budget: { dailyTokens: 0, criticalAction: 'block-tools' },
      toolStorm: { windowMs: 600_000, maxCalls: 0 },
      audit: { enabled: governed, file: join(OUT, governed ? 'governed-rate.jsonl' : 'bare-rate.jsonl') },
      ticket: { enabled: governed, masterId: MASTER, rules: RULES },
    },
    memo: {
      enabled: governed,
      mode: 'hint',
      defaultTtlMs: 600_000,
      audit: { enabled: governed, file: join(OUT, governed ? 'governed-memo.jsonl' : 'bare-memo.jsonl') },
      ticket: { enabled: governed, masterId: MASTER, isolation: 'ticket' },
    },
    pii: {
      enabled: governed,
      mode: 'audit',
      outboundTools: ['bash', 'http*', 'fetch*', 'send*', 'gh*'],
      audit: { enabled: governed, file: join(OUT, governed ? 'governed-pii.jsonl' : 'bare-pii.jsonl') },
      ticket: { enabled: governed, masterId: MASTER, rules: [{ match: 't-1043', mode: 'block' }] },
    },
    policy: {
      enabled: governed,
      defaultDecision: 'allow',
      failClosed: true,
      rules: [],
      ticket: { enabled: governed, masterId: MASTER, useService: true },
      audit: { enabled: governed, file: join(OUT, governed ? 'governed-policy.jsonl' : 'bare-policy.jsonl') },
    },
  }

  // Registration order is the waterfall order. `ticket` first (it publishes the
  // service the others look up), then memo — a cache hit answers the call
  // without spending anything, so it must be consulted before the budget gate
  // can refuse it. The expensive gates (regex sweeps) come last.
  await ctx.plugin(ticket, configs.ticket)
  await ctx.plugin(trace, configs.trace)
  await ctx.plugin(memo, configs.memo)
  await ctx.plugin(rate, configs.rate)
  await ctx.plugin(pii, configs.pii)
  await ctx.plugin(policy, configs.policy)

  return ctx
}

/**
 * The scenario: a router dispatches three tickets with different exposure. Each
 * step is one thing the harness would really do — an LLM completion, a tool
 * call, a tool result. `expect` documents which layer should speak, so the
 * report can show a miss as plainly as a hit.
 */
const STEPS = [
  // --- t-1042: fix the login bug (budget 200k, storm 4, git denied) --------------
  { s: T_LOGIN, kind: 'llm', usage: { input_tokens: 180_000, output_tokens: 12_000 }, model: 'deepseek-chat' },
  { s: T_LOGIN, kind: 'tool', tool: 'read', args: { path: 'src/auth/login.ts' }, output: 'export function login() {}', expect: 'allow' },
  { s: T_LOGIN, kind: 'tool', tool: 'read', args: { path: 'src/auth/login.ts' }, expect: 'memo' },
  { s: T_LOGIN, kind: 'tool', tool: 'bash', args: { command: '/usr/bin/git push origin fix/login' }, expect: 'policy' },
  { s: T_LOGIN, kind: 'tool', tool: 'bash', args: { command: 'npm test -- auth' }, output: 'ok', expect: 'allow' },
  { s: T_LOGIN, kind: 'tool', tool: 'bash', args: { command: 'npm run lint' }, output: 'ok', expect: 'allow' },
  { s: T_LOGIN, kind: 'tool', tool: 'bash', args: { command: 'npm run build' }, expect: 'storm' },

  // --- t-1043: review a PR (PII must not leave, cache must not cross) ------------
  { s: T_REVIEW, kind: 'llm', usage: { input_tokens: 60_000, output_tokens: 5_000 }, model: 'deepseek-chat' },
  // Same file t-1042 already read: the cache is per-ticket, so this is a miss
  // and the read really happens. `allow` is the correct verdict here — the
  // isolation shows up in the audit trail, not in the verdict.
  { s: T_REVIEW, kind: 'tool', tool: 'read', args: { path: 'src/auth/login.ts' }, output: 'export function login() {}', expect: 'allow', note: 'cross-ticket cache miss' },
  { s: T_REVIEW, kind: 'tool', tool: 'bash', args: { command: 'gh pr comment 42 --body "tested with bob@example.com"' }, expect: 'pii' },
  { s: T_REVIEW, kind: 'tool', tool: 'bash', args: { command: 'gh pr view 42' }, output: 'PR 42', expect: 'allow' },

  // --- t-1044: billing refactor (budget 200k, already spent 280k) ----------------
  { s: T_BILLING, kind: 'tool', tool: 'read', args: { path: 'src/auth/login.ts' }, output: 'export function login() {}', expect: 'allow', note: 'cross-ticket cache miss' },
  { s: T_BILLING, kind: 'llm', usage: { input_tokens: 260_000, output_tokens: 20_000 }, model: 'deepseek-chat' },
  { s: T_BILLING, kind: 'tool', tool: 'bash', args: { command: 'npm test' }, expect: 'budget' },

  // --- router: cheap, but it is a ticket too -------------------------------------
  { s: MASTER, kind: 'llm', usage: { input_tokens: 20_000, output_tokens: 2_000 }, model: 'deepseek-chat' },
]

/** Which layer a verdict came from, for the report. */
function layerOf(verdict) {
  if (!verdict?.ruleId) return 'allow'
  const id = String(verdict.ruleId)
  if (id.startsWith('ticket:')) return 'policy'
  if (id.startsWith('pii-')) return 'pii'
  if (id.startsWith('rate-budget')) return 'budget'
  if (id.startsWith('rate-storm')) return 'storm'
  if (id.startsWith('rate-backoff')) return 'backoff'
  if (id.startsWith('memo-')) return 'memo'
  return id
}

async function replay({ governed, port }) {
  const ctx = await boot({ governed, port })
  const outcomes = []
  let seq = 0

  for (const step of STEPS) {
    if (step.kind === 'llm') {
      ctx.emit('session/event', { type: 'assistant', sessionId: step.s, usage: step.usage, model: step.model })
      outcomes.push({ step, verdict: null, layer: 'llm' })
      continue
    }
    // `tools/pre-execute` is a waterfall: the last argument is the innermost
    // `next`, and a listener returning a verdict short-circuits the call.
    const verdict = ctx.waterfall('tools/pre-execute', { tool: step.tool, args: step.args, sessionId: step.s }, () => undefined)
    const layer = layerOf(verdict)
    outcomes.push({ step, verdict: verdict ?? null, layer })
    // A denied call never runs, so no result arrives for it. An explicit
    // `{ decision: 'allow' }` (policy's default verdict) still means "ran".
    const ran = !verdict || verdict.decision === 'allow'
    if (!ran) continue

    // Report the call to the trace stream the way the harness does: a start
    // event when the tool is dispatched, an end event when it returns. Without
    // these the trace only knows about LLM turns and the per-ticket tool
    // counters stay at zero.
    const callId = `call-${seq++}`
    const startTs = Date.now()
    ctx.emit('session/event', {
      type: 'tool/start',
      sessionId: step.s,
      ts: startTs,
      callId,
      tool: { name: step.tool },
      args: step.args,
    })
    if (step.output !== undefined) {
      ctx.emit('session/event', {
        type: 'tool/end',
        sessionId: step.s,
        ts: startTs + 12,
        callId,
        tool: { name: step.tool },
        args: step.args,
        result: step.output,
      })
      ctx.emit('tools/post-execute', { tool: step.tool, args: step.args, output: step.output, sessionId: step.s })
    }
  }

  // The harness signals end-of-session; dsh-trace only drains its queue on that
  // event (or on dispose), so the collector would stay empty without it.
  ctx.emit('session/flush')
  await new Promise((r) => setTimeout(r, 800))
  return { outcomes }
}

function summarize(outcomes) {
  const byTicket = new Map()
  for (const o of outcomes) {
    const row = byTicket.get(o.step.s) ?? { session: o.step.s, calls: 0, denied: 0, layers: {} }
    if (o.step.kind === 'tool') {
      row.calls += 1
      row.layers[o.layer] = (row.layers[o.layer] ?? 0) + 1
      if (o.layer !== 'allow') row.denied += 1
    }
    byTicket.set(o.step.s, row)
  }
  return [...byTicket.values()]
}

async function runOnce({ governed }) {
  const collector = await startCollector()
  try {
    const { outcomes } = await replay({ governed, port: collector.port })
    return { outcomes: summarize(outcomes), raw: outcomes, spans: collector.spans }
  } finally {
    await collector.close()
  }
}

function main() {
  return (async () => {
    rmSync(OUT, { recursive: true, force: true })
    mkdirSync(OUT, { recursive: true })

    const bare = await runOnce({ governed: false })
    const governed = await runOnce({ governed: true })

    const bareTickets = aggregateTickets(bare.spans)
    const govTickets = aggregateTickets(governed.spans)

    const report = {
      bare: { outcomes: bare.outcomes, tickets: bareTickets, spans: bare.spans.length },
      governed: { outcomes: governed.outcomes, tickets: govTickets, spans: governed.spans.length },
      expectations: governed.raw
        .filter((o) => o.step.kind === 'tool')
        .map((o) => ({
          ticket: o.step.s,
          command: o.step.args?.command ?? o.step.args?.path,
          expected: o.step.expect,
          actual: o.layer,
          ok: o.step.expect === o.layer,
        })),
    }

    writeFileSync(join(OUT, 'result.json'), JSON.stringify(report, null, 2))
    writeFileSync(join(OUT, 'governed-tickets.md'), renderTicketReportMarkdown(govTickets, 'dsh-trace spans'))
    writeFileSync(join(OUT, 'bare-tickets.md'), renderTicketReportMarkdown(bareTickets, 'dsh-trace spans'))

    const passed = report.expectations.filter((e) => e.ok).length
    const total = report.expectations.length

    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      if (process.argv.includes('--strict') && passed !== total) process.exitCode = 1
      return
    }

    const line = (s = '') => process.stdout.write(s + '\n')
    line('=== bare: no governance plane ===')
    for (const t of report.bare.outcomes) line(`  ${t.session.padEnd(16)} ${t.calls} calls, ${t.denied} denied`)
    line(`  spans: ${report.bare.spans}, tickets tagged: ${report.bare.tickets.totals.tickets}`)
    line()
    line('=== governed ===')
    for (const t of report.governed.outcomes) {
      const layers = Object.entries(t.layers).map(([k, v]) => `${k}×${v}`).join(' ')
      line(`  ${t.session.padEnd(16)} ${t.calls} calls, ${t.denied} denied   ${layers}`)
    }
    line(`  spans: ${report.governed.spans}, tickets tagged: ${report.governed.tickets.totals.tickets}`)
    line()
    line('=== expectations ===')
    for (const e of report.expectations) {
      line(`  ${e.ok ? 'ok  ' : 'MISS'} ${e.ticket.padEnd(14)} expected=${e.expected.padEnd(7)} actual=${e.actual.padEnd(7)} ${e.command}`)
    }
    line()
    line(`  ${passed}/${total} expectations ok`)
    line()
    line(renderTicketReportMarkdown(govTickets, 'dsh-trace spans'))

    // `--strict` turns a missed expectation into a non-zero exit so CI can gate
    // on it. Without the flag a miss is just information, which is what you
    // want while poking at the plugins locally.
    if (process.argv.includes('--strict') && passed !== total) {
      process.stderr.write(`\n${total - passed} expectation(s) missed\n`)
      process.exitCode = 1
    }
  })()
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + '\n')
  process.exit(1)
})
