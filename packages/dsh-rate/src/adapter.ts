import type { LoggerService } from '@deepseek-ai/cordis'
import { BackoffTracker } from './backoff.js'
import { UsageMeter } from './meter.js'
import { AuditLogger } from './audit.js'
import type { RateConfig, RateMode } from './types.js'

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
}

export function attachRateShield(ctx: {
  on(event: string, listener: (payload: unknown) => unknown): void
}, deps: RateDeps): void {
  const { config, meter, backoff, audit, logger } = deps
  const mode: RateMode = config.mode ?? 'monitor'
  const budget = config.budget ?? {}
  const dailyTokens = Math.max(0, budget.dailyTokens ?? 0)
  const warnAt = Math.min(1, Math.max(0, budget.warnAt ?? 0.8))
  const criticalBlock = (budget.criticalAction ?? 'log') === 'block-tools'
  const windowMs = Math.max(0, config.toolStorm?.windowMs ?? 60_000)
  const maxCalls = Math.max(0, config.toolStorm?.maxCalls ?? 0)
  let warnedToday = false

  ctx.on('session/event', (raw: unknown) => {
    const projected = UsageMeter.projectTokens(raw)
    if (!projected) return
    const now = new Date()
    if (projected.tokens > 0) {
      const total = meter.addTokens(projected.tokens, now)
      audit.log({ event: 'llm_usage', tokens: projected.tokens, tokens_today: total })
      if (
        dailyTokens > 0 &&
        !warnedToday &&
        total >= dailyTokens * warnAt
      ) {
        warnedToday = true
        logger.warn(`[dsh-rate-shield] token budget at ${Math.round((total / dailyTokens) * 100)}% (${total}/${dailyTokens})`)
        audit.log({ event: 'budget_warn', tokens_today: total, reason: `${total}/${dailyTokens}` })
      }
    }
    if (projected.isRateLimited) {
      const window = backoff.onRateLimited(Date.now())
      logger.warn(`[dsh-rate-shield] 429 observed — backing off ${Math.round(window / 1000)}s (streak ${backoff.streak})`)
      audit.log({ event: 'llm_429', backoff_remaining_ms: window, reason: `streak=${backoff.streak}` })
      return
    }
    if (!projected.isError) {
      if (backoff.streak > 0) {
        audit.log({ event: 'llm_ok', reason: 'backoff streak reset' })
      }
      backoff.onSuccess()
    }
  })

  ctx.on('tools/pre-execute', (payload: unknown): RateVerdict | undefined => {
    const call = parseToolCall(payload)
    if (!call) return undefined
    const now = Date.now()

    const backoffLeft = backoff.remainingMs(now)
    if (backoffLeft > 0) {
      audit.log({ event: mode === 'enforce' ? 'backoff_deny' : 'storm_hit', tool: call.tool, backoff_remaining_ms: backoffLeft })
      if (mode === 'enforce') {
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

    if (dailyTokens > 0) {
      const used = meter.tokensToday(new Date(now))
      if (used >= dailyTokens) {
        audit.log({ event: mode === 'enforce' && criticalBlock ? 'budget_deny' : 'storm_hit', tool: call.tool, tokens_today: used })
        if (mode === 'enforce' && criticalBlock) {
          logger.warn(`[dsh-rate-shield] denying ${call.tool}: daily token budget exhausted (${used}/${dailyTokens})`)
          return {
            decision: 'deny',
            reason: `[dsh-rate-shield] daily token budget exhausted (${used}/${dailyTokens}). Raise budget.dailyTokens or wait for the UTC reset.`,
            ruleId: 'rate-budget',
          }
        }
      }
    }

    if (maxCalls > 0 && windowMs > 0) {
      const calls = meter.recordToolCall(now, windowMs)
      if (calls > maxCalls) {
        audit.log({ event: mode === 'enforce' ? 'storm_deny' : 'storm_hit', tool: call.tool, window_calls: calls })
        if (mode === 'enforce') {
          return {
            decision: 'deny',
            reason: `[dsh-rate-shield] tool-call storm: ${calls} calls in the last ${Math.round(windowMs / 1000)}s (limit ${maxCalls}). Slow down.`,
            ruleId: 'rate-storm',
          }
        }
      }
    }

    return undefined
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

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}
