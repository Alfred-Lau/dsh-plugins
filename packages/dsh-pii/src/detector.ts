import { createHash } from 'node:crypto'
import type { PiiMatch, PiiType } from './types.js'

/**
 * PII detection engine.
 *
 * Every built-in detector pairs a structural regex with a semantic validator
 * (checksum / Luhn) so long digit runs — order numbers, timestamps — do not
 * masquerade as IDs or cards. Evidence is always a truncated hash: raw match
 * text never leaves the detector, never lands in logs or audit files.
 */

export interface DetectorDef {
  id: string
  type: PiiType
  regex: RegExp
  validate?: (candidate: string) => boolean
  enabledByDefault: boolean
}

const CN_ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const CN_ID_MAP = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']

function validCnId(candidate: string): boolean {
  const body = candidate.slice(0, 17)
  if (!/^\d{17}$/.test(body)) return false
  const check = candidate.charAt(17).toUpperCase()
  let sum = 0
  for (let i = 0; i < 17; i++) sum += Number(body.charAt(i)) * CN_ID_WEIGHTS[i]!
  return CN_ID_MAP[sum % 11] === check
}

function validLuhn(candidate: string): boolean {
  let sum = 0
  let alt = false
  for (let i = candidate.length - 1; i >= 0; i--) {
    let d = Number(candidate[i])
    if (!Number.isFinite(d)) return false
    if (alt) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}

function hashEvidence(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8)
}

export const DETECTORS: DetectorDef[] = [
  {
    id: 'email',
    type: 'email',
    regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
    enabledByDefault: true,
  },
  {
    id: 'phone_cn',
    type: 'phone_cn',
    regex: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    enabledByDefault: true,
  },
  {
    id: 'phone_intl',
    type: 'phone_intl',
    regex: /(?<![\d+])\+\d{1,3}[- ]?\d{6,14}(?!\d)/g,
    enabledByDefault: true,
  },
  {
    id: 'cn_id',
    type: 'cn_id',
    regex: /(?<!\d)\d{17}[\dXx](?!\d)/g,
    validate: validCnId,
    enabledByDefault: true,
  },
  {
    id: 'credit_card',
    type: 'credit_card',
    regex: /(?<!\d)\d{13,19}(?!\d)/g,
    validate: validLuhn,
    enabledByDefault: true,
  },
  {
    id: 'api_key',
    type: 'api_key',
    regex:
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})\b/g,
    enabledByDefault: true,
  },
  {
    id: 'ssn',
    type: 'ssn',
    regex: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g,
    enabledByDefault: true,
  },
  {
    id: 'ipv4',
    type: 'ipv4',
    regex:
      /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g,
    enabledByDefault: false,
  },
  {
    id: 'iban',
    type: 'iban',
    regex: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}\b/g,
    enabledByDefault: false,
  },
]

export interface CompiledDetector extends DetectorDef {
  source: 'builtin' | 'custom'
}

export function compileDetectors(cfg: {
  detectors?: Partial<Record<string, boolean>>
  customPatterns?: { name: string; pattern: string }[]
  logger?: { warn(msg: string): void }
}): CompiledDetector[] {
  const out: CompiledDetector[] = []
  const toggles = cfg.detectors ?? {}
  for (const def of DETECTORS) {
    const on = toggles[def.id] ?? def.enabledByDefault
    if (on) out.push({ ...def, source: 'builtin' })
  }
  for (const cp of cfg.customPatterns ?? []) {
    try {
      // Extra guard: zero-length matches would loop forever.
      const probe = new RegExp(cp.pattern, 'g')
      if (probe.exec('') !== null) throw new Error('matches the empty string')
      out.push({
        id: cp.name,
        type: 'custom',
        regex: new RegExp(cp.pattern, 'g'),
        enabledByDefault: true,
        source: 'custom',
      })
    } catch (err) {
      cfg.logger?.warn(`[dsh-pii-gate] custom pattern '${cp.name}' ignored: ${(err as Error).message}`)
    }
  }
  return out
}

export class PiiDetector {
  private readonly detectors: CompiledDetector[]
  private readonly maxScanChars: number

  constructor(detectors: CompiledDetector[], maxScanChars = 100_000) {
    this.detectors = detectors
    this.maxScanChars = maxScanChars
  }

  get size(): number {
    return this.detectors.length
  }

  /** Scan one string. Regex state is reset per call (shared 'g' regexes). */
  scan(text: string): PiiMatch[] {
    if (!text || text.length > this.maxScanChars) return []
    const matches: PiiMatch[] = []
    for (const def of this.detectors) {
      def.regex.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = def.regex.exec(text)) !== null) {
        if (m[0].length === 0) {
          def.regex.lastIndex++
          continue
        }
        if (def.validate && !def.validate(m[0])) continue
        matches.push({ type: def.type, detector: def.id, evidence: hashEvidence(m[0]) })
        // One hit per detector per string is enough for counting purposes.
        def.regex.lastIndex = 0
        break
      }
    }
    return matches
  }
}

/** Recursively collect string values from an arbitrary JSON-ish payload. */
export function collectStrings(value: unknown, depth = 8): string[] {
  if (depth <= 0) return []
  if (typeof value === 'string') return [value]
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return []
  if (Array.isArray(value)) return value.flatMap((v) => collectStrings(v, depth - 1))
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((v) => collectStrings(v, depth - 1))
  }
  return []
}

export function countByType(matches: PiiMatch[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of matches) out[m.type] = (out[m.type] ?? 0) + 1
  return out
}
