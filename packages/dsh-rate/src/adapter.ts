import type { LoggerService } from '@deepseek-ai/cordis'
import { BackoffTracker } from './backoff.js'
import { UsageMeter } from './meter.js'
import { AuditLogger } from './audit.js'
import type { RateConfig, RateMode } from './types.js'
import { bucketOf, type TicketScopeHandle } from './ticket-scope.js'

/**
 * Tool-pipeline adapter + event metering.
 *
 * session/event    : meter LLM completions (tokens, 429s) — observe-only.
 * tools/pre-execute: in enforce mode, deny calls while a 429 backoff window
 *                    is open, once the daily budget is exhausted with
 *                    criticalAction=block-tools, or when the tool-call rate
 *                    exceeds the storm window. Monitor mode never denies.
 *
 * LLM requests themselves have no short-circuit channel in the current dsh
 * event surface, so "shielding" a rate-limited model means protecting the
 * tool loop around it — enforced here, honestly documented in the README.
 *
 * With dsh-superagent tickets in play, every counter is also bucketed per
 * ticket: one runaway ticket spends its own allowance and trips its own storm
 * window instead of starving the rest of the run. A 429 backoff stays global,
 * because the limit that produced it is the model's, not a ticket's.
 */

export interface RateVerdict {
  decision: 'allow' | 'deny'
  reason?: string
  ruleId?: string
}

export interface RateDeps {
  config: RateConfig
  meter: UsageMeter
  backoff: BackoffTracker
  audit: AuditLogger
  logger: LoggerService
  /** Ticket scoping; absent when the feature is off. */
  ticketScope?: TicketScopeHandle
}

export function attachRateShield(ctx: {
  on(event: string, listener: (payload: unknown, next?: () => unknown) => unknown): void
}, deps: RateDeps): void {
  const { config, meter, backoff, audit, logger, ticketScope } = deps
  const mode: RateMode = config.mode ?? 'monitor'
  const budget = config.budget ?? {}
  const dailyTokens = Math.max(0, budget.dailyTokens ?? 0)
  const warnAt = Math.min(1, Math.max(0, budget.warnAt ?? 0.8))
  const criticalBlock = (budget.criticalAction ?? 'log') === 'block-tools'
  const windowMs = Math.max(0, config.toolStorm?.windowMs ?? 60_000)
  const maxCalls = Math.max(0, config.toolStorm?.maxCalls ?? 0)
  /** One warning per bucket per day, so a ticket's warning does not mask the global one. */
  const warnedToday = new Set<string>()

  ctx.on('session/event', (raw: unknown) => {
    const projected = UsageMeter.projectTokens(raw)
    if (!projected) return
    const now = new Date()
    const scope = ticketScope?.scopeOf(sessionIdOf(raw))
    const bucket = bucketOf(scope)

    if (projected.tokens > 0) {
      const total = meter.addTokens(projected.tokens, now)
      const ticketTotal = bucket ? meter.addTokens(projected.tokens, now, bucket) : 0
      audit.log({
        event: 'llm_usage',
        tokens: projected.tokens,
        tokens_today: total,
        ...(bucket ? { ticket_id: bucket, ticket_tokens_today: ticketTotal } : {}),
      })

      if (dailyTokens > 0 && !warnedToday.has('global') && total >= dailyTokens * warnAt) {
        warnedToday.add('global')
        logger.warn(`[dsh-rate-shield] token budget at ${Math.round((total / dailyTokens) * 100)}% (${total}/${dailyTokens})`)
        audit.log({ event: 'budget_warn', tokens_today: total, reason: `${total}/${dailyTokens}` })
      }

      // A ticket's own allowance warns independently of the global one.
      const ticketBudget = ticketScope?.ruleFor(scope)?.dailyTokens ?? 0
      if (bucket && ticketBudget > 0 && !warnedToday.has(bucket) && ticketTotal >= ticketBudget * warnAt) {
        warnedToday.add(bucket)
        const pct = Math.round((ticketTotal / ticketBudget) * 100)
        logger.warn(`[dsh-rate-shield] ticket ${bucket} budget at ${pct}% (${ticketTotal}/${ticketBudget})`)
        audit.log({ event: 'budget_warn', ticket_id: bucket, ticket_tokens_today: ticketTotal, reason: `${ticketTotal}/${ticketBudget}` })
      }
    }

    if (projected.isRateLimited) {
      const window = backoff.onRateLimited(Date.now())
      logger.warn(`[dsh-rate-shield] 429 observed — backing off ${Math.round(window / 1000)}s (streak ${backoff.streak})`)
      audit.log({
        event: 'llm_429',
        backoff_remaining_ms: window,
        reason: `streak=${backoff.streak}`,
        ...(bucket ? { ticket_id: bucket } : {}),
      })
      return
    }
    if (!projected.isError) {
      if (backoff.streak > 0) {
        audit.log({ event: 'llm_ok', reason: 'backoff streak reset' })
      }
      backoff.onSuccess()
    }
  })

  // Cordis waterfall: staying silent means "no objection", which must be
  // expressed by calling `next()` — returning `undefined` would end the chain
  // and starve every plugin registered after this one.
  ctx.on('tools/pre-execute', (payload: unknown, next?: () => unknown): RateVerdict | undefined => {
    const pass = () => next?.() as RateVerdict | undefined
    const call = parseToolCall(payload)
    if (!call) return pass()
    const now = Date.now()
    const scope = ticketScope?.scopeOf(call.sessionId)
    const bucket = bucketOf(scope)
    const rule = ticketScope?.ruleFor(scope)
    const effectiveMode: RateMode = rule?.mode ?? mode
    const tag = bucket ? { ticket_id: bucket, ticket_role: scope?.role } : {}

    const backoffLeft = backoff.remainingMs(now)
    if (backoffLeft > 0) {
      audit.log({
        event: effectiveMode === 'enforce' ? 'backoff_deny' : 'storm_hit',
        tool: call.tool,
        backoff_remaining_ms: backoffLeft,
        ...tag,
      })
      if (effectiveMode === 'enforce') {
        logger.warn(`[dsh-rate-shield] denying ${call.tool}: 429 backoff for another ${Math.round(backoffLeft / 1000)}s`)
        return {
          decision: 'deny',
          reason:
            `[dsh-rate-shield] rate backoff window open (${Math.round(backoffLeft / 1000)}s left after a 429). ` +
            `Wait for the window to close, then retry.`,
          ruleId: 'rate-backoff',
        }
      }
    }

    // A ticket's own allowance is checked first: it is the tighter of the two
    // in practice, and the reason should name the ticket that ran out.
    const ticketBudget = Math.max(0, rule?.dailyTokens ?? 0)
    if (bucket && ticketBudget > 0) {
      const used = meter.tokensToday(new Date(now), bucket)
      if (used >= ticketBudget) {
        audit.log({
          event: effectiveMode === 'enforce' && criticalBlock ? 'budget_deny' : 'storm_hit',
          tool: call.tool,
          ticket_tokens_today: used,
          ...tag,
        })
        if (effectiveMode === 'enforce' && criticalBlock) {
          logger.warn(`[dsh-rate-shield] denying ${call.tool}: ticket ${bucket} budget exhausted (${used}/${ticketBudget})`)
          return {
            decision: 'deny',
            reason:
              `[dsh-rate-shield] ticket ${bucket} token budget exhausted (${used}/${ticketBudget}). ` +
              `Raise ticket.rules[].dailyTokens for this ticket or wait for the UTC reset.`,
            ruleId: `rate-budget:ticket:${rule?.match ?? bucket}`,
          }
        }
      }
    }

    if (dailyTokens > 0) {
      const used = meter.tokensToday(new Date(now))
      if (used >= dailyTokens) {
        audit.log({ event: effectiveMode === 'enforce' && criticalBlock ? 'budget_deny' : 'storm_hit', tool: call.tool, tokens_today: used, ...tag })
        if (effectiveMode === 'enforce' && criticalBlock) {
          logger.warn(`[dsh-rate-shield] denying ${call.tool}: daily token budget exhausted (${used}/${dailyTokens})`)
          return {
            decision: 'deny',
            reason: `[dsh-rate-shield] daily token budget exhausted (${used}/${dailyTokens}). Raise budget.dailyTokens or wait for the UTC reset.`,
            ruleId: 'rate-budget',
          }
        }
      }
    }

    // Storm windows are per bucket: a busy ticket must not block a quiet one.
    const effectiveMaxCalls = Math.max(0, rule?.maxCalls ?? maxCalls)
    if (effectiveMaxCalls > 0 && windowMs > 0) {
      const calls = meter.recordToolCall(now, windowMs, bucket ?? 'global')
      if (calls > effectiveMaxCalls) {
        audit.log({
          event: effectiveMode === 'enforce' ? 'storm_deny' : 'storm_hit',
          tool: call.tool,
          window_calls: calls,
          ...tag,
        })
        if (effectiveMode === 'enforce') {
          const who = bucket ? `ticket ${bucket}` : 'this session'
          return {
            decision: 'deny',
            reason: `[dsh-rate-shield] tool-call storm on ${who}: ${calls} calls in the last ${Math.round(windowMs / 1000)}s (limit ${effectiveMaxCalls}). Slow down.`,
            ruleId: bucket ? `rate-storm:ticket:${rule?.match ?? bucket}` : 'rate-storm',
          }
        }
      }
    }

    return pass()
  })
}

export interface ParsedCall {
  tool: string
  args: unknown
  sessionId?: string
}

export function parseToolCall(payload: unknown): ParsedCall | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const rec = payload as Record<string, unknown>
  const tool = firstString(rec.tool, rec.toolName, rec.tool_name, rec.name)
  if (!tool) return null
  return { tool, args: rec.args ?? rec.input ?? rec.arguments, sessionId: firstString(rec.sessionId, rec.session_id, rec.session) }
}

/** Session id of a raw session/event payload, when present. */
export function sessionIdOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  return firstString(rec.sessionId, rec.session_id, rec.session)
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}
