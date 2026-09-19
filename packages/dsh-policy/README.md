# dsh-tool-policy

> npm package name is `dsh-tool-policy` (`dsh-policy` on the registry is a reserved placeholder); the harness plugin id stays `dsh-policy`.

Declarative tool-call permission control for DeepSeek Harness. Rules decide
`allow` / `deny` / `ask` **before** a tool runs (`tools/pre-execute`), outcomes
are recorded after (`tools/post-execute`), and every decision lands in a JSONL
audit log.

Design principles:

- **Fail loud on config errors** — invalid effects, broken regexes, and bad
  rule ids throw at plugin load, never silently disable your guardrails.
- **Fail closed at runtime** — evaluator errors deny (configurable), unmatched
  calls fall back to `defaultDecision` (default `ask`).
- **No silent bypass** — a call matching no rule is `ask`, not `allow`.

## Rule model

```ts
interface PolicyRule {
  id: string            // unique, referenced by the audit log
  effect: 'allow' | 'deny' | 'ask'
  priority?: number     // default 0; higher wins; ties keep declaration order
  tools?: string[]      // glob patterns, e.g. ["bash", "write*", "search_*"]
  commands?: string[]   // regex sources, matched against extracted commands
  paths?: string[]      // glob patterns, matched against extracted paths
  reason?: string       // surfaced in decisions and the audit log
}
```

- **Matching is conjunctive**: a rule applies when its `tools` AND `commands`
  AND `paths` constraints all match (each dimension is an OR across its own
  patterns). Rules with no constraints never match (empty evidence is not a
  match) — use `defaultDecision` for the catch-all.
- **First match wins** after sorting by `priority` (descending, stable).
- **Command extraction** pulls string values under `command`/`cmd`/`shell`/`script`
  keys (nested objects and arrays included) and matches them as regexes.
- **Path extraction** takes values under `path`/`file_path`/… keys, any
  standalone absolute-path value (`/…`, `C:\…`), and absolute paths embedded in
  free-form strings; Windows separators are normalized before matching.
- **Globs**: `*` (no separators), `**` (any), `?` (one char); everything else is
  escaped. Paths are normalized to `/` first.

## Install & enable

```bash
dsh plugin --profile web add dsh-tool-policy
```

The bundled row ships `enabled: false` (the harness keeps its own approval flow
until you opt in). A commented starter ruleset ships in
[`cordis.patch.yml`](./cordis.patch.yml) — deny destructive commands, deny
sensitive paths, allow everyday dev commands, ask before file writes, allow
read-only tools.

```yaml
- insert:
  - id: dsh-policy
    name: dsh-tool-policy
    config:
      enabled: true
      defaultDecision: ask
      failClosed: true
      rules:
        - id: deny-destructive-commands
          effect: deny
          priority: 100
          tools: ["bash"]
          commands: ["rm\\s+-rf\\s+/(?!tmp|var/folders)", "git\\s+push\\s+.*--force"]
          reason: "Destructive command blocked"
        - id: deny-sensitive-paths
          effect: deny
          priority: 90
          paths: ["/etc/**", "/root/.ssh/**", "**/.env", "**/*.pem"]
        - id: allow-dev-commands
          effect: allow
          priority: 50
          tools: ["bash"]
          commands: ["^(git|pnpm|npm|node|pytest|python|ls|cat|grep|rg|mkdir)\\b"]
```

> A profile-level patch targeting this id **replaces the whole row config**
> (no deep merge) — restate every key you want to keep.

## Configuration

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | No-op when false. |
| `rules` | `PolicyRule[]` | `[]` | See rule model above. Invalid rules throw at load (fail loud). |
| `defaultDecision` | `'allow' \| 'deny' \| 'ask'` | `'ask'` | Decision for calls matching no rule. |
| `failClosed` | `boolean` | `true` | Evaluator/internal errors → `deny` instead of `defaultDecision`. |
| `pathArgs` | `string[]` | `['path','file_path','filepath','filename','file','dir','directory','target']` | Arg keys treated as path carriers. |
| `commandArgs` | `string[]` | `['command','cmd','shell','script']` | Arg keys treated as command carriers. |
| `audit.enabled` | `boolean` | `true` | Write JSONL audit entries. |
| `audit.file` | `string` | `<cwd>/.dsh-policy/audit.jsonl` | Audit sink. |

## Audit log

JSONL, one entry per line, phase-tagged:

```json
{"ts":1760000000000,"phase":"decision","session_id":"s1","tool":"bash","args_hash":"3f9a…","decision":"deny","rule_id":"deny-destructive-commands","reason":"…","policy_version":"dsh-policy@0.1.0"}
{"ts":1760000000500,"phase":"outcome","tool":"bash","args_hash":"3f9a…","outcome":"blocked","policy_version":"dsh-policy@0.1.0"}
```

- Arg values are **hashed** (sha256, first 16 hex chars) — the log proves what
  was evaluated without storing raw payloads.
- Rotates at 5 MiB by renaming to `audit.jsonl.<timestamp>`.
- Audit write failures warn once and never throw into the tool path.

## Relationship to other solutions

- `dsh-permission-rules` (PerryLink) covers minimal allow/deny lists with an
  audit trail. `dsh-tool-policy` adds the three-dimensional rule model (tool ×
  command × path), priorities with first-match-wins, regex command matching,
  embedded-path extraction, an explicit `ask` effect wired into the approval
  chain, and fail-closed defaults — a superset aimed at unattended/CI profiles.
- Claude Code's `PreToolUse` hooks and Gemini CLI's policy engine solve the same
  problem in their own ecosystems; `dsh-tool-policy` ports that posture to dsh.

## Library use

The evaluator and helpers are exported for standalone use:

```ts
import { PolicyEvaluator, globToRegExp, extractCommands, extractPaths } from 'dsh-tool-policy'

const ev = new PolicyEvaluator(rules, { defaultDecision: 'ask', failClosed: true })
ev.evaluate({ tool: 'bash', args: { command: 'git push --force' }, sessionId: 's1' })
// => { decision: 'deny', ruleId: 'deny-destructive-commands', reason: '…' }
```

## Compatibility

Targets `@deepseek-ai/cordis ^4.0.1`. See the repo-level
[compatibility policy](../../README.md#compatibility-policy) and the monthly CI job.

## License

MIT
