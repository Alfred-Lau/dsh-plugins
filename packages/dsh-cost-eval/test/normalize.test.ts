import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRun, normalizeRun } from '../lib/normalize.js'
import { InvalidRunError } from '../lib/types.js'

/**
 * Builds a raw payload shaped like a dsh-eval `EvalRun` record (see the
 * dsh-eval 0.3 type surface: `cases[]` of trial results with
 * `metrics`/`grade`/`judge`, plus pooled `aggregate` and `grading`).
 */
export function evalRunFixture(opts: {
  model?: string
  trials?: {
    caseId?: string
    status?: 'completed' | 'error'
    costUsd?: number
    totalTokens?: number
    latencyMs?: number
    taskSuccess?: boolean | null
    toolSelectionAccuracy?: boolean | null
    finalAnswerScore?: number | null
  }[]
  grading?: Record<string, unknown> | null
  judgeMax?: number
  aggregate?: Record<string, unknown> | null
}): unknown {
  return {
    benchmark: 'skill-regression',
    model: opts.model ?? 'deepseek-v4',
    createdAt: 1_758_240_000_000,
    trials: 2,
    seed: 42,
    pricing: null,
    tempRoot: '/tmp/run-1',
    cases: (opts.trials ?? []).map((t, i) => ({
      caseId: t.caseId ?? `case-${i + 1}`,
      trial: 1,
      status: t.status ?? 'completed',
      exitCode: 0,
      timedOut: false,
      ...(t.status === 'error'
        ? { error: 'child exited 1' }
        : {
            ...(t.costUsd === undefined && t.totalTokens === undefined && t.latencyMs === undefined
              ? {}
              : {
                  metrics: {
                    turns: 3,
                    steps: 5,
                    toolCalls: 4,
                    toolResults: 4,
                    toolSuccess: 4,
                    toolSuccessRate: 1,
                    invalidToolCalls: 0,
                    retries: 0,
                    tokens: { inputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 },
                    totalTokens: t.totalTokens ?? null,
                    contextTokens: 10,
                    llmMs: 900,
                    toolMs: 100,
                    ttftMs: 120,
                    latencyMs: t.latencyMs ?? null,
                    costUsd: t.costUsd ?? null,
                  },
                }),
            ...(t.taskSuccess === undefined && t.toolSelectionAccuracy === undefined
              ? {}
              : { grade: { taskSuccess: t.taskSuccess ?? null, toolSelectionAccuracy: t.toolSelectionAccuracy ?? null } }),
            ...(t.finalAnswerScore === undefined ? {} : { judge: { finalAnswerScore: t.finalAnswerScore, hallucination: false } }),
          }),
    })),
    aggregate: opts.aggregate === undefined ? null : opts.aggregate,
    grading: opts.grading === undefined ? null : opts.grading,
    ...(opts.judgeMax === undefined ? {} : { judge: { provider: 'deepseek', model: 'deepseek-v4', maxScore: opts.judgeMax } }),
  }
}

test('normalizeRun folds a fully-populated run record', () => {
  const raw = evalRunFixture({
    trials: [
      { caseId: 'a', costUsd: 0.03, totalTokens: 1500, latencyMs: 1200, taskSuccess: true },
      { caseId: 'b', costUsd: 0.01, totalTokens: 500, latencyMs: 800, taskSuccess: false },
    ],
    grading: { taskSuccessRate: 0.5, toolSelectionAccuracyRate: 1, finalAnswerScore: null, hallucinationRate: 0 },
  })
  const run = normalizeRun(raw, 'base.json')
  assert.equal(run.benchmark, 'skill-regression')
  assert.equal(run.model, 'deepseek-v4')
  assert.equal(run.caseCount, 2)
  assert.equal(run.completedCount, 2)
  assert.equal(run.errorCount, 0)
  assert.equal(run.totalCostUsd, 0.04)
  assert.equal(run.totalTokens, 2000)
  assert.equal(run.totalLatencyMs, 2000)
  assert.equal(run.successfulTrials, 1)
  assert.equal(run.taskSuccessRate, 0.5)
  assert.equal(run.quality, 0.5)
  assert.equal(run.qualitySource, 'taskSuccessRate')
})

test('normalizeRun skips error trials in completed counts and keeps metrics null-safe', () => {
  const raw = evalRunFixture({
    trials: [
      { caseId: 'a', costUsd: 0.02, totalTokens: 100, taskSuccess: true },
      { caseId: 'b', status: 'error' },
    ],
    grading: { taskSuccessRate: 1, toolSelectionAccuracyRate: null, finalAnswerScore: null, hallucinationRate: null },
  })
  const run = normalizeRun(raw, 'r')
  assert.equal(run.completedCount, 1)
  assert.equal(run.errorCount, 1)
  assert.equal(run.totalCostUsd, 0.02)
  assert.equal(run.totalTokens, 100)
  assert.equal(run.successfulTrials, 1)
})

test('normalizeRun falls back to aggregate when trials carry no metrics', () => {
  const raw = evalRunFixture({
    trials: [{ caseId: 'a' }],
    aggregate: { costUsd: 0.5, totalTokens: 900, latencyMs: 4000 },
  })
  const run = normalizeRun(raw, 'r')
  assert.equal(run.totalCostUsd, 0.5)
  assert.equal(run.totalTokens, 900)
  assert.equal(run.totalLatencyMs, 4000)
})

test('normalizeRun derives quality from the judge score when grading is absent', () => {
  const raw = evalRunFixture({
    trials: [{ caseId: 'a', finalAnswerScore: 8 }],
    judgeMax: 10,
  })
  const run = normalizeRun(raw, 'r')
  assert.equal(run.meanJudgeScore, 8)
  assert.equal(run.judgeMaxScore, 10)
  assert.equal(run.quality, 0.8)
  assert.equal(run.qualitySource, 'finalAnswerScore')
  assert.equal(run.successfulTrials, null, 'no grading means no success count')
})

test('normalizeRun degrades missing fields to null and rejects non-objects', () => {
  const run = normalizeRun({}, 'empty.json')
  assert.equal(run.quality, null)
  assert.equal(run.qualitySource, 'none')
  assert.equal(run.totalCostUsd, null)
  assert.equal(run.model, 'unknown')
  assert.equal(run.caseCount, 0)

  assert.throws(() => normalizeRun([1, 2], 'arr.json'), InvalidRunError)
  assert.throws(() => normalizeRun('nope', 'str.json'), InvalidRunError)
})

test('loadRun reads a file and surfaces invalid JSON as InvalidRunError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cost-eval-'))
  const good = join(dir, 'good.json')
  writeFileSync(good, JSON.stringify(evalRunFixture({ trials: [{ caseId: 'a', taskSuccess: true }] })))
  const run = loadRun(good)
  assert.equal(run.label, good)
  assert.equal(run.completedCount, 1)

  const bad = join(dir, 'bad.json')
  writeFileSync(bad, '{not json')
  assert.throws(() => loadRun(bad), InvalidRunError)

  assert.throws(() => loadRun(join(dir, 'missing.json')), InvalidRunError)
})
