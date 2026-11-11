import type { TicketDenyRule } from './ticket-rules.js'

export type Effect = 'allow' | 'deny' | 'ask'

/**
 * A single declarative policy rule. Constraints combine with AND:
 * a rule matches a call when the tool matches (if constrained) AND at least
 * one command matches (if constrained) AND at least one path matches (if
 * constrained). Rules are evaluated in `priority` order (higher first, ties
 * keep declaration order) and the first match wins.
 */
export interface PolicyRule {
  id: string
  effect: Effect
  /** Higher evaluated first. Default 0. */
  priority?: number
  /** Glob patterns on the tool name, e.g. ["bash", "edit_*"]. */
  tools?: string[]
  /**
   * Case-insensitive regex sources matched against command strings extracted
   * from tool args (see `commandArgs`). e.g. ["rm\\s+-rf\\s+/"].
   */
  commands?: string[]
  /** Glob patterns on path values extracted from tool args, e.g. ["/etc/**"]. */
  paths?: string[]
  /** Human-readable reason recorded in the audit log and deny messages. */
  reason?: string
}

export interface AuditConfig {
  enabled?: boolean
  /** Audit log path (JSONL). Default: <cwd>/.dsh-policy/audit.jsonl. */
  file?: string
  /** Rotate the file once it exceeds this size. Default: 5 MiB. */
  maxBytes?: number
}

/**
 * Ticket-scoped enforcement, driven by dsh-superagent tickets.
 *
 * When enabled, every tool call is first checked against the rule matching its
 * ticket id. `rules` here are the ticket rules; when `dsh-ticket-context` is
 * loaded its rule table is used instead and this list is ignored.
 */
export interface TicketConfig {
  /** Master switch for ticket-scoped enforcement. Default false. */
  enabled?: boolean
  /** Router Session id; without it only worker Sessions resolve a ticket. */
  masterId?: string
  /** Worker Session-id prefix (dsh-superagent uses `worker-`). */
  workerPrefix?: string
  /**
   * Prefer the `ticket` service from dsh-ticket-context (its rule table).
   * Default true; set false to use the `rules` below even when it is loaded.
   */
  useService?: boolean
  /** Ticket rules used when no `ticket` service is available. */
  rules?: TicketDenyRule[]
}

export interface PolicyConfig {
  /** Master switch — off by default so the harness keeps its own behavior. */
  enabled: boolean
  rules: PolicyRule[]
  /** Decision for calls that match no rule. Default: ask (fail-closed spirit). */
  defaultDecision?: Effect
  /** Evaluator errors deny the call instead of falling back. Default: true. */
  failClosed?: boolean
  /** Arg names whose string values are treated as paths. */
  pathArgs?: string[]
  /** Arg names whose string values are treated as command strings. */
  commandArgs?: string[]
  audit?: AuditConfig
  /** Ticket-scoped command/tool denial for dsh-superagent Sessions. */
  ticket?: TicketConfig
}

export interface Decision {
  decision: Effect
  ruleId?: string
  reason?: string
}

/** Normalized tool-call input for policy evaluation. */
export interface ToolCallInput {
  tool: string
  args?: unknown
  sessionId?: string
}

export interface AuditEntry {
  ts: string
  /** 'decision' = pre-execute verdict, 'outcome' = post-execute enrichment. */
  phase: 'decision' | 'outcome'
  session_id?: string
  tool: string
  args_hash?: string
  decision?: Effect
  rule_id?: string
  reason?: string
  outcome?: string
  policy_version: string
}

// Stamped onto every audit line. It has to track package.json: an operator
// reading the log while debugging a rule that "does not fire" will check this
// first, and a stale value sends them to the wrong version. `version.test.ts`
// fails when the two drift apart.
export const POLICY_VERSION = 'dsh-tool-policy@0.2.0'

export const DEFAULT_PATH_ARGS = ['path', 'file_path', 'filepath', 'filename', 'file', 'dir', 'directory', 'target'] as const

export const DEFAULT_COMMAND_ARGS = ['command', 'cmd', 'shell', 'script'] as const
