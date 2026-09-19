import { readFileSync } from 'node:fs'
import { InvalidRunError } from './types.js'
import type { NormalizedRun, QualitySource, TrialView } from './types.js'

type Dict = Record<string, unknown>

function asDict(v: unknown): Dict | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : null
}

function numOf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function boolOf(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

function strOf(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v : fallback
}

function readTrial(raw: unknown): TrialView {
  const d = asDict(raw)
  if (!d) {
    return {
      caseId: 'unknown',
      trial: 0,
      status: 'unknown',
      costUsd: null,
      totalTokens: null,
      latencyMs: null,
      taskSuccess: null,
      toolSelectionAccuracy: null,
      finalAnswerScore: null,
      hallucination: null,
    }
  }
  const metrics = asDict(d.metrics)
  const tokens = asDict(metrics?.tokens)
  const grade = asDict(d.grade)
  const judge = asDict(d.judge)
  const status = d.status === 'completed' || d.status === 'error' ? d.status : 'unknown'
  return {
    caseId: strOf(d.caseId, 'unknown'),
    trial: numOf(d.trial) ?? 0,
    status,
    costUsd: numOf(metrics?.costUsd),
    totalTokens: numOf(metrics?.totalTokens),
    latencyMs: numOf(metrics?.latencyMs),
    taskSuccess: boolOf(grade?.taskSuccess),
    toolSelectionAccuracy: boolOf(grade?.toolSelectionAccuracy),
    finalAnswerScore: numOf(judge?.finalAnswerScore),
    hallucination: boolOf(judge?.hallucination),
  }
}

function sumTrials(trials: TrialView[], pick: (t: TrialView) => number | null): number | null {
  let sawValue = false
  let total = 0
  for (const t of trials) {
    const v = pick(t)
    if (v !== null) {
      sawValue = true
      total += v
    }
  }
  return sawValue ? total : null
}

function meanOf(vals: (number | null)[]): number | null {
  const xs = vals.filter((v): v is number => v !== null)
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

function pooledRate(vals: (boolean | null)[]): number | null {
  const xs = vals.filter((v): v is boolean => v !== null)
  return xs.length ? xs.filter(Boolean).length / xs.length : null
}

function sumTokensFromBuckets(trials: TrialView[]): number | null {
  let sawValue = false
  let total = 0
  for (const t of trials) {
    if (t.totalTokens !== null) {
      sawValue = true
      total += t.totalTokens
    }
  }
  return sawValue ? total : null
}

/**
 * Parses and normalizes one dsh-eval run record. `label` is surfaced in
 * reports (usually the file path). Throws `InvalidRunError` when the input
 * is not a JSON object; every missing field degrades to `null` instead.
 */
export function normalizeRun(raw: unknown, label: string): NormalizedRun {
  const d = asDict(raw)
  if (!d) {
    throw new InvalidRunError('run record is not a JSON object', label)
  }

  const casesRaw = Array.isArray(d.cases) ? d.cases : []
  const trials = casesRaw.map(readTrial)
  const completed = trials.filter((t) => t.status === 'completed')
  const aggregate = asDict(d.aggregate)
  const grading = asDict(d.grading)
  const judgeCfg = asDict(d.judge)

  // Pooled signals: dsh-eval persists them in `grading`, but computing a
  // fallback from the trials keeps scoring alive for records without one.
  const meanJudgeScore = numOf(grading?.finalAnswerScore) ?? meanOf(trials.map((t) => t.finalAnswerScore))
  const taskSuccessRate = numOf(grading?.taskSuccessRate) ?? pooledRate(trials.map((t) => t.taskSuccess))
  const toolSelectionAccuracyRate =
    numOf(grading?.toolSelectionAccuracyRate) ?? pooledRate(trials.map((t) => t.toolSelectionAccuracy))
  const judgeMaxScore = numOf(judgeCfg?.maxScore) ?? 10

  let quality: number | null = null
  let qualitySource: QualitySource = 'none'
  if (taskSuccessRate !== null) {
    quality = taskSuccessRate
    qualitySource = 'taskSuccessRate'
  } else if (meanJudgeScore !== null) {
    quality = judgeMaxScore > 0 ? Math.min(1, Math.max(0, meanJudgeScore / judgeMaxScore)) : null
    qualitySource = quality === null ? 'none' : 'finalAnswerScore'
  } else if (toolSelectionAccuracyRate !== null) {
    quality = toolSelectionAccuracyRate
    qualitySource = 'toolSelectionAccuracyRate'
  }

  // Cost/tokens: prefer summing per-trial values (survives future mean
  // changes), fall back to the run aggregate, else null.
  const totalCostUsd = sumTrials(trials, (t) => t.costUsd) ?? numOf(aggregate?.costUsd)
  const totalTokens = sumTokensFromBuckets(trials) ?? numOf(aggregate?.totalTokens)
  const totalLatencyMs = sumTrials(trials, (t) => t.latencyMs) ?? numOf(aggregate?.latencyMs)

  const gradedTrials = trials.filter((t) => t.taskSuccess !== null)
  const successfulTrials = gradedTrials.length
    ? trials.filter((t) => t.taskSuccess === true).length
    : null

  return {
    label,
    benchmark: strOf(d.benchmark, 'unknown'),
    model: strOf(d.model, 'unknown'),
    createdAt: numOf(d.createdAt),
    trialsPlanned: numOf(d.trials),
    completedCount: completed.length,
    errorCount: trials.length - completed.length,
    caseCount: trials.length,
    trials,
    successfulTrials,
    taskSuccessRate,
    meanJudgeScore,
    judgeMaxScore,
    toolSelectionAccuracyRate,
    quality,
    qualitySource,
    totalCostUsd,
    totalTokens,
    totalLatencyMs,
  }
}

/** Reads and parses a run record from disk. */
export function loadRun(path: string): NormalizedRun {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new InvalidRunError(`cannot read file (${(err as Error).message})`, path)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new InvalidRunError(`invalid JSON (${(err as Error).message})`, path)
  }
  return normalizeRun(raw, path)
}
