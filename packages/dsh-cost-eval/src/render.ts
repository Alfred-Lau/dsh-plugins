import type { CostReport, CostReportEntry, GateVerdict, NormalizedRun } from './types.js'
import type { TicketReport } from './tickets.js'

function pct(v: number | null): string {
  return v === null ? 'n/a' : `${Math.round(v * 1000) / 10}%`
}

function usd(v: number | null): string {
  if (v === null) return 'n/a'
  return `$${v >= 0.01 ? v.toFixed(2) : v.toPrecision(2)}`
}

function int(v: number | null): string {
  return v === null ? 'n/a' : Math.round(v).toLocaleString('en-US')
}

function qualityLabel(e: CostReportEntry): string {
  const q = e.run.quality
  if (q === null) return 'n/a'
  return `${pct(q)} (${e.run.qualitySource})`
}

/** Renders the leaderboard as GitHub-flavored markdown. */
export function renderReportMarkdown(report: CostReport, runCount: number): string {
  const lines: string[] = []
  const first = report.entries[0]
  lines.push('## dsh-cost-eval report', '')
  if (first) {
    lines.push(`Benchmark: \`${first.run.benchmark}\` — ${runCount} run(s) compared`, '')
  }
  lines.push(
    '| # | run | model | quality | task success | cost | cost/success | tokens/success | completed | mean latency |',
    '|---|-----|-------|---------|--------------|------|--------------|----------------|-----------|--------------|',
  )
  report.ranked.forEach((e, i) => {
    const r = e.run
    lines.push(
      `| ${i + 1} | \`${r.label}\` | ${r.model} | ${qualityLabel(e)} | ${pct(r.taskSuccessRate)} | ${usd(r.totalCostUsd)} | ${usd(e.costPerSuccess)} | ${int(e.tokensPerSuccess)} | ${r.completedCount}/${r.caseCount} | ${int(e.meanLatencyMs)} ms |`,
    )
  })
  lines.push('')
  const unmeasured = report.ranked.filter((e) => e.run.quality === null || e.costPerSuccess === null)
  if (unmeasured.length) {
    lines.push(
      '> n/a notes: quality needs grading or judge data; cost/success needs pricing plus graded successes. Ranking places unmeasured runs last.',
    )
  }
  return lines.join('\n')
}

/** Renders a gate verdict as markdown (CI job summaries like this format). */
export function renderGateMarkdown(base: NormalizedRun, candidate: NormalizedRun, verdict: GateVerdict): string {
  const lines: string[] = []
  const icon = verdict.decision === 'pass' ? '✅' : '❌'
  lines.push(`## ${icon} dsh-cost-eval gate: ${verdict.decision.toUpperCase()}`, '')
  lines.push(`Base: \`${base.label}\` (${base.model}) — Candidate: \`${candidate.label}\` (${candidate.model})`, '')
  lines.push(
    '| check | base | candidate | limit | result |',
    '|-------|------|-----------|-------|--------|',
  )
  for (const c of verdict.checks) {
    const result = c.passed === null ? 'unverifiable' : c.passed ? 'pass' : 'FAIL'
    lines.push(`| ${c.name} | ${fmtCheck(c.base, c.name)} | ${fmtCheck(c.candidate, c.name)} | ${c.limit ?? 'n/a'} | ${result} |`)
  }
  lines.push('')
  for (const r of verdict.reasons) {
    lines.push(`- ${r}`)
  }
  return lines.join('\n')
}

function fmtCheck(v: number | null, name: string): string {
  if (v === null) return 'n/a'
  if (name === 'qualityDrop') return pct(v)
  if (name === 'costIncrease') return usd(v)
  return String(Math.round(v * 100) / 100)
}

/** Renders the per-ticket cost rollup as GitHub-flavored markdown. */
export function renderTicketReportMarkdown(report: TicketReport, sourceLabel: string): string {
  const lines: string[] = []
  lines.push('## dsh-cost-eval tickets', '')
  lines.push(`Source: \`${sourceLabel}\` — ${report.totals.tickets} ticket(s), ${report.totals.spans} span(s)`, '')

  if (report.totals.tickets === 0) {
    lines.push(
      'No ticket-tagged spans found. Ticket rows come from `dsh.ticket.id` / `dsh.ticket.role`,',
      'which `dsh-trace` writes for `dsh-superagent` Sessions (`worker-<ticketId>`).',
      '',
    )
    if (report.untaggedSpans > 0) lines.push(`${report.untaggedSpans} span(s) carried no ticket tag.`, '')
    return lines.join('\n')
  }

  lines.push('| Ticket | Role | LLM | Tools | Failed | Input | Output | Cost |')
  lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const t of report.tickets) {
    const cost = t.hasUnpricedModel ? `${usd(t.costUsd)} + unpriced` : usd(t.costUsd)
    lines.push(
      `| \`${t.ticketId}\` | ${t.role} | ${t.llmCalls} | ${t.toolCalls} | ${t.failedToolCalls} | ` +
        `${int(t.inputTokens)} | ${int(t.outputTokens)} | ${cost} |`,
    )
  }
  lines.push(
    `| **total** | | **${report.totals.llmCalls}** | **${report.totals.toolCalls}** | **${report.totals.failedToolCalls}** | ` +
      `**${int(report.totals.inputTokens)}** | **${int(report.totals.outputTokens)}** | **${usd(report.totals.costUsd)}** |`,
    '',
  )

  if (report.budgetUsd !== undefined) {
    if (report.overBudget.length === 0) {
      lines.push(`Budget: ${usd(report.budgetUsd)} per ticket — **all tickets within budget**.`, '')
    } else {
      lines.push(`Budget: ${usd(report.budgetUsd)} per ticket — **${report.overBudget.length} over budget**:`, '')
      for (const t of report.overBudget) {
        const over = report.budgetUsd > 0 ? ` (${Math.round((t.costUsd / report.budgetUsd - 1) * 1000) / 10}% over)` : ''
        lines.push(`- \`${t.ticketId}\` — ${usd(t.costUsd)}${over}`)
      }
      lines.push('')
    }
  }

  if (report.unpriced.length > 0) {
    lines.push(
      `Unpriced models (tokens counted, cost excluded): ${report.unpriced.map(m => `\`${m}\``).join(', ')}.`,
      'Pass `--pricing <file>` with a table you maintain to price them.',
      '',
    )
  }
  if (report.untaggedSpans > 0) {
    lines.push(`${report.untaggedSpans} span(s) carried no ticket tag (non-Super-agent sessions).`, '')
  }
  return lines.join('\n')
}
