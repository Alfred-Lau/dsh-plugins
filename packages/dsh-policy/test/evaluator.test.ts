import test from 'node:test'
import assert from 'node:assert/strict'
import { PolicyEvaluator } from '../lib/evaluator.js'
import type { PolicyConfig } from '../lib/types.js'

const cfg = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({
  enabled: true,
  rules: [
    { id: 'deny-dangerous', effect: 'deny', priority: 100, tools: ['bash'], commands: ['rm\\s+-rf\\s+/(?!tmp|var/folders)'] },
    { id: 'deny-secrets', effect: 'deny', priority: 90, paths: ['/root/.ssh/**', '/etc/**', '**/.env'] },
    { id: 'allow-dev', effect: 'allow', priority: 50, tools: ['bash'], commands: ['^(git|pnpm|npm|node|pytest)\\b'] },
    { id: 'ask-writes', effect: 'ask', tools: ['write_file', 'edit_*'] },
  ],
  defaultDecision: 'ask',
  failClosed: true,
  ...over,
})

test('deny: dangerous command on bash', () => {
  const e = new PolicyEvaluator(cfg())
  const d = e.evaluate({ tool: 'bash', args: { command: 'rm -rf /' } })
  assert.equal(d.decision, 'deny')
  assert.equal(d.ruleId, 'deny-dangerous')
})

test('deny: secret paths regardless of tool', () => {
  const e = new PolicyEvaluator(cfg())
  assert.equal(e.evaluate({ tool: 'read_file', args: { file_path: '/root/.ssh/id_rsa' } }).decision, 'deny')
  assert.equal(e.evaluate({ tool: 'bash', args: { command: 'cat /etc/passwd' } }).ruleId, 'deny-secrets')
  assert.equal(e.evaluate({ tool: 'bash', args: { path: 'work/.env' } }).ruleId, 'deny-secrets')
})

test('allow: dev commands beat the default via priority', () => {
  const e = new PolicyEvaluator(cfg())
  const d = e.evaluate({ tool: 'bash', args: { command: 'git status' } })
  assert.equal(d.decision, 'allow')
  assert.equal(d.ruleId, 'allow-dev')
})

test('rm -rf ./local does NOT trigger the absolute-root deny', () => {
  const e = new PolicyEvaluator(cfg())
  const d = e.evaluate({ tool: 'bash', args: { command: 'rm -rf ./build' } })
  assert.notEqual(d.ruleId, 'deny-dangerous')
})

test('ask: unmatched write tools fall to the ask rule, then default', () => {
  const e = new PolicyEvaluator(cfg())
  assert.equal(e.evaluate({ tool: 'write_file', args: { path: 'notes.md' } }).ruleId, 'ask-writes')
  assert.equal(e.evaluate({ tool: 'edit_file', args: {} }).ruleId, 'ask-writes')
  const noAsk = new PolicyEvaluator(cfg({ rules: cfg().rules.filter((r) => r.id !== 'ask-writes') }))
  const d = noAsk.evaluate({ tool: 'read_file', args: { path: 'notes.md' } })
  assert.equal(d.decision, 'ask')
  assert.ok(d.reason?.includes('no rule matched'))
})

test('first-match-wins within equal priority keeps declaration order', () => {
  const e = new PolicyEvaluator(cfg({
    rules: [
      { id: 'first-allow', effect: 'allow', tools: ['bash'] },
      { id: 'then-deny', effect: 'deny', tools: ['bash'] },
    ],
  }))
  assert.equal(e.evaluate({ tool: 'bash' }).ruleId, 'first-allow')
})

test('higher priority overrides declaration order', () => {
  const e = new PolicyEvaluator(cfg({
    rules: [
      { id: 'later-but-stronger', effect: 'deny', priority: 10, tools: ['bash'] },
      { id: 'earlier-weak', effect: 'allow', tools: ['bash'] },
    ],
  }))
  assert.equal(e.evaluate({ tool: 'bash' }).ruleId, 'later-but-stronger')
})

test('fail-closed: evaluator errors deny the call', () => {
  const e = new PolicyEvaluator(cfg())
  const poisonedArgs = {}
  Object.defineProperty(poisonedArgs, 'command', {
    get() { throw new Error('boom') },
    enumerable: true,
  })
  const d = e.evaluate({ tool: 'bash', args: poisonedArgs })
  assert.equal(d.decision, 'deny')
  assert.ok(d.reason?.includes('fail-closed'))
})

test('fail-open: evaluator errors fall back to default decision', () => {
  const e = new PolicyEvaluator(cfg({ failClosed: false, defaultDecision: 'allow' }))
  const poisonedArgs = {}
  Object.defineProperty(poisonedArgs, 'command', {
    get() { throw new Error('boom') },
    enumerable: true,
  })
  assert.equal(e.evaluate({ tool: 'bash', args: poisonedArgs }).decision, 'allow')
})

test('invalid regex in rules fails loud at load', () => {
  assert.throws(() => new PolicyEvaluator(cfg({ rules: [{ id: 'bad', effect: 'deny', commands: ['([unclosed'] }] })))
})

test('invalid effect fails loud at load', () => {
  assert.throws(() => new PolicyEvaluator(cfg({ rules: [{ id: 'weird', effect: 'maybe' as never }] })))
})
