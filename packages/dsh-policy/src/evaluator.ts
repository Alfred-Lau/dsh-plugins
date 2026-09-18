import { compileRules, extractCommands, extractPaths, type CompiledRule } from './matcher.js'
import {
  DEFAULT_COMMAND_ARGS,
  DEFAULT_PATH_ARGS,
  POLICY_VERSION,
  type Decision,
  type Effect,
  type PolicyConfig,
  type ToolCallInput,
} from './types.js'

export interface EvaluatorOptions {
  defaultDecision?: Effect
  failClosed?: boolean
  pathArgs?: string[]
  commandArgs?: string[]
}

/**
 * Rule evaluation: priority-ordered first-match-wins over the compiled rule
 * list, falling back to `defaultDecision` (default: ask). Config errors fail
 * loud (compile throws at load); runtime errors fail closed (deny).
 */
export class PolicyEvaluator {
  private readonly rules: CompiledRule[]
  private readonly defaultDecision: Effect
  private readonly failClosed: boolean
  private readonly pathArgs: string[]
  private readonly commandArgs: string[]

  constructor(config: PolicyConfig) {
    this.rules = compileRules(config.rules ?? [])
    this.defaultDecision = config.defaultDecision ?? 'ask'
    if (this.defaultDecision !== 'allow' && this.defaultDecision !== 'deny' && this.defaultDecision !== 'ask') {
      throw new Error(`dsh-policy: invalid defaultDecision "${String(this.defaultDecision)}"`)
    }
    this.failClosed = config.failClosed !== false
    this.pathArgs = config.pathArgs?.length ? config.pathArgs : [...DEFAULT_PATH_ARGS]
    this.commandArgs = config.commandArgs?.length ? config.commandArgs : [...DEFAULT_COMMAND_ARGS]
  }

  get ruleCount(): number {
    return this.rules.length
  }

  evaluate(input: ToolCallInput): Decision {
    try {
      const commands = extractCommands(input.args, this.commandArgs)
      const paths = extractPaths(input.args, this.pathArgs)
      for (const rule of this.rules) {
        if (!this.matchTools(rule, input.tool)) continue
        if (!this.matchAll(rule.commands, commands.length > 0 ? commands : undefined)) continue
        if (!this.matchAll(rule.paths, paths.length > 0 ? paths : undefined)) continue
        return {
          decision: rule.effect,
          ruleId: rule.id,
          reason: rule.reason ?? (rule.effect === 'ask' ? `matched rule ${rule.id}` : undefined),
        }
      }
      return {
        decision: this.defaultDecision,
        reason: `no rule matched (default: ${this.defaultDecision})`,
      }
    } catch (err) {
      const message = (err as Error)?.message ?? String(err)
      if (this.failClosed) {
        return { decision: 'deny', reason: `evaluator error (fail-closed): ${message}` }
      }
      return { decision: this.defaultDecision, reason: `evaluator error: ${message}` }
    }
  }

  private matchTools(rule: CompiledRule, tool: string): boolean {
    if (!rule.tools) return true
    return rule.tools.some((re) => re.test(tool))
  }

  /** Any-pattern semantics; constrained rules never match empty evidence. */
  private matchAll(patterns: RegExp[] | undefined, candidates: string[] | undefined): boolean {
    if (!patterns) return true
    if (!candidates || candidates.length === 0) return false
    return patterns.some((re) => candidates.some((c) => re.test(c)))
  }
}

export { POLICY_VERSION }
