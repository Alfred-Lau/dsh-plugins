import type { CostReport, CostReportEntry, NormalizedRun } from './types.js'

function perTrial(run: NormalizedRun, total: number | null): number | null {
  if (total === null) return null
  const denom = run.completedCount > 0 ? run.completedCount : run.caseCount
  return denom > 0 ? total / denom : null
}

/** Folds one run into quality x cost entries. Pure; never throws on nulls. */
export function evaluateRun(run: NormalizedRun): CostReportEntry {
  const successes = run.successfulTrials
  const costPerSuccess = run.totalCostUsd !== null && successes !== null && successes > 0
    ? run.totalCostUsd / successes
    : null
  const tokensPerSuccess = run.totalTokens !== null && successes !== null && successes > 0
    ? run.totalTokens / successes
    : null
  return {
    run,
    costPerSuccess,
    tokensPerSuccess,
    costPerTrial: perTrial(run, run.totalCostUsd),
    tokensPerTrial: perTrial(run, run.totalTokens),
    meanLatencyMs: perTrial(run, run.totalLatencyMs),
  }
}

function rankKey(e: CostReportEntry): [number, number, string] {
  // Rank unmeasured runs last at every level.
  const q = e.run.quality === null ? -1 : e.run.quality
  const c = e.costPerSuccess === null ? Number.POSITIVE_INFINITY : e.costPerSuccess
  return [-q, c, e.run.label]
}

/** Builds the cost-effectiveness report over 1..N runs. */
export function evaluate(runs: NormalizedRun[]): CostReport {
  const entries = runs.map(evaluateRun)
  const ranked = [...entries].sort((a, b) => {
    const ka = rankKey(a)
    const kb = rankKey(b)
    return ka[0] !== kb[0] ? ka[0] - kb[0] : ka[1] !== kb[1] ? ka[1] - kb[1] : ka[2].localeCompare(kb[2])
  })
  return { entries, ranked }
}
