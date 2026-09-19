import test from 'node:test'
import assert from 'node:assert/strict'
import { gate } from '../lib/gate.js'
import { normalizeRun } from '../lib/normalize.js'
import { evalRunFixture } from './normalize.test.ts'

function gradedRun(label: string, model: string, cost: number, tokens: number, successRate: number) {
  const trials = Math.round(2 / Math.max(successRate, 0.5)) // keep counts sane
  return normalizeRun(
    evalRunFixture({
      model,
      trials: [
        { caseId: `${label}-a`, costUsd: cost / 2, totalTokens: tokens / 2, taskSuccess: successRate > 0.5 },
        { caseId: `${label}-b`, costUsd: cost / 2, totalTokens: tokens / 2, taskSuccess: successRate > 0.5 },
        ...(trials > 2 ? [{ caseId: `${label}-c`, costUsd: 0, totalTokens: 0, taskSuccess: successRate > 0.5 }] : []),
      ],
      grading: { taskSuccessRate: successRate, toolSelectionAccuracyRate: null, finalAnswerScore: null, hallucinationRate: null },
    }),
    label,
  )
}

test('gate fails when cost exceeds the increase budget', () => {
  const base = gradedRun('base', 'deepseek-lite', 0.04, 2000, 1)
  const cand = gradedRun('cand', 'deepseek-v4', 0.05, 2000, 1)
  const verdict = gate(base, cand, { maxCostIncreasePct: 20 })
  assert.equal(verdict.decision, 'fail')
  assert.match(verdict.reasons.join(' '), /cost increased 25%/)
  const costCheck = verdict.checks.find((c) => c.name === 'costIncrease')
  assert.equal(costCheck?.passed, false)
})

test('gate fails when quality drops beyond the budget', () => {
  const base = gradedRun('base', 'deepseek-v4', 0.05, 2000, 1)
  const cand = gradedRun('cand', 'deepseek-lite', 0.04, 2000, 0)
  const verdict = gate(base, cand, {})
  assert.equal(verdict.decision, 'fail')
  assert.match(verdict.reasons.join(' '), /quality dropped/)
})

test('gate enforces the absolute task-success floor', () => {
  const base = gradedRun('base', 'deepseek-v4', 0.05, 2000, 1)
  const cand = gradedRun('cand', 'deepseek-lite', 0.02, 2000, 0)
  const verdict = gate(base, cand, { minTaskSuccessRate: 0.8 })
  assert.equal(verdict.decision, 'fail')
  assert.match(verdict.reasons.join(' '), /below floor 0.8/)
})

test('gate passes with explicit unverifiable reasons when data is missing', () => {
  const base = normalizeRun(evalRunFixture({ trials: [{ caseId: 'a', totalTokens: 500 }] }), 'base')
  const cand = normalizeRun(evalRunFixture({ trials: [{ caseId: 'a', totalTokens: 400 }] }), 'cand')
  const verdict = gate(base, cand, { minTaskSuccessRate: 0.5 })
  assert.equal(verdict.decision, 'pass', 'unverifiable checks do not fail the release')
  const joined = verdict.reasons.join(' ')
  assert.match(joined, /cost increase unverifiable/)
  assert.match(joined, /quality drop unverifiable/)
  assert.match(joined, /tokens-per-success unverifiable/)
  assert.match(joined, /task-success floor unverifiable/)
  assert.ok(verdict.checks.every((c) => c.passed === null))
})

test('gate passes when every verifiable check is green', () => {
  const base = gradedRun('base', 'deepseek-v4', 0.05, 2000, 1)
  const cand = gradedRun('cand', 'deepseek-lite', 0.04, 1800, 1)
  const verdict = gate(base, cand, { minTaskSuccessRate: 0.9 })
  assert.equal(verdict.decision, 'pass')
  assert.match(verdict.reasons[0]!, /all verifiable checks passed/)
})

test('gate treats a zero-cost base with priced candidate as an infinite increase', () => {
  const base = gradedRun('base', 'deepseek-lite', 0, 1000, 1)
  const cand = gradedRun('cand', 'deepseek-v4', 0.03, 1000, 1)
  const verdict = gate(base, cand, { maxCostIncreasePct: 20 })
  assert.equal(verdict.decision, 'fail')
  const costCheck = verdict.checks.find((c) => c.name === 'costIncrease')
  assert.equal(costCheck?.passed, false)
})
