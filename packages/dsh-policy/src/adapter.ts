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
 * `tools/pre-execute` and `tools/post-execute` are cordis *waterfalls*, not
 * broadcasts. That has two consequences this file has to honour:
 *
 *   1. A listener that does not own the decision must return `next()`. A bare
 *      `return` ends the chain and hands the harness `undefined`, which it then
 *      dereferences (`gate.kind`, `decision.additionalContexts`) and crashes.
 *   2. The decision object is discriminated by `kind`, not by a field of our
 *      choosing — the harness reads `gate.kind === 'ask'` and
 *      `decision.kind === 'allow'` directly.
 *
 * Listeners are deliberately defensive: an unexpected payload shape is passed
 * straight through (the built-in approval chain keeps handling the call) —
 * policy plugins must never crash the harness hot path.
 */

/** The shape `tools/pre-execute` must return. `ruleId` is ours; the harness ignores it. */
export interface PolicyVerdict {
  kind: 'allow' | 'deny' | 'ask' | 'cancel'
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
  // cordis 4.1 turned `on` into an overload over a strongly-typed `Events`
  // map, so `name: string` is no longer assignable to `keyof Events` and every
  // narrower structural type stops matching `Context`. Spelling the method as
  // `any[]` is the one form 4.0 and 4.1 both accept; the listeners themselves
  // stay typed at the registration site below.
  on(...args: any[]): any
}, evaluator: PolicyEvaluator, audit: AuditLogger, logger: LoggerService, ticketGate?: TicketGate): void {
  // Cordis waterfall: `allow` here means "this layer has no objection", not
  // "the call is approved". The chain is handed to `next()` so plugins
  // registered later (or the harness's own default handler) still decide.
  ctx.on('tools/pre-execute', (exec: unknown, next?: () => unknown): PolicyVerdict | undefined => {
    const pass = () => (next?.() ?? undefined) as PolicyVerdict | undefined
    const call = parseToolCall(exec)
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
        return { kind: 'deny', reason: denied.reason ?? 'blocked by dsh-policy', ruleId: denied.ruleId }
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
        return pass() ?? { kind: 'allow', ruleId: decision.ruleId }
      case 'deny':
        return {
          kind: 'deny',
          reason: decision.reason ?? 'blocked by dsh-policy',
          ruleId: decision.ruleId,
        }
      case 'ask':
        return {
          kind: 'ask',
          reason: decision.reason ?? 'requires approval (dsh-policy)',
          ruleId: decision.ruleId,
        }
    }
  })

  // `tools/post-execute` is a waterfall too: the harness reads
  // `decision.kind === 'block'` and `decision.additionalContexts` off whatever
  // we return. Returning nothing replaces its `{ kind: 'accept' }` with
  // `undefined` and takes down every tool call, so the chain always gets `next()`.
  ctx.on('tools/post-execute', (exec: unknown, result: unknown, next?: () => unknown) => {
    try {
      const parsed = parseToolResult(exec, result)
      if (parsed) {
        audit.log({
          phase: 'outcome',
          session_id: parsed.sessionId,
          tool: parsed.tool,
          args_hash: parsed.argsHash,
          outcome: parsed.outcome,
        })
      }
    } catch (err) {
      // Auditing must never be the reason a tool call fails.
      logger.warn(`[dsh-policy] post-execute audit failed: ${(err as Error).message}`)
    }
    return next?.() ?? { kind: 'accept' }
  })
}

function parseToolCall(exec: unknown): ToolCallInput | null {
  if (!isRecord(exec)) return null
  // `ToolExecution` exposes `name` and `arguments`; the other spellings are
  // kept so the adapter also works against hand-built payloads in tests.
  const tool =
    firstString(exec.name, exec.tool, exec.toolName, exec.tool_name) ??
    (isRecord(exec.call) ? firstString(exec.call.tool, exec.call.toolName) : undefined)
  if (!tool) return null
  const args =
    exec.arguments ?? exec.args ?? exec.input ??
    (isRecord(exec.call) ? exec.call.args ?? exec.call.input : undefined)
  const sessionId =
    firstString(exec.sessionId, exec.session_id, exec.session) ??
    // `ToolExecution` has no `sessionId` field. The session reaches a listener
    // only through `agent`, whose `id` *is* the SessionId — so reading
    // `exec.sessionId` alone yields undefined in the real harness and turns
    // every ticket rule into a no-op.
    (isRecord(exec.agent) ? firstString(exec.agent.id) : undefined)
  return { tool, args, sessionId }
}

function parseToolResult(exec: unknown, result: unknown): { tool: string; sessionId?: string; argsHash?: string; outcome: string } | null {
  const call = parseToolCall(exec)
  if (!call) return null
  let outcome = 'ok'
  if (isRecord(result)) {
    const error = isRecord(result.error) ? firstString(result.error.message) : firstString(result.error)
    const status = firstString(result.status)
    if (result.isError === true || error) outcome = `error: ${error ?? 'unknown'}`
    else if (status) outcome = status
  }
  return { tool: call.tool, sessionId: call.sessionId, outcome }
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}
