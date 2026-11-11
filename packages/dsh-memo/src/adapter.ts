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
  /** `tools/pre-execute` is discriminated by `kind`; the harness reads it directly. */
  kind: 'allow' | 'deny'
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
  // cordis 4.1 turned `on` into an overload over a strongly-typed `Events`
  // map, so `name: string` is no longer assignable to `keyof Events` and every
  // narrower structural type stops matching `Context`. Spelling the method as
  // `any[]` is the one form 4.0 and 4.1 both accept; the listeners themselves
  // stay typed at the registration site below.
  on(...args: any[]): any
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
      // The harness's pre-execute gate only understands allow/deny/ask/cancel;
      // it does not forward `result` to the model. This branch is kept for
      // harnesses that do, and is honestly documented as best-effort — on the
      // stock harness the call simply re-executes.
      return {
        kind: 'allow',
        result: entry.value,
        memoized: true,
        ruleId: 'memo-inject',
      }
    }
    return {
      kind: 'deny',
      reason:
        `[dsh-tool-memo] cache HIT for '${call.tool}' (age ${Math.round(ageMs / 1000)}s): ${preview(entry.value)} — ` +
        `use this cached result; re-run with {"${freshFlag}": true} in the arguments to force a fresh execution.`,
      memoized: true,
      ruleId: 'memo-hint',
    }
  })

  // `tools/post-execute` is a waterfall: the harness reads `decision.kind` and
  // `decision.additionalContexts` off our return value, so returning nothing
  // would hand it `undefined` and break every tool call. The chain is always
  // handed on, and the store is filled before it is.
  ctx.on('tools/post-execute', (exec: unknown, rawResult: unknown, next?: () => unknown) => {
    try {
      const result = parseToolResult(exec, rawResult)
      if (result && cacheable(result.tool)) {
        if (result.error) {
          audit.log({ event: 'skip', tool: result.tool, key: '-', session_id: result.sessionId, reason: `error result not cached: ${result.error}` })
        } else {
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
        }
      }
    } catch (err) {
      // Filling the cache must never be the reason a tool call fails.
      logger.warn(`[dsh-tool-memo] post-execute store failed: ${(err as Error).message}`)
    }
    return next?.() ?? { kind: 'accept' }
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
  // `ToolExecution` exposes no `sessionId`; the session lives on `agent.id`.
  const agent = typeof rec.agent === 'object' && rec.agent !== null ? (rec.agent as Record<string, unknown>) : undefined
  const sessionId = firstString(rec.sessionId, rec.session_id, rec.session) ?? firstString(agent?.id)
  return { tool, args, sessionId }
}

/**
 * `tools/post-execute` delivers the execution and its result as two separate
 * arguments: the tool identity and arguments come from `exec`, the value to
 * cache from `result`.
 */
export function parseToolResult(exec: unknown, result?: unknown): {
  tool: string
  args: unknown
  output: unknown
  error?: string
  sessionId?: string
} | null {
  const call = parseToolCall(exec)
  if (!call) return null
  const payload = result !== undefined ? result : exec
  const rec = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined
  const error = rec
    ? firstString(rec.error, rec.err) ??
      (typeof rec.error === 'object' && rec.error !== null ? firstString((rec.error as Record<string, unknown>).message) : undefined) ??
      (rec.isError === true ? 'tool reported isError' : undefined)
    : undefined
  return {
    tool: call.tool,
    args: call.args,
    output: rec ? rec.result ?? rec.output ?? rec.content ?? rec.value ?? rec : payload,
    error,
    sessionId: call.sessionId,
  }
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}
