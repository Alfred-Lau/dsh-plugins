import type { LoggerService } from '@deepseek-ai/cordis'
import { MemoStore, cacheKey, preview } from './store.js'
import { AuditLogger } from './audit.js'
import type { MemoConfig } from './types.js'
import type { TicketScopeHandle } from './ticket-scope.js'

/**
 * Tool-pipeline adapter.
 *
 *   pre-execute : on a cache hit (and not bypassed by the fresh flag), return
 *                 a verdict that short-circuits re-execution:
 *                   hint   -> deny + explanatory reason with cached preview
 *                   inject -> allow + `result` field (EXPERIMENTAL)
 *   post-execute: successful results of cacheable tools fill the store.
 *
 * Mutating / outbound tools are excluded by default — a cached side effect is
 * worse than a repeated one. Listeners never throw on unexpected payloads.
 */

export interface MemoVerdict {
  decision: 'allow' | 'deny'
  reason?: string
  result?: unknown
  memoized?: boolean
  ruleId?: string
}

export interface MemoDeps {
  config: MemoConfig
  store: MemoStore
  audit: AuditLogger
  logger: LoggerService
  /** Ticket isolation; absent when the feature is off. */
  ticketScope?: TicketScopeHandle
}

export const DEFAULT_EXCLUDE_TOOLS = [
  'write*',
  'edit*',
  'create*',
  'delete*',
  'remove*',
  'mkdir*',
  'mv',
  'move',
  'cp',
  'copy',
  'bash',
  'shell',
  'http*',
  'fetch*',
  'send*',
  'mail*',
  'email*',
  'upload*',
  'post*',
  'install*',
  'git_*',
]

export function attachMemo(ctx: {
  on(event: string, listener: (payload: unknown, next?: () => unknown) => unknown): void
}, deps: MemoDeps): void {
  const { config, store, audit, logger, ticketScope } = deps
  // schemastery fills an absent array with `[]`, so `??` would silently turn
  // "not configured" into "nothing excluded" — which would cache `bash` and
  // hand a stale test result to the next call. Empty means unset here.
  const excludeSource = config.excludeTools && config.excludeTools.length > 0 ? config.excludeTools : DEFAULT_EXCLUDE_TOOLS
  const exclude = excludeSource.map(compileGlob)
  const include = (config.includeTools ?? []).map(compileGlob)
  const freshFlag = config.freshFlag || '_memoFresh'
  const injectMode = config.mode === 'inject'

  const cacheable = (tool: string): boolean => {
    if (exclude.some((re) => re.test(tool))) return false
    if (include.length > 0 && !include.some((re) => re.test(tool))) return false
    return true
  }

  // `tools/pre-execute` is a Cordis waterfall: each listener owns the right to
  // speak, and must call `next()` to hand the call to the next listener. A
  // memo miss is not a verdict, it is "no opinion" — so it passes the chain on
  // instead of returning `undefined`, which would end the chain here and hide
  // every governance plugin registered after this one.
  ctx.on('tools/pre-execute', (payload: unknown, next?: () => unknown): MemoVerdict | undefined => {
    const pass = () => next?.() as MemoVerdict | undefined
    const call = parseToolCall(payload)
    if (!call) return pass()
    if (!cacheable(call.tool)) {
      audit.log({ event: 'skip', tool: call.tool, key: '-', session_id: call.sessionId, reason: 'tool not cacheable' })
      return pass()
    }
    if (hasFreshFlag(call.args, freshFlag)) {
      audit.log({ event: 'skip', tool: call.tool, key: '-', session_id: call.sessionId, reason: `fresh flag '${freshFlag}' set` })
      return pass()
    }
    const now = Date.now()
    const bucket = ticketScope?.bucketOf(call.sessionId) ?? ''
    const { entry } = store.lookup(call.tool, call.args, now, bucket)
    if (!entry) {
      audit.log({
        event: 'miss',
        tool: call.tool,
        key: cacheKey(call.tool, call.args, bucket),
        session_id: call.sessionId,
        ...(bucket ? { bucket } : {}),
      })
      return pass()
    }
    const ageMs = now - entry.storedAt
    audit.log({ event: 'hit', tool: call.tool, key: entry.key, session_id: call.sessionId, age_ms: ageMs, ...(bucket ? { bucket } : {}) })
    logger.info(`[dsh-tool-memo] hit ${call.tool} (age ${Math.round(ageMs / 1000)}s)`)
    if (injectMode) {
      // EXPERIMENTAL: relies on the harness forwarding verdict.result to the
      // model. On harnesses that ignore it the call simply re-executes.
      return {
        decision: 'allow',
        result: entry.value,
        memoized: true,
        ruleId: 'memo-inject',
      }
    }
    return {
      decision: 'deny',
      reason:
        `[dsh-tool-memo] cache HIT for '${call.tool}' (age ${Math.round(ageMs / 1000)}s): ${preview(entry.value)} — ` +
        `use this cached result; re-run with {"${freshFlag}": true} in the arguments to force a fresh execution.`,
      memoized: true,
      ruleId: 'memo-hint',
    }
  })

  ctx.on('tools/post-execute', (payload: unknown) => {
    const result = parseToolResult(payload)
    if (!result) return
    if (!cacheable(result.tool)) return
    if (result.error) {
      audit.log({ event: 'skip', tool: result.tool, key: '-', session_id: result.sessionId, reason: `error result not cached: ${result.error}` })
      return
    }
    const bucket = ticketScope?.bucketOf(result.sessionId) ?? ''
    const entry = store.store(result.tool, result.args, result.output, Date.now(), bucket)
    if (entry) {
      audit.log({
        event: 'store',
        tool: result.tool,
        key: entry.key,
        session_id: result.sessionId,
        reason: `ttl=${store.ttlFor(result.tool)}ms`,
        ...(bucket ? { bucket } : {}),
      })
    }
  })
}

/** `*` within one segment, `**` across segments — same semantics as dsh-pii-gate. */
export function compileGlob(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

function hasFreshFlag(args: unknown, flag: string): boolean {
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    return (args as Record<string, unknown>)[flag] === true
  }
  return false
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
  const call = typeof rec.call === 'object' && rec.call !== null ? (rec.call as Record<string, unknown>) : undefined
  const args = rec.args ?? rec.input ?? rec.arguments ?? rec.params ?? call?.args ?? call?.input
  return { tool, args, sessionId: firstString(rec.sessionId, rec.session_id, rec.session) }
}

export function parseToolResult(payload: unknown): {
  tool: string
  args: unknown
  output: unknown
  error?: string
  sessionId?: string
} | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const rec = payload as Record<string, unknown>
  const tool = firstString(rec.tool, rec.toolName, rec.tool_name, rec.name)
  if (!tool) return null
  return {
    tool,
    args: rec.args ?? rec.input ?? rec.arguments,
    output: rec.result ?? rec.output ?? rec.content,
    error: firstString(rec.error, rec.err),
    sessionId: firstString(rec.sessionId, rec.session_id, rec.session),
  }
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}
