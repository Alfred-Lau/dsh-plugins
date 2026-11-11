/**
 * Ticket-scoped command denial — closes the bypass dsh-superagent documents.
 *
 * Super-agent's `blockedCommands` matches the command name at a command
 * position, so `/usr/bin/git push` and `./node_modules/.bin/gh` slip through.
 * This module compiles each blocked name into a regex that also accepts any
 * path prefix, then applies it to the commands extracted from a tool call.
 *
 * It is a defence-in-depth layer, not a sandbox: deliberate obfuscation
 * (`g""it`, a base64-decoded payload) is out of scope, and the docs say so.
 */

/** Glob over the ticket id, compiled to a deny rule. */
export interface TicketDenyRule {
  /** Ticket-id glob, e.g. `fix-*`. */
  match: string
  /** Command names that must never run for this ticket. */
  blockedCommands: string[]
  /** Tool-name globs the ticket may call. Empty = unrestricted. */
  allowedTools?: string[]
  /** Soft budget, surfaced to dsh-cost-eval; not enforced here. */
  budgetUsd?: number
}

export interface CompiledTicketDenyRule {
  match: string
  matchRegExp: RegExp
  /** One regex per blocked command name; any match denies the call. */
  commandRegExps: { command: string; regExp: RegExp }[]
  allowedToolRegExps: RegExp[]
  budgetUsd?: number
}

export interface TicketScopeLike {
  role: 'router' | 'worker'
  ticketId?: string
}

export interface TicketDenyVerdict {
  decision: 'deny'
  reason: string
  ruleId: string
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g

function escapeRegExp(value: string): string {
  return value.replace(REGEX_META, '\\$&')
}

/** Compiles a glob (`*`, `?`) into an anchored regex. */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (const char of glob) {
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else source += escapeRegExp(char)
  }
  return new RegExp(`^${source}$`)
}

/**
 * Compiles one blocked command name into a regex that also matches the same
 * name behind any path prefix.
 *
 * Matches, for `git`:
 *   `git push`            — at a command position
 *   `/usr/bin/git push`   — absolute path
 *   `./node_modules/.bin/git` — relative path
 *   `env git push`        — after another command
 *
 * The command position is the start of the string or a shell separator
 * (`;`, `&`, `|`, `(`, `{`, `!`, backtick, newline, `$(`), optionally after
 * leading whitespace. The trailing boundary keeps `gitlab-cli` from matching
 * `git`.
 */
export function compileBlockedCommand(command: string): RegExp {
  const name = escapeRegExp(command.trim())
  // A path prefix may contain anything but separators and whitespace.
  const prefix = String.raw`(?:[^\s;&|()<>]*\/)?`
  const start = String.raw`(?:^|[\s;&|({!\x60$])`
  const end = String.raw`(?=[\s;&|()<>)\x60'"]|$)`
  return new RegExp(`${start}${prefix}${name}${end}`)
}

/** Compiles the configured ticket rules; invalid globs/commands throw at load time. */
export function compileTicketRules(rules: readonly TicketDenyRule[] = []): CompiledTicketDenyRule[] {
  return rules.map(rule => {
    const commands = (rule.blockedCommands ?? []).filter(c => typeof c === 'string' && c.trim().length > 0)
    return {
      match: rule.match,
      matchRegExp: globToRegExp(rule.match),
      commandRegExps: commands.map(command => ({ command, regExp: compileBlockedCommand(command) })),
      allowedToolRegExps: (rule.allowedTools ?? []).map(globToRegExp),
      ...(rule.budgetUsd === undefined ? {} : { budgetUsd: rule.budgetUsd }),
    }
  })
}

/**
 * Picks the first rule whose ticket glob matches.
 *
 * Routers resolve against the literal `(router)` so a catch-all `*` rule can
 * cover them too, matching how dsh-cost-eval labels them.
 */
export function ruleForTicket(
  scope: TicketScopeLike | undefined,
  rules: readonly CompiledTicketDenyRule[],
): CompiledTicketDenyRule | undefined {
  if (!scope) return undefined
  const id = scope.role === 'router' ? '(router)' : scope.ticketId
  if (!id) return undefined
  return rules.find(rule => rule.matchRegExp.test(id))
}

/**
 * Decides whether a tool call violates the ticket's deny rule.
 *
 * Deny reasons name the ticket and the command, so the audit trail explains
 * itself without needing the config row.
 */
export function checkTicketDeny(
  call: { tool: string; args?: unknown },
  scope: TicketScopeLike | undefined,
  rules: readonly CompiledTicketDenyRule[],
  extractCommands: (args: unknown) => string[],
): TicketDenyVerdict | undefined {
  const rule = ruleForTicket(scope, rules)
  if (!rule) return undefined
  const ticketId = scope!.role === 'router' ? '(router)' : scope!.ticketId!

  if (rule.allowedToolRegExps.length > 0 && !rule.allowedToolRegExps.some(re => re.test(call.tool))) {
    return {
      decision: 'deny',
      reason: `tool "${call.tool}" is not allowed for ticket ${ticketId}`,
      ruleId: `ticket:${rule.match}:tools`,
    }
  }

  if (rule.commandRegExps.length === 0) return undefined
  const commands = extractCommands(call.args)
  for (const command of commands) {
    for (const { command: name, regExp } of rule.commandRegExps) {
      if (regExp.test(command)) {
        return {
          decision: 'deny',
          reason: `command "${name}" is blocked for ticket ${ticketId} (matched: ${command.slice(0, 120)})`,
          ruleId: `ticket:${rule.match}:cmd:${name}`,
        }
      }
    }
  }
  return undefined
}
