import { DEFAULT_COMMAND_ARGS, DEFAULT_PATH_ARGS, type PolicyRule } from './types.js'

/**
 * Matching primitives: glob (tool names, paths) and regex (commands).
 * Path globs use `/` semantics; Windows-style separators are normalized to
 * `/` before matching. No runtime dependencies — the glob engine is a small
 * segment-based translator (`**` crosses segments, `*` and `?` do not).
 */

const REGEX_ESCAPE = /[.+^${}()|[\]\\]/g

/** Compile a glob into an anchored RegExp. Throws on pathological input. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i] as string
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:[^/]*/)*' // `**/` matches zero or more segments
          i += 3
          continue
        }
        if (glob[i - 1] === '/') {
          re += '.*' // leading `/x/**` matches everything below
          i += 2
          continue
        }
        re += '.*'
        i += 2
        continue
      }
      re += '[^/]*'
      i++
      continue
    }
    if (c === '?') {
      re += '[^/]'
      i++
      continue
    }
    re += c.replace(REGEX_ESCAPE, '\\$&')
    i++
  }
  return new RegExp(`^${re}$`)
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/')
}

export interface CompiledRule {
  id: string
  effect: 'allow' | 'deny' | 'ask'
  reason?: string
  tools?: RegExp[]
  commands?: RegExp[]
  paths?: RegExp[]
}

/** Compile user rules; invalid regex/glob sources throw (fail loud at load). */
export function compileRules(rules: PolicyRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = rules.map((rule, index) => {
    if (!rule.id) throw new Error(`dsh-policy: rule at index ${index} is missing an id`)
    if (rule.effect !== 'allow' && rule.effect !== 'deny' && rule.effect !== 'ask') {
      throw new Error(`dsh-policy: rule "${rule.id}" has invalid effect "${String(rule.effect)}"`)
    }
    const out: CompiledRule = { id: rule.id, effect: rule.effect, reason: rule.reason }
    if (rule.tools?.length) out.tools = rule.tools.map(globToRegExp)
    if (rule.commands?.length) out.commands = rule.commands.map((src) => new RegExp(src, 'i'))
    if (rule.paths?.length) out.paths = rule.paths.map((g) => globToRegExp(normalizePath(g)))
    return out
  })
  // Higher priority first; ties keep declaration order (stable sort).
  return compiled
    .map((rule, index) => ({ rule, index, priority: rules[index]?.priority ?? 0 }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .map((x) => x.rule)
}

/**
 * Extract command strings from tool args: string (or string[]) values under
 * any of `commandArgs` keys. Nested objects are traversed (bounded depth).
 */
export function extractCommands(args: unknown, commandArgs: string[] = [...DEFAULT_COMMAND_ARGS]): string[] {
  const out: string[] = []
  const keys = new Set(commandArgs)
  walk(args, 0, (key, value) => {
    if (key !== undefined && keys.has(key) && typeof value === 'string' && value.trim()) {
      out.push(value)
    }
  })
  return out
}

/**
 * Extract path-like strings: values under `pathArgs` keys, plus standalone
 * absolute paths (Unix `/...`, Windows `C:\...`) appearing as argument values.
 */
export function extractPaths(args: unknown, pathArgs: string[] = [...DEFAULT_PATH_ARGS]): string[] {
  const out = new Set<string>()
  const keys = new Set(pathArgs)
  walk(args, 0, (key, value) => {
    if (typeof value !== 'string' || !value.trim()) return
    if (key !== undefined && keys.has(key)) {
      out.add(normalizePath(value))
      return
    }
    if (isAbsolutePath(value)) {
      out.add(normalizePath(value))
      return
    }
    // Scan free-form strings for embedded absolute paths (notes, messages, …).
    for (const m of value.matchAll(EMBEDDED_PATH_RE)) {
      const token = m[0]
      if (token && token.length > 1) out.add(normalizePath(token))
    }
  })
  return [...out]
}

/**
 * Matches a Unix absolute path (`/etc/passwd`) or a Windows absolute path
 * (`C:\Users\x\file`) embedded inside free-form text. Trailing punctuation is
 * excluded by the char class.
 */
const EMBEDDED_PATH_RE = /(?:[A-Za-z]:[\\/][^\s"'`;,)]+)|(?:\/(?:[\w.@+-]+\/)*[\w.@+-]+)/g

/** Unix absolute (/...) or Windows absolute (C:\..., C:/...). */
export function isAbsolutePath(v: string): boolean {
  return /^\/[^/]/.test(v) || /^[A-Za-z]:[/\\]/.test(v)
}

function walk(
  node: unknown,
  depth: number,
  visit: (key: string | undefined, value: unknown) => void,
  key?: string,
): void {
  if (depth > 12) return
  if (Array.isArray(node)) {
    // Array items inherit the key of the entry that held the array.
    for (const item of node) walk(item, depth + 1, visit, key)
    return
  }
  if (typeof node === 'object' && node !== null) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      walk(v, depth + 1, visit, k)
    }
    return
  }
  visit(key, node)
}
