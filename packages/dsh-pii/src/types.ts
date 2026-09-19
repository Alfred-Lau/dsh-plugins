export const PII_VERSION = '0.1.0'

export type PiiType =
  | 'email'
  | 'phone_cn'
  | 'phone_intl'
  | 'cn_id'
  | 'credit_card'
  | 'api_key'
  | 'ipv4'
  | 'ssn'
  | 'iban'
  | 'custom'

export interface PiiMatch {
  type: PiiType
  detector: string
  /** First 8 hex of sha256(match) — evidence without storing the raw value. */
  evidence: string
}

export interface PiiAuditEntry {
  ts: string
  pii_version: string
  phase: 'decision' | 'outcome'
  session_id?: string
  tool: string
  args_hash?: string
  /** decision phase: what the gate did; outcome phase: always 'observe'. */
  verdict: 'allow' | 'deny' | 'observe'
  matches: Record<string, number>
  total: number
  reason?: string
}

export interface PiiAuditConfig {
  enabled?: boolean
  file?: string
  maxBytes?: number
}

export interface CustomPattern {
  name: string
  /** JavaScript regex source; compiled with the 'g' flag. */
  pattern: string
}

export interface PiiConfig {
  enabled?: boolean
  /**
   * audit  = detect + audit + let the pipeline continue (default, observe-only)
   * block  = deny tool calls on outbound tools when PII is present
   */
  mode?: 'audit' | 'block'
  /** Tool globs considered outbound in block mode. */
  outboundTools?: string[]
  /** Tool globs never scanned / never denied. */
  exemptTools?: string[]
  /** Built-in detector toggles. */
  detectors?: Partial<
    Record<'email' | 'phone_cn' | 'phone_intl' | 'cn_id' | 'credit_card' | 'api_key' | 'ipv4' | 'ssn' | 'iban', boolean>
  >
  /** Extra regex detectors (name + source), evaluated as type 'custom'. */
  customPatterns?: CustomPattern[]
  /** Minimum total matches before block-mode denial (default 1). */
  minMatches?: number
  /** Scan tool results post-execute (audit-only, never denies). Default true. */
  scanResults?: boolean
  /** Upper bound per scanned string (guard against pathological payloads). */
  maxScanChars?: number
  audit?: PiiAuditConfig
}
