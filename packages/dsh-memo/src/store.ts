import { createHash } from 'node:crypto'
import type { MemoConfig, MemoEntry } from './types.js'

/**
 * TTL + LRU cache keyed by a stable hash of (tool, args).
 *
 * - Keys are content-addressed: same tool + same args => same key, so the
 *   cache is safe to share across sessions of the same profile.
 * - LRU bound: inserting beyond capacity evicts the least-recently-used entry
 *   (Map preserves insertion order; a get refreshes it).
 * - Expired entries are treated as misses and lazily removed.
 */
export class MemoStore {
  private readonly map = new Map<string, MemoEntry>()
  private readonly maxEntries: number
  private readonly defaultTtlMs: number
  private readonly perTool: { regex: RegExp; ttlMs: number }[]
  private evictions = 0

  constructor(cfg: Pick<MemoConfig, 'maxEntries' | 'defaultTtlMs' | 'perToolTtl'> | undefined, compileGlob: (g: string) => RegExp) {
    this.maxEntries = Math.max(1, cfg?.maxEntries ?? 256)
    this.defaultTtlMs = Math.max(0, cfg?.defaultTtlMs ?? 600_000)
    this.perTool = (cfg?.perToolTtl ?? []).map((p) => ({ regex: compileGlob(p.tool), ttlMs: Math.max(0, p.ttlMs) }))
  }

  get size(): number {
    return this.map.size
  }

  get evictionCount(): number {
    return this.evictions
  }

  ttlFor(tool: string): number {
    for (const p of this.perTool) {
      if (p.regex.test(tool)) return p.ttlMs
    }
    return this.defaultTtlMs
  }

  lookup(tool: string, args: unknown, now: number): { entry?: MemoEntry } {
    const key = cacheKey(tool, args)
    const entry = this.map.get(key)
    if (!entry) return {}
    if (entry.expiresAt <= now) {
      this.map.delete(key)
      return {}
    }
    // Refresh LRU position + hit counter.
    this.map.delete(key)
    entry.hits++
    this.map.set(key, entry)
    return { entry }
  }

  store(tool: string, args: unknown, value: unknown, now: number): MemoEntry | undefined {
    const ttl = this.ttlFor(tool)
    if (ttl <= 0) return undefined
    const key = cacheKey(tool, args)
    // Delete first so re-storing refreshes LRU order.
    this.map.delete(key)
    const entry: MemoEntry = {
      key,
      tool,
      value,
      storedAt: now,
      expiresAt: now + ttl,
      hits: 0,
    }
    this.map.set(key, entry)
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next()
      if (oldest.done) break
      this.map.delete(oldest.value)
      this.evictions++
    }
    return entry
  }

  clear(): void {
    this.map.clear()
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')
  return `{${body}}`
}

export function cacheKey(tool: string, args: unknown): string {
  return createHash('sha256').update(`${tool}\u0000${stableStringify(args)}`).digest('hex').slice(0, 24)
}

/** Bounded preview of a cached value for verdict reasons. */
export function preview(value: unknown, maxChars = 160): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  } catch {
    text = '[unserializable]'
  }
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
}
