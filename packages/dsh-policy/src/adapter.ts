import type { LoggerService } from '@deepseek-ai/cordis'
import { PolicyEvaluator } from './evaluator.js'
import { AuditLogger } from './audit.js'
import { isRecord } from './util.js'
import type { ToolCallInput } from './types.js'
import type { TicketDenyVerdict } from './ticket-rules.js'

/**
 * Tool-pipeline adapter — the ONLY place that knows dsh's tool event names.
 *
 * dsh routes every model tool call through:
 *   model tool call -> tools/pre-execute -> permission/policy handling
 *                   -> tools/execute -> provider implementation
 *                   -> tools/post-execute -> durable tool result
 *
 * `tools/pre-execute` is a waterfall channel: a listener may return a
 * decision object that short-circuits execution. `tools/post-execute` fires
 * with the durable result and enriches the audit trail.
 *
 * Listeners are deliberately defensive: any unexpected payload shape is
 * ignored (the built-in approval chain keeps handling the call) — policy
 * plugins must never crash the harness hot path.
 */

export interface PolicyVerdict {
  decision: 'allow' | 'deny' | 'ask'
  reason?: string
  ruleId?: string
}

/**
 * Optional pre-check run before the general evaluator: ticket-scoped denial.
 * Returning a verdict short-circuits the call; returning undefined falls
 * through to the rule evaluator.
 */
export type TicketGate = (call: ToolCallInput) => TicketDenyVerdict | undefined

export function attachPolicy(ctx: {
  on(event: string, listener: (payload: unknown, next?: () => unknown) => unknown): void
}, evaluator: PolicyEvaluator, audit: AuditLogger, logger: LoggerService, ticketGate?: TicketGate): void {
  // Cordis waterfall: `allow` here means "this layer has no objection", not
  // "the call is approved". The chain is handed to `next()` so plugins
  // registered later (or the harness's own default handler) still decide.
  ctx.on('tools/pre-execute', (payload: unknown, next?: () => unknown): PolicyVerdict | undefined => {
    const pass = () => (next?.() ?? undefined) as PolicyVerdict | undefined
    const call = parseToolCall(payload)
    if (!call) {
      logger.debug('[dsh-policy] pre-execute payload not recognized; letting the pipeline continue')
      return pass()
    }

    // Ticket rules run first: a ticket's deny list is never softened by a
    // general allow rule, which is what makes the layer worth having.
    if (ticketGate) {
      let denied: TicketDenyVerdict | undefined
      try {
        denied = ticketGate(call)
      } catch (err) {
        logger.warn(`[dsh-policy] ticket gate error: ${(err as Error).message}`)
        denied = {
          decision: 'deny',
          reason: 'ticket policy evaluation failed (fail-closed)',
          ruleId: 'ticket:error',
        }
      }
      if (denied) {
        audit.log({
          phase: 'decision',
          session_id: call.sessionId,
          tool: call.tool,
          args_hash: audit.hashArgs(call.args),
          decision: 'deny',
          rule_id: denied.ruleId,
          reason: denied.reason,
        })
        return { decision: 'deny', reason: denied.reason, ruleId: denied.ruleId }
      }
    }

    const decision = evaluator.evaluate(call)
    audit.log({
      phase: 'decision',
      session_id: call.sessionId,
      tool: call.tool,
      args_hash: audit.hashArgs(call.args),
      decision: decision.decision,
      rule_id: decision.ruleId,
      reason: decision.reason,
    })
    switch (decision.decision) {
      case 'allow':
        // Pass the chain on; fall back to our own allow verdict when this is
        // the only plugin in the pipeline.
        return pass() ?? { decision: 'allow', ruleId: decision.ruleId }
      case 'deny':
        return {
          decision: 'deny',
          reason: decision.reason ?? 'blocked by dsh-policy',
          ruleId: decision.ruleId,
        }
      case 'ask':
        return {
          decision: 'ask',
          reason: decision.reason ?? 'requires approval (dsh-policy)',
          ruleId: decision.ruleId,
        }
    }
  })

  ctx.on('tools/post-execute', (payload: unknown) => {
    const result = parseToolResult(payload)
    if (!result) return
    audit.log({
      phase: 'outcome',
      session_id: result.sessionId,
      tool: result.tool,
      args_hash: result.argsHash,
      outcome: result.outcome,
    })
  })
}

function parseToolCall(payload: unknown): ToolCallInput | null {
  if (!isRecord(payload)) return null
  const tool =
    firstString(payload.tool, payload.toolName, payload.tool_name, payload.name) ??
    (isRecord(payload.call) ? firstString(payload.call.tool, payload.call.toolName) : undefined)
  if (!tool) return null
  const args =
    payload.args ?? payload.input ?? payload.arguments ??
    (isRecord(payload.call) ? payload.call.args ?? payload.call.input : undefined)
  const sessionId = firstString(payload.sessionId, payload.session_id, payload.session)
  return { tool, args, sessionId }
}

function parseToolResult(payload: unknown): { tool: string; sessionId?: string; argsHash?: string; outcome: string } | null {
  if (!isRecord(payload)) return null
  const tool = firstString(payload.tool, payload.toolName, payload.tool_name, payload.name)
  if (!tool) return null
  const error = firstString(payload.error)
  const status = firstString(payload.status)
  const outcome = error ? `error: ${error}` : status ?? 'ok'
  return {
    tool,
    sessionId: firstString(payload.sessionId, payload.session_id, payload.session),
    outcome,
  }
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}
