import type { GateBudget, GateCheck, GateVerdict, NormalizedRun } from './types.js'

interface Side {
  quality: number | null
  taskSuccessRate: number | null
  totalCostUsd: number | null
  tokensPerSuccess: number | null
}

function side(run: NormalizedRun): Side {
  const successes = run.successfulTrials
  const tokensPerSuccess = run.totalTokens !== null && successes !== null && successes > 0
    ? run.totalTokens / successes
    : null
  return {
    quality: run.quality,
    taskSuccessRate: run.taskSuccessRate,
    totalCostUsd: run.totalCostUsd,
    tokensPerSuccess,
  }
}

function pctIncrease(base: number, cand: number): number {
  if (base === 0) return cand === 0 ? 0 : Number.POSITIVE_INFINITY
  return ((cand - base) / Math.abs(base)) * 100
}

function pctDrop(base: number, cand: number): number {
  if (base === 0) return cand === 0 ? 0 : Number.POSITIVE_INFINITY
  return ((base - cand) / Math.abs(base)) * 100
}

function fmt(v: number | null): string {
  return v === null ? 'n/a' : String(Math.round(v * 100) / 100)
}

/**
 * Compares a candidate run against a base run under a cost budget.
 *
 * Decision policy: a check only fails when both sides carry data and the
 * limit is breached. Missing data yields `passed: null` plus an explicit
 * reason — the gate never silently pretends a number existed, but it also
 * never fails a release just because one metric was unmeasured.
 */
export function gate(baseRun: NormalizedRun, candidateRun: NormalizedRun, budget: GateBudget = {}): GateVerdict {
  const maxCostIncreasePct = budget.maxCostIncreasePct ?? 20
  const maxQualityDropPct = budget.maxQualityDropPct ?? 10
  const maxTokensPerSuccessIncreasePct = budget.maxTokensPerSuccessIncreasePct ?? 25

  const base = side(baseRun)
  const cand = side(candidateRun)
  const checks: GateCheck[] = []
  const reasons: string[] = []

  // 1. Total cost increase.
  if (base.totalCostUsd === null || cand.totalCostUsd === null) {
    checks.push({ name: 'costIncrease', base: base.totalCostUsd, candidate: cand.totalCostUsd, limit: maxCostIncreasePct, passed: null })
    reasons.push('cost increase unverifiable: one run lacks costUsd (no pricing?)')
  } else {
    const delta = pctIncrease(base.totalCostUsd, cand.totalCostUsd)
    const passed = delta <= maxCostIncreasePct
    checks.push({ name: 'costIncrease', base: base.totalCostUsd, candidate: cand.totalCostUsd, limit: maxCostIncreasePct, passed })
    if (!passed) {
      reasons.push(
        `cost increased ${fmt(delta)}% (base $${fmt(base.totalCostUsd)} -> candidate $${fmt(cand.totalCostUsd)}), limit ${maxCostIncreasePct}%`,
      )
    }
  }

  // 2. Quality drop.
  if (base.quality === null || cand.quality === null) {
    checks.push({ name: 'qualityDrop', base: base.quality, candidate: cand.quality, limit: maxQualityDropPct, passed: null })
    reasons.push(`quality drop unverifiable: no quality signal (source base=${baseRun.qualitySource}, candidate=${candidateRun.qualitySource})`)
  } else {
    const delta = pctDrop(base.quality, cand.quality)
    const passed = delta <= maxQualityDropPct
    checks.push({ name: 'qualityDrop', base: base.quality, candidate: cand.quality, limit: maxQualityDropPct, passed })
    if (!passed) {
      reasons.push(
        `quality dropped ${fmt(delta)}% (base ${fmt(base.quality)} -> candidate ${fmt(cand.quality)}), limit ${maxQualityDropPct}%`,
      )
    }
  }

  // 3. Absolute task-success floor.
  if (budget.minTaskSuccessRate === undefined) {
    // Not configured — skip entirely.
  } else if (cand.taskSuccessRate === null) {
    checks.push({ name: 'minTaskSuccessRate', base: base.taskSuccessRate, candidate: cand.taskSuccessRate, limit: budget.minTaskSuccessRate, passed: null })
    reasons.push('task-success floor unverifiable: candidate run has no grading.taskSuccessRate')
  } else {
    const passed = cand.taskSuccessRate >= budget.minTaskSuccessRate
    checks.push({ name: 'minTaskSuccessRate', base: base.taskSuccessRate, candidate: cand.taskSuccessRate, limit: budget.minTaskSuccessRate, passed })
    if (!passed) {
      reasons.push(`task success rate ${fmt(cand.taskSuccessRate)} below floor ${budget.minTaskSuccessRate}`)
    }
  }

  // 4. Tokens-per-success increase (cost proxy when pricing is absent).
  if (base.tokensPerSuccess === null || cand.tokensPerSuccess === null) {
    checks.push({ name: 'tokensPerSuccessIncrease', base: base.tokensPerSuccess, candidate: cand.tokensPerSuccess, limit: maxTokensPerSuccessIncreasePct, passed: null })
    reasons.push('tokens-per-success unverifiable: need token totals and graded successes on both runs')
  } else {
    const delta = pctIncrease(base.tokensPerSuccess, cand.tokensPerSuccess)
    const passed = delta <= maxTokensPerSuccessIncreasePct
    checks.push({ name: 'tokensPerSuccessIncrease', base: base.tokensPerSuccess, candidate: cand.tokensPerSuccess, limit: maxTokensPerSuccessIncreasePct, passed })
    if (!passed) {
      reasons.push(
        `tokens/success increased ${fmt(delta)}% (base ${fmt(base.tokensPerSuccess)} -> candidate ${fmt(cand.tokensPerSuccess)}), limit ${maxTokensPerSuccessIncreasePct}%`,
      )
    }
  }

  const failed = checks.some((c) => c.passed === false)
  const decision: GateVerdict['decision'] = failed ? 'fail' : 'pass'
  if (!failed) {
    reasons.unshift('all verifiable checks passed')
  }
  return { decision, reasons, checks }
}
