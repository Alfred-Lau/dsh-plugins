/**
 * Ticket scope — the shared vocabulary the governance plugins use to answer
 * "which Super-agent ticket am I acting for?".
 *
 * dsh-superagent names every worker Session `worker-<ticketId>` and keeps the
 * router in a single master Session (`src/executor/dsh.ts`, `src/app/sessions.ts`
 * in dsh-superagent-prototype). That naming convention is the only coupling
 * this package has with Super-agent: no source patch, no extra environment
 * variable, no shared database.
 */

/** Prefix dsh-superagent gives every worker Session id. */
export const DEFAULT_WORKER_PREFIX = 'worker-'

export type TicketRole = 'router' | 'worker'

export interface TicketScope {
  /** `worker` for a ticket executor, `router` for the master Session. */
  role: TicketRole
  /** The Session id the scope was derived from. */
  sessionId: string
  /** Ticket id; present only for `role: 'worker'`. */
  ticketId?: string
}

export interface ScopeOptions {
  /** The master Session id, when known. Without it only workers are recognised. */
  masterId?: string
  /** Override the worker Session prefix (defaults to `worker-`). */
  workerPrefix?: string
}

/**
 * Derives the ticket scope from a Session id.
 *
 * Returns `undefined` for sessions that belong to neither Super-agent role —
 * an ordinary Harness session, an empty id, or a malformed worker id such as
 * a bare `worker-` with no ticket after it.
 */
export function scopeOf(sessionId: unknown, options: ScopeOptions = {}): TicketScope | undefined {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined

  const prefix = options.workerPrefix ?? DEFAULT_WORKER_PREFIX
  if (prefix.length > 0 && sessionId.startsWith(prefix)) {
    const ticketId = sessionId.slice(prefix.length)
    // A bare prefix carries no ticket; treat it as a foreign session rather
    // than inventing an empty ticket id that every guard would then share.
    return ticketId.length > 0 ? { role: 'worker', sessionId, ticketId } : undefined
  }

  if (options.masterId && sessionId === options.masterId) return { role: 'router', sessionId }

  return undefined
}

/**
 * Per-ticket policy: what a ticket of this shape may do.
 *
 * Rules are matched in order against the ticket id; the first match wins, the
 * same "longest/first matching glob wins" convention dsh-tool-memo uses.
 */
export interface TicketRule {
  /** Glob matched against the ticket id, e.g. `fix-*`, `review-*`, `*`. */
  match: string
  /** Tool-name globs this ticket may call. Empty or absent means "no restriction". */
  tools?: string[]
  /** Command names this ticket must never run. */
  blockedCommands?: string[]
  /** Soft budget in USD, consumed by dsh-cost-eval when it is installed. */
  budgetUsd?: number
}

export interface ResolvedTicketPolicy {
  rule: TicketRule
  ticketId: string
}

/** Plugin configuration, shared by the schema and the plugin entry point. */
export interface TicketConfig {
  /** Master switch. When false the service is not published. */
  enabled: boolean
  /**
   * The Super-agent router Session id. Leaving it empty means only worker
   * sessions are recognised; router-side checks then simply never fire.
   */
  masterId: string
  /** Session-id prefix dsh-superagent uses for worker sessions. */
  workerPrefix: string
  /** Ordered per-ticket rules; the first glob match wins. */
  rules: TicketRule[]
}

/**
 * Pulls a Session id out of an arbitrary event or tool payload.
 *
 * Harness payloads have carried `sessionId`, `session_id` and plain `session`
 * across releases, so all three are accepted. This is the one place that
 * knowledge lives; every governance plugin reads payloads through it.
 */
export function sessionIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  for (const key of ['sessionId', 'session_id', 'session'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** Glob supporting `*` (any run of characters) and `?` (one character). */
export function matchGlob(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  let source = ''
  for (const char of pattern) {
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`).test(value)
}

/** First rule whose glob matches `ticketId`, or `undefined` when none does. */
export function policyFor(ticketId: string, rules: readonly TicketRule[] = []): ResolvedTicketPolicy | undefined {
  for (const rule of rules) {
    if (matchGlob(rule.match, ticketId)) return { rule, ticketId }
  }
  return undefined
}
