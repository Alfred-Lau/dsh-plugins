import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evalRunFixture } from './normalize.test.ts'

const CLI = join(import.meta.dirname, '..', 'lib', 'cli.js')

function writeRun(dir: string, name: string, model: string, cost: number, successRate: number): string {
  const p = join(dir, name)
  writeFileSync(
    p,
    JSON.stringify(
      evalRunFixture({
        model,
        trials: [
          { caseId: 'a', costUsd: cost / 2, totalTokens: 1000, taskSuccess: successRate > 0.5 },
          { caseId: 'b', costUsd: cost / 2, totalTokens: 1000, taskSuccess: successRate > 0.5 },
        ],
        grading: { taskSuccessRate: successRate, toolSelectionAccuracyRate: null, finalAnswerScore: null, hallucinationRate: null },
      }),
    ),
  )
  return p
}

test('cli report --json ranks two runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cost-eval-cli-'))
  const strong = writeRun(dir, 'strong.json', 'deepseek-v4', 0.04, 1)
  const weak = writeRun(dir, 'weak.json', 'deepseek-lite', 0.01, 0)
  const res = spawnSync(process.execPath, [CLI, 'report', weak, strong, '--json'], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const report = JSON.parse(res.stdout)
  assert.equal(report.ranked[0].run.label, strong)
  assert.equal(report.ranked[1].run.label, weak)
  assert.equal(report.ranked[0].costPerSuccess, 0.02)
})

test('cli report renders markdown table by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cost-eval-cli-'))
  const run = writeRun(dir, 'only.json', 'deepseek-v4', 0.04, 1)
  const res = spawnSync(process.execPath, [CLI, 'report', run], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  assert.match(res.stdout, /## dsh-cost-eval report/)
  assert.match(res.stdout, /\| 1 \|/)
  assert.match(res.stdout, /deepseek-v4/)
})

test('cli gate exits 1 on fail and 0 on pass, with --json verdicts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cost-eval-cli-'))
  const base = writeRun(dir, 'base.json', 'deepseek-v4', 0.04, 1)
  const bad = writeRun(dir, 'bad.json', 'deepseek-lite', 0.06, 0)
  const good = writeRun(dir, 'good.json', 'deepseek-lite', 0.04, 1)

  const failRes = spawnSync(process.execPath, [CLI, 'gate', '--base', base, '--candidate', bad, '--min-task-success-rate', '0.9', '--json'], { encoding: 'utf8' })
  assert.equal(failRes.status, 1, failRes.stderr)
  const failVerdict = JSON.parse(failRes.stdout)
  assert.equal(failVerdict.decision, 'fail')
  assert.ok(failVerdict.checks.length >= 4)

  const passRes = spawnSync(process.execPath, [CLI, 'gate', '--base', base, '--candidate', good, '--min-task-success-rate', '0.9', '--json'], { encoding: 'utf8' })
  assert.equal(passRes.status, 0, passRes.stderr)
  assert.equal(JSON.parse(passRes.stdout).decision, 'pass')
})

test('cli exits 2 on bad input and prints usage on --help', () => {
  const res = spawnSync(process.execPath, [CLI, 'gate'], { encoding: 'utf8' })
  assert.equal(res.status, 2)
  assert.match(res.stderr, /gate needs --base/)

  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage:/)

  const unknown = spawnSync(process.execPath, [CLI, 'frobnicate'], { encoding: 'utf8' })
  assert.equal(unknown.status, 2)
})
