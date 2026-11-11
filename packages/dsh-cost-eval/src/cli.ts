#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { loadRun } from './normalize.js'
import { evaluate } from './evaluate.js'
import { gate } from './gate.js'
import { renderGateMarkdown, renderReportMarkdown, renderTicketReportMarkdown } from './render.js'
import { aggregateTickets, extractSpans, DEFAULT_PRICING } from './tickets.js'
import { readFileSync } from 'node:fs'
import type { GateBudget } from './types.js'
import type { PricingTable } from './tickets.js'

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

  dsh-cost-eval tickets <spans.json> [--budget-usd 5] [--pricing prices.json] [--json]
      Roll a dsh-trace span batch up per dsh-superagent ticket (dsh.ticket.id).
      Accepts a raw span array, { spans: [...] }, an OTLP/JSON envelope, or a
      CloudEvents array. --budget-usd gates every ticket; exits 1 if any ticket
      exceeds it, 2 on usage or parse errors.
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

function loadPricing(path: string | undefined): PricingTable {
  if (!path) return DEFAULT_PRICING
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    fail(`cannot read pricing table ${path}: ${(err as Error).message}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(`pricing table ${path} must be a JSON object of { model: { input, output, cacheRead? } }`)
  }
  return parsed as PricingTable
}

function runTickets(file: string | undefined, values: Record<string, unknown>, json: boolean): number {
  if (!file) fail('tickets needs a span batch file\n' + usage())
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    fail(`cannot read ${file}: ${(err as Error).message}`)
  }
  const spans = extractSpans(raw)
  if (spans.length === 0) fail(`${file}: no spans found (expected a span array, { spans }, OTLP, or CloudEvents)`)
  const report = aggregateTickets(spans, loadPricing(values.pricing as string | undefined), numOpt(values, 'budget-usd'))
  process.stdout.write(
    json ? JSON.stringify(report, null, 2) + '\n' : renderTicketReportMarkdown(report, file) + '\n',
  )
  if (report.budgetUsd !== undefined && report.overBudget.length > 0) return 1
  return 0
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
        'budget-usd': { type: 'string' },
        pricing: { type: 'string' },
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
  if (cmd === 'tickets') return runTickets(positionals[1], values, values.json === true)
  fail(`unknown command "${cmd ?? ''}"\n${usage()}`)
}

if (process.argv[1] && process.argv[1].endsWith('cli.js')) {
  process.exitCode = main(process.argv.slice(2))
}
