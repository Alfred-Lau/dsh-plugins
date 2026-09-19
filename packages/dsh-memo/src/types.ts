export const MEMO_VERSION = '0.1.0'

export type MemoMode = 'hint' | 'inject'

export interface MemoEntry {
  key: string
  tool: string
  value: unknown
  storedAt: number
  expiresAt: number
  hits: number
}

export interface MemoAuditConfig {
  enabled?: boolean
  file?: string
  maxBytes?: number
}

export interface PerToolTtl {
  tool: string
  ttlMs: number
}

export interface MemoAuditEntry {
  ts: string
  memo_version: string
  event: 'hit' | 'miss' | 'store' | 'skip' | 'evict'
  session_id?: string
  tool: string
  key: string
  age_ms?: number
  reason?: string
}

export interface MemoConfig {
  enabled?: boolean
  /**
   * hint   = a cache hit DENIES the re-execution with an explanatory reason
   *          carrying the cached preview (safe default; the model can bypass
   *          with the fresh flag).
   * inject = EXPERIMENTAL: the verdict additionally carries the full cached
   *          result (`result` field) for harnesses that honor it.
   */
  mode?: MemoMode
  /** TTL for tools without a per-tool override (default 10 min). */
  defaultTtlMs?: number
  /** Per-tool TTL overrides (longest match on tool name wins). */
  perToolTtl?: PerToolTtl[]
  /** LRU capacity (default 256). */
  maxEntries?: number
  /** Tool globs never cached / never served (mutating/outbound by default). */
  excludeTools?: string[]
  /** When non-empty, ONLY these tool globs participate. */
  includeTools?: string[]
  /** Argument flag that bypasses cache lookup (default `_memoFresh`). */
  freshFlag?: string
  audit?: MemoAuditConfig
}
