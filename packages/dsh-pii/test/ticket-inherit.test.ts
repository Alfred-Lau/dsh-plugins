import test from 'node:test'
import assert from 'node:assert/strict'
import { attachPiiGate } from '../lib/adapter.js'
import { compileDetectors, PiiDetector } from '../lib/detector.js'
import { AuditLogger } from '../lib/audit.js'
import { makeTicketScope } from '../lib/ticket-scope.js'
import type { PiiConfig } from '../lib/types.js'

/**
 * Regression: schemastery fills an absent `outboundTools` on a per-ticket rule
 * with `[]`, not `undefined`. A rule that only sets `mode: 'block'` therefore
 * used to compile to an empty tool set, match nothing, and silently never
 * block. Empty must mean "inherit the global set".
 */

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} }

interface Listener {
  fn: (payload: unknown, next?: () => unknown) => unknown
}

function setup(config: PiiConfig): { fire: (payload: unknown) => unknown } {
  const listeners: Listener[] = []
  const ctx = {
    on(_event: string, fn: Listener) {
      listeners.push({ fn })
    },
    get() {
      return undefined
    },
  }
  const detector = new PiiDetector(compileDetectors({ ...config, logger: silentLogger } as never), config.maxScanChars)
  const audit = new AuditLogger({ enabled: false })
  const ticketScope = makeTicketScope(ctx, config.ticket)
  attachPiiGate(ctx as never, { config, detector, audit, logger: silentLogger as never, ...(ticketScope ? { ticketScope } : {}) })
  return { fire: (payload) => listeners[0]!.fn(payload, () => undefined) }
}

test('a ticket rule that only sets mode inherits the global outbound tool set', () => {
  const { fire } = setup({
    enabled: true,
    mode: 'audit',
    outboundTools: ['bash'],
    detectors: { email: true },
    ticket: { enabled: true, rules: [{ match: 't-1043', mode: 'block' }] },
    audit: { enabled: false },
  })
  const verdict = fire({
    tool: 'bash',
    args: { command: 'gh pr comment --body "bob@example.com"' },
    sessionId: 'worker-t-1043',
  }) as { decision?: string; ruleId?: string } | undefined
  assert.equal(verdict?.decision, 'deny')
  assert.equal(verdict?.ruleId, 'pii-block:ticket:t-1043')
})

test('an explicitly empty outboundTools list on a rule still inherits', () => {
  const { fire } = setup({
    enabled: true,
    mode: 'audit',
    outboundTools: ['bash'],
    detectors: { email: true },
    ticket: { enabled: true, rules: [{ match: 't-1043', mode: 'block', outboundTools: [] }] },
    audit: { enabled: false },
  })
  const verdict = fire({
    tool: 'bash',
    args: { command: 'gh pr comment --body "bob@example.com"' },
    sessionId: 'worker-t-1043',
  }) as { decision?: string } | undefined
  assert.equal(verdict?.decision, 'deny')
})

test('a rule that narrows outboundTools really does narrow them', () => {
  const { fire } = setup({
    enabled: true,
    mode: 'audit',
    outboundTools: ['bash', 'http*'],
    detectors: { email: true },
    ticket: { enabled: true, rules: [{ match: 't-1043', mode: 'block', outboundTools: ['http*'] }] },
    audit: { enabled: false },
  })
  const verdict = fire({
    tool: 'bash',
    args: { command: 'gh pr comment --body "bob@example.com"' },
    sessionId: 'worker-t-1043',
  }) as { decision?: string } | undefined
  assert.equal(verdict, undefined, "bash is outside this ticket's narrowed set")
})
