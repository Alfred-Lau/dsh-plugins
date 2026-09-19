import { createHash } from 'node:crypto'
import { mkdirSync, appendFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { PII_VERSION, type PiiAuditEntry, type PiiAuditConfig } from './types.js'

export interface AuditLoggerOptions {
  enabled?: boolean
  file?: string
  maxBytes?: number
}

/**
 * JSONL audit trail: one line per decision/outcome, append-only, with
 * size-based rotation. Best-effort by design — a logging failure warns once
 * and never blocks (or crashes) the gate itself.
 *
 * Privacy invariant: entries carry PII *type counts* and 8-hex evidence
 * hashes, never raw matched text.
 */
export class AuditLogger {
  private readonly file?: string
  private readonly maxBytes: number
  private readonly enabled: boolean
  private dirReady = false
  private warned = false

  constructor(options: AuditLoggerOptions | undefined, cwd: string = process.cwd()) {
    this.enabled = options?.enabled !== false
    this.file = options?.file ?? `${cwd}/.dsh-pii-gate/audit.jsonl`
    this.maxBytes = options?.maxBytes ?? 5 * 1024 * 1024
  }

  get path(): string | undefined {
    return this.enabled ? this.file : undefined
  }

  log(entry: Omit<PiiAuditEntry, 'ts' | 'pii_version'> & { ts?: string }): void {
    if (!this.enabled || !this.file) return
    const record: PiiAuditEntry = {
      ...entry,
      ts: entry.ts ?? new Date().toISOString(),
      pii_version: PII_VERSION,
    }
    try {
      this.ensureDir()
      this.rotateIfNeeded()
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, { encoding: 'utf8' })
    } catch (err) {
      if (!this.warned) {
        this.warned = true
        console.warn(`[dsh-pii-gate] audit log unavailable (${(err as Error).message}); continuing without it`)
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
    mkdirSync(dirname(this.file), { recursive: true })
    this.dirReady = true
  }

  private rotateIfNeeded(): void {
    if (!this.file) return
    try {
      if (statSync(this.file).size < this.maxBytes) return
      renameSync(this.file, `${this.file}.${Date.now()}.1`)
    } catch {
      /* missing file is fine */
    }
  }
}
