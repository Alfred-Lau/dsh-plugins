import type { LoggerService } from '@deepseek-ai/cordis'
import { PiiDetector, collectStrings, countByType } from './detector.js'
import { AuditLogger } from './audit.js'
import type { PiiConfig, PiiMatch } from './types.js'
import type { TicketScopeHandle } from './ticket-scope.js'

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
  /** Ticket-scoped overrides; absent when the feature is off. */
  ticketScope?: TicketScopeHandle
}

export function attachPiiGate(ctx: {
  on(event: string, listener: (payload: unknown, next?: () => unknown) => unknown): void
}, deps: PiiGateDeps): void {
  const { config, detector, audit, logger, ticketScope } = deps
  // Same empty-array trap as the per-ticket rules: schemastery materialises an
  // absent array as `[]`, and `[] ?? DEFAULT_OUTBOUND` would leave the global
  // outbound set empty, so nothing would ever be considered outbound.
  const outboundSource = config.outboundTools && config.outboundTools.length > 0 ? config.outboundTools : DEFAULT_OUTBOUND
  const outbound = compileGlobs(outboundSource)
  const exempt = compileGlobs(config.exemptTools ?? [])
  const minMatches = Math.max(1, config.minMatches ?? 1)
  const blockMode = config.mode === 'block'

  // Per-ticket overrides, compiled once per distinct rule.
  const ruleOutbound = new Map<object, RegExp[]>()
  const outboundFor = (rule: { outboundTools?: string[] } | undefined): RegExp[] => {
    // An empty array means "not configured", not "match nothing": schemastery
    // fills an absent `outboundTools` with `[]`, and a rule that only sets
    // `mode` must still inherit the global tool set.
    if (!rule?.outboundTools || rule.outboundTools.length === 0) return outbound
    let compiled = ruleOutbound.get(rule)
    if (!compiled) {
      compiled = compileGlobs(rule.outboundTools)
      ruleOutbound.set(rule, compiled)
    }
    return compiled
  }

  // Cordis waterfall: a listener that has no objection must call `next()` so the
  // remaining governance plugins still get a look at the call. Returning
  // `undefined` would terminate the chain.
  ctx.on('tools/pre-execute', (payload: unknown, next?: () => unknown): PiiVerdict | undefined => {
    const pass = () => next?.() as PiiVerdict | undefined
    const call = parseToolCall(payload)
    if (!call) {
      logger.debug('[dsh-pii-gate] pre-execute payload not recognized; letting the pipeline continue')
      return pass()
    }
    if (exempt.some((re) => re.test(call.tool))) return pass()

    // A ticket may tighten (or relax) the global policy: a ticket working on a
    // public PR can force `block` while the rest of the run stays observe-only.
    const scope = ticketScope?.scopeOf(call.sessionId)
    const rule = scope ? ticketScope?.ruleFor(scope) : undefined
    const effectiveBlockMode = (rule?.mode ?? config.mode) === 'block'
    const effectiveMin = Math.max(1, rule?.minMatches ?? minMatches)
    const effectiveOutbound = outboundFor(rule)

    const strings = collectStrings(call.args)
    const matches = strings.flatMap((s) => detector.scan(s))
    const counts = countByType(matches)
    const shouldBlock =
      effectiveBlockMode && matches.length >= effectiveMin && effectiveOutbound.some((re) => re.test(call.tool))

    audit.log({
      phase: 'decision',
      session_id: call.sessionId,
      ...(scope?.ticketId ? { ticket_id: scope.ticketId } : {}),
      ...(scope ? { ticket_role: scope.role } : {}),
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
      const where = scope?.ticketId ? ` for ticket ${scope.ticketId}` : ''
      return {
        decision: 'deny',
        reason:
          `[dsh-pii-gate] blocked${where}: ${matches.length} PII match(es) [${types}] in arguments of tool '${call.tool}'. ` +
          `Scrub the input or add this tool to exemptTools if the data is expected.`,
        ruleId: rule ? `pii-block:ticket:${rule.match}` : 'pii-block',
      }
    }
    return pass()
  })

  ctx.on('tools/post-execute', (payload: unknown) => {
    if (config.scanResults === false) return
    const result = parseToolResult(payload)
    if (!result) return
    const strings = collectStrings(result.output)
    const matches = strings.flatMap((s) => detector.scan(s))
    if (matches.length === 0) return
    const outcomeScope = ticketScope?.scopeOf(result.sessionId)
    audit.log({
      phase: 'outcome',
      session_id: result.sessionId,
      ...(outcomeScope?.ticketId ? { ticket_id: outcomeScope.ticketId } : {}),
      ...(outcomeScope ? { ticket_role: outcomeScope.role } : {}),
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
