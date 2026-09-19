import { parseArgs } from 'node:util'
import { loadRun } from './normalize.js'
import { evaluate } from './evaluate.js'
import { gate } from './gate.js'
import { renderGateMarkdown, renderReportMarkdown } from './render.js'
import type { GateBudget } from './types.js'

function usage(): string {
  return `dsh-cost-eval — cost-effectiveness reports and release gates over dsh-eval run records

Usage:
  dsh-cost-eval report <run.json> [more.json...] [--json]
      Rank 1..N dsh-eval run records by quality x cost. --json emits the
      machine-readable report instead of markdown.

  dsh-cost-eval gate --base <run.json> --candidate <run.json>
      [--max-cost-increase-pct 20] [--max-quality-drop-pct 10]
      [--max-tokens-per-success-increase-pct 25] [--min-task-success-rate 0.8]
      [--json]
      Compare a candidate run against the base run under a cost budget.
      Exits 0 on PASS, 1 on FAIL, 2 on usage or parse errors.
`
}

function fail(msg: string): never {
  process.stderr.write(`dsh-cost-eval: ${msg}\n`)
  process.exit(2)
}

function numOpt(values: Record<string, unknown>, key: string): number | undefined {
  const v = values[key]
  if (typeof v !== 'string') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function runReport(files: string[], json: boolean): number {
  if (files.length === 0) fail('report needs at least one run record file\n' + usage())
  const runs = files.map((f) => loadRun(f))
  const report = evaluate(runs)
  process.stdout.write(json ? JSON.stringify(report, null, 2) + '\n' : renderReportMarkdown(report, runs.length) + '\n')
  return 0
}

function runGate(values: Record<string, unknown>, json: boolean): number {
  const baseFile = values.base
  const candFile = values.candidate
  if (typeof baseFile !== 'string' || typeof candFile !== 'string') {
    fail('gate needs --base and --candidate run record files\n' + usage())
  }
  const budget: GateBudget = {
    maxCostIncreasePct: numOpt(values, 'max-cost-increase-pct'),
    maxQualityDropPct: numOpt(values, 'max-quality-drop-pct'),
    maxTokensPerSuccessIncreasePct: numOpt(values, 'max-tokens-per-success-increase-pct'),
    minTaskSuccessRate: numOpt(values, 'min-task-success-rate'),
  }
  const base = loadRun(baseFile)
  const candidate = loadRun(candFile)
  const verdict = gate(base, candidate, budget)
  process.stdout.write(json ? JSON.stringify(verdict, null, 2) + '\n' : renderGateMarkdown(base, candidate, verdict) + '\n')
  return verdict.decision === 'pass' ? 0 : 1
}

/** CLI entry; returns the process exit code. */
export function main(argv: string[]): number {
  let values: Record<string, unknown>
  let positionals: string[]
  try {
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        help: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        base: { type: 'string' },
        candidate: { type: 'string' },
        'max-cost-increase-pct': { type: 'string' },
        'max-quality-drop-pct': { type: 'string' },
        'max-tokens-per-success-increase-pct': { type: 'string' },
        'min-task-success-rate': { type: 'string' },
      },
    })
    values = parsed.values
    positionals = parsed.positionals
  } catch (err) {
    fail(`${(err as Error).message}\n${usage()}`)
  }
  if (values.help === true) {
    process.stdout.write(usage())
    return 0
  }
  const cmd = positionals[0]
  if (cmd === 'report') return runReport(positionals.slice(1), values.json === true)
  if (cmd === 'gate') return runGate(values, values.json === true)
  fail(`unknown command "${cmd ?? ''}"\n${usage()}`)
}

if (process.argv[1] && process.argv[1].endsWith('cli.js')) {
  process.exitCode = main(process.argv.slice(2))
}
