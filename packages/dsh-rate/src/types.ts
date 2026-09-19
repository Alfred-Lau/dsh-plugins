export const RATE_VERSION = '0.1.0'

export interface BackoffConfig {
  enabled?: boolean
  /** First-window length (default 30 s). */
  baseMs?: number
  /** Multiplier per consecutive 429 (default 2). */
  factor?: number
  /** Ceiling (default 10 min). */
  maxMs?: number
}

export interface BudgetConfig {
  /** Daily input+output token budget; 0 disables (default). */
  dailyTokens?: number
  /** Fraction of the budget at which a warning fires (default 0.8). */
  warnAt?: number
  /** What happens at 100% in enforce mode: log only, or deny tool calls. */
  criticalAction?: 'log' | 'block-tools'
}

export interface ToolStormConfig {
  /** Rolling window (default 60 s). */
  windowMs?: number
  /** Max tool calls inside the window; 0 disables (default). */
  maxCalls?: number
}

export interface RateAuditConfig {
  enabled?: boolean
  file?: string
  maxBytes?: number
}

export type RateMode = 'monitor' | 'enforce'

export interface RateConfig {
  enabled?: boolean
  /**
   * monitor = meter, warn and audit, never deny (default)
   * enforce = backoff windows / budget exhaustion / tool storms deny tool calls
   */
  mode?: RateMode
  backoff?: BackoffConfig
  budget?: BudgetConfig
  toolStorm?: ToolStormConfig
  audit?: RateAuditConfig
}

export interface RateAuditEntry {
  ts: string
  rate_version: string
  event: 'llm_usage' | 'llm_429' | 'llm_ok' | 'backoff_deny' | 'budget_deny' | 'budget_warn' | 'storm_deny' | 'storm_hit' | 'decision'
  session_id?: string
  tool?: string
  tokens?: number
  tokens_today?: number
  backoff_remaining_ms?: number
  window_calls?: number
  reason?: string
}
