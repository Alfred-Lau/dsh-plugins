import { createHash } from 'node:crypto'
import { mkdirSync, appendFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { POLICY_VERSION, type AuditEntry, type AuditConfig } from './types.js'

export interface AuditLoggerOptions {
  enabled?: boolean
  file?: string
  maxBytes?: number
}

/**
 * JSONL audit trail: one line per decision/outcome, append-only, with
 * size-based rotation. Auditing is best-effort by design — a logging failure
 * warns once and never blocks (or crashes) the policy decision itself.
 */
export class AuditLogger {
  private readonly file?: string
  private readonly maxBytes: number
  private readonly enabled: boolean
  private dirReady = false
  private warned = false

  constructor(options: AuditLoggerOptions | undefined, cwd: string = process.cwd()) {
    this.enabled = options?.enabled !== false
    this.file = options?.file ?? `${cwd}/.dsh-policy/audit.jsonl`
    this.maxBytes = options?.maxBytes ?? 5 * 1024 * 1024
  }

  get path(): string | undefined {
    return this.enabled ? this.file : undefined
  }

  log(entry: Omit<AuditEntry, 'ts' | 'policy_version'> & { ts?: string }): void {
    if (!this.enabled || !this.file) return
    const record: AuditEntry = {
      ...entry,
      ts: entry.ts ?? new Date().toISOString(),
      policy_version: POLICY_VERSION,
    }
    try {
      this.ensureDir()
      this.rotateIfNeeded()
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, { encoding: 'utf8' })
    } catch (err) {
      if (!this.warned) {
        this.warned = true
        // Audit is best-effort: warn once, never throw.
        console.warn(`[dsh-policy] audit log unavailable (${(err as Error).message}); continuing without it`)
      }
    }
  }

  hashArgs(args: unknown): string | undefined {
    if (args === undefined || args === null) return undefined
    try {
      return createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16)
    } catch {
      return undefined
    }
  }

  private ensureDir(): void {
    if (this.dirReady || !this.file) return
    const dir = dirname(this.file)
    mkdirSync(dir, { recursive: true })
    this.dirReady = true
  }

  private rotateIfNeeded(): void {
    if (!this.file) return
    try {
      const size = statSync(this.file).size
      if (size < this.maxBytes) return
      renameSync(this.file, `${this.file}.${Date.now()}`)
    } catch {
      // stat failed (file absent) — nothing to rotate.
    }
  }
}
