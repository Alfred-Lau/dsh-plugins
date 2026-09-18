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

export const POLICY_VERSION = 'dsh-policy@0.1.0'

export const DEFAULT_PATH_ARGS = ['path', 'file_path', 'filepath', 'filename', 'file', 'dir', 'directory', 'target'] as const

export const DEFAULT_COMMAND_ARGS = ['command', 'cmd', 'shell', 'script'] as const
