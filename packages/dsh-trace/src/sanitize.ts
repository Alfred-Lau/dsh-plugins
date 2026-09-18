import type { SanitizeConfig } from './types.js'

/**
 * Sanitize-before-send: structural key redaction + secret pattern masking +
 * character budgets. Everything runs BEFORE a record is queued, buffered or
 * transmitted, so no backend ever sees unsanitized content.
 */

/** Key-name substrings always treated as secrets (lowercase match). */
export const BUILTIN_REDACT_KEYS = [
  'key',
  'token',
  'secret',
  'password',
  'authorization',
  'credential',
  'apikey',
] as const

/** Built-in secret patterns (API keys, SCM tokens, cloud keys, auth headers, private keys). */
export const BUILTIN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
]

export interface Sanitizer {
  /** Redact + truncate an arbitrary JSON-ish value. */
  value(input: unknown, budgetChars?: number): unknown
  /** Redact + truncate a plain string (prompt/completion bodies). */
  text(input: unknown, budgetChars: number): string
  /** Redact + truncate a span attribute value. */
  attribute(input: unknown): string | number | boolean
}

export function createSanitizer(cfg: SanitizeConfig | undefined): Sanitizer {
  const enabled = cfg?.enabled !== false
  const redactKeys = [...BUILTIN_REDACT_KEYS, ...(cfg?.redactKeys ?? []).map((k) => k.toLowerCase())]
  const extraPatterns: RegExp[] = []
  if (cfg?.redactPatterns) {
    for (const src of cfg.redactPatterns) {
      try {
        extraPatterns.push(new RegExp(src, 'g'))
      } catch {
        // invalid user regex: fail loud at config level is loader's job; here
        // we skip and continue — sanitization must never crash the harness.
      }
    }
  }
  const budgets = {
    prompt: cfg?.truncatePromptChars ?? 4_000,
    completion: cfg?.truncateCompletionChars ?? 4_000,
    toolInput: cfg?.truncateToolInputChars ?? 2_000,
    toolOutput: cfg?.truncateToolOutputChars ?? 2_000,
    attribute: cfg?.truncateAttributeChars ?? 512,
  }

  const isSecretKey = (key: string): boolean => {
    if (!enabled) return false
    const k = key.toLowerCase()
    return redactKeys.some((frag) => k.includes(frag))
  }

  const maskString = (input: string): string => {
    if (!enabled) return input
    let out = input
    for (const re of BUILTIN_PATTERNS) out = out.replace(re, '[REDACTED]')
    for (const re of extraPatterns) out = out.replace(re, '[REDACTED]')
    return out
  }

  const walk = (input: unknown, depth: number): unknown => {
    if (depth > 12) return '[DEPTH_LIMIT]'
    if (typeof input === 'string') return maskString(input)
    if (typeof input === 'number' || typeof input === 'boolean' || input === null || input === undefined) {
      return input
    }
    if (Array.isArray(input)) return input.map((v) => walk(v, depth + 1))
    if (typeof input === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        out[k] = isSecretKey(k) ? '[REDACTED]' : walk(v, depth + 1)
      }
      return out
    }
    return String(input)
  }

  const truncate = (text: string, max: number): string => {
    if (text.length <= max) return text
    return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`
  }

  const stringify = (input: unknown): string => {
    if (typeof input === 'string') return input
    if (input === undefined || input === null) return ''
    try {
      return JSON.stringify(input)
    } catch {
      return String(input)
    }
  }

  return {
    value(input, budgetChars) {
      const walked = walk(input, 0)
      if (budgetChars === undefined) return walked
      if (typeof walked === 'string') return truncate(walked, budgetChars)
      const str = stringify(walked)
      return truncate(str, budgetChars)
    },
    text(input, budgetChars) {
      return truncate(maskString(stringify(input)), budgetChars)
    },
    attribute(input) {
      if (typeof input === 'number' && Number.isFinite(input)) return input
      if (typeof input === 'boolean') return input
      const s = truncate(maskString(stringify(input)), budgets.attribute)
      return s
    },
  }
}
