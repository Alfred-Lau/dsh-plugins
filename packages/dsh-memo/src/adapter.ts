import type { LoggerService } from '@deepseek-ai/cordis'
import { MemoStore, cacheKey, preview } from './store.js'
import { AuditLogger } from './audit.js'
import type { MemoConfig } from './types.js'

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
  on(event: string, listener: (payload: unknown) => unknown): void
}, deps: MemoDeps): void {
  const { config, store, audit, logger } = deps
  const exclude = (config.excludeTools ?? DEFAULT_EXCLUDE_TOOLS).map(compileGlob)
  const include = (config.includeTools ?? []).map(compileGlob)
  const freshFlag = config.freshFlag || '_memoFresh'
  const injectMode = config.mode === 'inject'

  const cacheable = (tool: string): boolean => {
    if (exclude.some((re) => re.test(tool))) return false
    if (include.length > 0 && !include.some((re) => re.test(tool))) return false
    return true
  }

  ctx.on('tools/pre-execute', (payload: unknown): MemoVerdict | undefined => {
    const call = parseToolCall(payload)
    if (!call) return undefined
    if (!cacheable(call.tool)) {
      audit.log({ event: 'skip', tool: call.tool, key: '-', session_id: call.sessionId, reason: 'tool not cacheable' })
      return undefined
    }
    if (hasFreshFlag(call.args, freshFlag)) {
      audit.log({ event: 'skip', tool: call.tool, key: '-', session_id: call.sessionId, reason: `fresh flag '${freshFlag}' set` })
      return undefined
    }
    const now = Date.now()
    const { entry } = store.lookup(call.tool, call.args, now)
    if (!entry) {
      audit.log({ event: 'miss', tool: call.tool, key: cacheKey(call.tool, call.args), session_id: call.sessionId })
      return undefined
    }
    const ageMs = now - entry.storedAt
    audit.log({ event: 'hit', tool: call.tool, key: entry.key, session_id: call.sessionId, age_ms: ageMs })
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
    const entry = store.store(result.tool, result.args, result.output, Date.now())
    if (entry) {
      audit.log({ event: 'store', tool: result.tool, key: entry.key, session_id: result.sessionId, reason: `ttl=${store.ttlFor(result.tool)}ms` })
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
