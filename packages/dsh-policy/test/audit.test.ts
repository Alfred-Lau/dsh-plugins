import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLogger } from '../lib/audit.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-policy-audit-'))
}

test('writes JSONL entries with ts and policy version', () => {
  const dir = tempDir()
  const audit = new AuditLogger({ enabled: true, file: join(dir, 'audit', 'audit.jsonl') }, dir)
  audit.log({ phase: 'decision', tool: 'bash', decision: 'deny', rule_id: 'r1' })
  audit.log({ phase: 'outcome', tool: 'bash', outcome: 'error: boom' })

  const raw = readFileSync(join(dir, 'audit', 'audit.jsonl'), 'utf8')
  const lines = raw.trim().split('\n')
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0]!)
  assert.equal(first.phase, 'decision')
  assert.equal(first.decision, 'deny')
  assert.ok(first.ts)
  assert.match(first.policy_version, /^dsh-policy@\d/)
})

test('hashArgs produces a stable short digest and never throws', () => {
  const audit = new AuditLogger({ enabled: false })
  const h1 = audit.hashArgs({ command: 'git status' })
  const h2 = audit.hashArgs({ command: 'git status' })
  assert.equal(h1, h2)
  assert.match(h1!, /^[0-9a-f]{16}$/)
  assert.equal(audit.hashArgs(undefined), undefined)
  const cyclic: Record<string, unknown> = {}
  cyclic['self'] = cyclic
  assert.equal(audit.hashArgs(cyclic), undefined)
})

test('rotates the file once it exceeds maxBytes', () => {
  const dir = tempDir()
  const file = join(dir, 'audit.jsonl')
  const audit = new AuditLogger({ enabled: true, file, maxBytes: 200 }, dir)
  for (let i = 0; i < 10; i++) audit.log({ phase: 'decision', tool: `tool-${i}`, decision: 'allow' })
  const files = readdirSync(dir).filter((f) => f.startsWith('audit.jsonl'))
  assert.ok(files.length >= 2, `expected rotated files, saw: ${files.join(', ')}`)
})

test('disabled logger writes nothing', () => {
  const dir = tempDir()
  const audit = new AuditLogger({ enabled: false, file: join(dir, 'audit.jsonl') }, dir)
  audit.log({ phase: 'decision', tool: 'bash', decision: 'allow' })
  assert.equal(existsSync(join(dir, 'audit.jsonl')), false)
  assert.equal(audit.path, undefined)
})
