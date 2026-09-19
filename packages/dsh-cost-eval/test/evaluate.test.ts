import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluate } from '../lib/evaluate.js'
import { normalizeRun } from '../lib/normalize.js'
import { evalRunFixture } from './normalize.test.ts'

test('evaluate ranks by quality desc then cost-per-success asc', () => {
  const strong = normalizeRun(
    evalRunFixture({
      model: 'deepseek-v4',
      trials: [
        { caseId: 'a', costUsd: 0.03, totalTokens: 1500, taskSuccess: true },
        { caseId: 'b', costUsd: 0.01, totalTokens: 500, taskSuccess: true },
      ],
      grading: { taskSuccessRate: 1, toolSelectionAccuracyRate: null, finalAnswerScore: null, hallucinationRate: null },
    }),
    'strong.json',
  )
  const cheapButWeak = normalizeRun(
    evalRunFixture({
      model: 'deepseek-lite',
      trials: [{ caseId: 'a', costUsd: 0.004, totalTokens: 400, taskSuccess: false }],
      grading: { taskSuccessRate: 0, toolSelectionAccuracyRate: null, finalAnswerScore: null, hallucinationRate: null },
    }),
    'cheap.json',
  )
  const report = evaluate([cheapButWeak, strong])
  assert.equal(report.ranked[0]!.run.label, 'strong.json')
  assert.equal(report.ranked[1]!.run.label, 'cheap.json')

  const strongEntry = report.ranked[0]!
  assert.equal(strongEntry.costPerSuccess, 0.02, 'total 0.04 over 2 successes')
  assert.equal(strongEntry.tokensPerSuccess, 1000, 'total 2000 over 2 successes')
  assert.equal(strongEntry.costPerTrial, 0.02)
  assert.equal(strongEntry.meanLatencyMs, null, 'fixture omits latencyMs -> n/a')
})

test('evaluate places unmeasured runs last and reports null efficiency honestly', () => {
  const measured = normalizeRun(
    evalRunFixture({
      trials: [{ caseId: 'a', costUsd: 0.02, totalTokens: 800, taskSuccess: true }],
      grading: { taskSuccessRate: 1, toolSelectionAccuracyRate: null, finalAnswerScore: null, hallucinationRate: null },
    }),
    'measured.json',
  )
  const unmeasured = normalizeRun(evalRunFixture({ trials: [{ caseId: 'a' }] }), 'unmeasured.json')
  const report = evaluate([unmeasured, measured])
  assert.equal(report.ranked[0]!.run.label, 'measured.json')
  const last = report.ranked[1]!
  assert.equal(last.run.label, 'unmeasured.json')
  assert.equal(last.run.quality, null)
  assert.equal(last.costPerSuccess, null)
  assert.equal(last.tokensPerSuccess, null)
  assert.equal(last.run.successfulTrials, null)
})

test('evaluate treats a judge-scored run as a first-class quality source', () => {
  const judged = normalizeRun(
    evalRunFixture({
      trials: [{ caseId: 'a', finalAnswerScore: 9, costUsd: 0.05 }],
      judgeMax: 10,
    }),
    'judged.json',
  )
  const report = evaluate([judged])
  assert.equal(report.ranked[0]!.run.quality, 0.9)
  assert.equal(report.ranked[0]!.run.qualitySource, 'finalAnswerScore')
  assert.equal(report.ranked[0]!.costPerSuccess, null, 'no grading -> no cost-per-success')
})
