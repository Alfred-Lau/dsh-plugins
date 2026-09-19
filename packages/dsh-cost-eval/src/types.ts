/**
 * Normalized view over a dsh-eval run record (the `EvalRun` JSON written by
 * `dsh eval run --out run.json`). Parsing is defensive: dsh-eval evolves and
 * older/newer records may miss fields — everything optional is `null`, never
 * guessed, so reports can mark gaps as `n/a` instead of lying.
 */

export interface TrialTokens {
  inputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  outputTokens: number | null
}

export interface TrialView {
  caseId: string
  trial: number
  status: 'completed' | 'error' | 'unknown'
  costUsd: number | null
  totalTokens: number | null
  latencyMs: number | null
  taskSuccess: boolean | null
  toolSelectionAccuracy: boolean | null
  finalAnswerScore: number | null
  hallucination: boolean | null
}

export type QualitySource =
  | 'taskSuccessRate'
  | 'finalAnswerScore'
  | 'toolSelectionAccuracyRate'
  | 'none'

/** A dsh-eval run record folded into the fields this package computes on. */
export interface NormalizedRun {
  /** File path the record was read from (or the provided label). */
  label: string
  benchmark: string
  model: string
  createdAt: number | null
  trialsPlanned: number | null
  /** Trials with status `completed`, whether or not they carry metrics. */
  completedCount: number
  errorCount: number
  caseCount: number
  trials: TrialView[]
  successfulTrials: number | null
  taskSuccessRate: number | null
  meanJudgeScore: number | null
  judgeMaxScore: number
  toolSelectionAccuracyRate: number | null
  /** First available quality signal in [0, 1]. */
  quality: number | null
  qualitySource: QualitySource
  totalCostUsd: number | null
  totalTokens: number | null
  totalLatencyMs: number | null
}

export interface CostReportEntry {
  run: NormalizedRun
  /** USD per successful task, or null without pricing/grading. */
  costPerSuccess: number | null
  /** Tokens per successful task, or null without grading. */
  tokensPerSuccess: number | null
  costPerTrial: number | null
  tokensPerTrial: number | null
  meanLatencyMs: number | null
}

export interface CostReport {
  entries: CostReportEntry[]
  /** `entries` sorted by quality desc, then cost-per-success asc, then label. */
  ranked: CostReportEntry[]
}

export interface GateBudget {
  /** Max allowed % increase in total run cost. Default 20. */
  maxCostIncreasePct?: number
  /** Max allowed % drop in quality. Default 10. */
  maxQualityDropPct?: number
  /** Absolute floor for the candidate's task-success rate. */
  minTaskSuccessRate?: number
  /** Max allowed % increase in tokens-per-success. Default 25. */
  maxTokensPerSuccessIncreasePct?: number
}

export interface GateCheck {
  name: string
  base: number | null
  candidate: number | null
  limit: number | null
  /** true/false decided; null = unverifiable (missing data). */
  passed: boolean | null
}

export interface GateVerdict {
  decision: 'pass' | 'fail'
  reasons: string[]
  checks: GateCheck[]
}

/** Thrown when a file is not a JSON object shaped like a run record. */
export class InvalidRunError extends Error {
  constructor(
    message: string,
    readonly label: string,
  ) {
    super(`${label}: ${message}`)
    this.name = 'InvalidRunError'
  }
}
