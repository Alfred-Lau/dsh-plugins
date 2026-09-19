import type { LoggerService } from '@deepseek-ai/cordis'
import { PiiDetector, collectStrings, countByType } from './detector.js'
import { AuditLogger } from './audit.js'
import type { PiiConfig, PiiMatch } from './types.js'

/**
 * Tool-pipeline adapter — the ONLY place that knows dsh's tool event names.
 *
 *   audit mode : every scanned call is audited (type counts only) and the
 *                pipeline continues untouched — observe-only.
 *   block mode : calls on outbound tools carrying >= minMatches PII hits are
 *                DENIED with an explanatory reason; everything else continues.
 *
 * The pre-execute waterfall can short-circuit a call but cannot rewrite its
 * arguments, so "redact in place" is deliberately out of scope for v1 (see
 * README). Listeners are defensive: an unexpected payload shape never throws.
 */

export interface PiiVerdict {
  decision: 'allow' | 'deny'
  reason?: string
  ruleId?: string
}

export interface PiiGateDeps {
  config: PiiConfig
  detector: PiiDetector
  audit: AuditLogger
  logger: LoggerService
}

export function attachPiiGate(ctx: {
  on(event: string, listener: (payload: unknown) => unknown): void
}, deps: PiiGateDeps): void {
  const { config, detector, audit, logger } = deps
  const outbound = compileGlobs(config.outboundTools ?? DEFAULT_OUTBOUND)
  const exempt = compileGlobs(config.exemptTools ?? [])
  const minMatches = Math.max(1, config.minMatches ?? 1)
  const blockMode = config.mode === 'block'

  ctx.on('tools/pre-execute', (payload: unknown): PiiVerdict | undefined => {
    const call = parseToolCall(payload)
    if (!call) {
      logger.debug('[dsh-pii-gate] pre-execute payload not recognized; letting the pipeline continue')
      return undefined
    }
    if (exempt.some((re) => re.test(call.tool))) return undefined

    const strings = collectStrings(call.args)
    const matches = strings.flatMap((s) => detector.scan(s))
    const counts = countByType(matches)
    const shouldBlock =
      blockMode && matches.length >= minMatches && outbound.some((re) => re.test(call.tool))

    audit.log({
      phase: 'decision',
      session_id: call.sessionId,
      tool: call.tool,
      args_hash: audit.hashArgs(call.args),
      verdict: shouldBlock ? 'deny' : 'allow',
      matches: counts,
      total: matches.length,
      reason: shouldBlock ? `PII on outbound tool (${Object.keys(counts).join(', ')})` : undefined,
    })

    if (shouldBlock) {
      const types = Object.keys(counts).join(', ')
      logger.warn(`[dsh-pii-gate] denied ${call.tool}: ${matches.length} PII match(es) [${types}]`)
      return {
        decision: 'deny',
        reason:
          `[dsh-pii-gate] blocked: ${matches.length} PII match(es) [${types}] in arguments of tool '${call.tool}'. ` +
          `Scrub the input or add this tool to exemptTools if the data is expected.`,
        ruleId: 'pii-block',
      }
    }
    return undefined
  })

  ctx.on('tools/post-execute', (payload: unknown) => {
    if (config.scanResults === false) return
    const result = parseToolResult(payload)
    if (!result) return
    const strings = collectStrings(result.output)
    const matches = strings.flatMap((s) => detector.scan(s))
    if (matches.length === 0) return
    audit.log({
      phase: 'outcome',
      session_id: result.sessionId,
      tool: result.tool,
      args_hash: result.argsHash,
      verdict: 'observe',
      matches: countByType(matches),
      total: matches.length,
    })
  })
}

export const DEFAULT_OUTBOUND = [
  'bash',
  'shell',
  'http*',
  'fetch*',
  'web*',
  'send*',
  'mail*',
  'email*',
  'upload*',
  'post*',
  'request*',
]

/** Minimal glob: `*` runs within one path segment, `**` crosses segments. */
export function compileGlobs(globs: string[]): RegExp[] {
  return globs.map((g) => {
    const escaped = g
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*')
    return new RegExp(`^${escaped}$`, 'i')
  })
}

export interface ParsedCall {
  tool: string
  args: unknown
  sessionId?: string
}

export function parseToolCall(payload: unknown): ParsedCall | null {
  const tool = firstString(rec(payload, ['tool', 'toolName', 'tool_name', 'name']))
  if (!tool) return null
  const args =
    rec(payload, ['args', 'input', 'arguments', 'params']) ??
    (isRecord((payload as Record<string, unknown>).call)
      ? rec((payload as Record<string, unknown>).call, ['args', 'input', 'arguments'])
      : undefined)
  return {
    tool,
    args,
    sessionId: firstString(rec(payload, ['sessionId', 'session_id', 'session'])),
  }
}

export function parseToolResult(payload: unknown): {
  tool: string
  output: unknown
  sessionId?: string
  argsHash?: string
} | null {
  const isRec = isRecord(payload)
  const tool = isRec ? firstString(rec(payload, ['tool', 'toolName', 'tool_name', 'name'])) : undefined
  if (!tool || !isRec) return null
  return {
    tool,
    output: rec(payload, ['result', 'output', 'content']),
    sessionId: firstString(rec(payload, ['sessionId', 'session_id', 'session'])),
    argsHash: firstString(rec(payload, ['argsHash', 'args_hash'])),
  }
}

function rec(payload: unknown, keys: string[]): unknown {
  if (!isRecord(payload)) return undefined
  for (const k of keys) {
    if (payload[k] !== undefined) return payload[k]
  }
  return undefined
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

export type { PiiMatch }
