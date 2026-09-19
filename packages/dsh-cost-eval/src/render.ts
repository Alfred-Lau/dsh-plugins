import type { CostReport, CostReportEntry, GateVerdict, NormalizedRun } from './types.js'

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
