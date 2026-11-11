# dsh-ticket-context

> Ticket scope for [`dsh-superagent`](https://github.com/deepseek-ai/dsh-superagent-prototype).
> The other governance plugins (`dsh-trace`, `dsh-cost-eval`, `dsh-tool-policy`,
> `dsh-pii-gate`, `dsh-rate-shield`, `dsh-tool-memo`) use it to answer one
> question: **which ticket am I acting for right now?**

Super-agent runs a Router Session and one Worker Session per ticket. Everything
it does is scoped to a ticket — cost, permissions, redaction, rate limits — but
the Harness plugins running inside those sessions have no idea which ticket they
are inside. This package closes that gap **without changing a line of
Super-agent**.

## How the ticket is identified

dsh-superagent already encodes the ticket in the Session id
(`src/executor/dsh.ts`):

```ts
export const workerSessionId = (ticketId: string) => `worker-${ticketId}`
export const ticketOfSession = (sessionId: string) =>
  sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined
```

and uses it itself to pick the router vs worker preset
(`src/app/sessions.ts`). Harness payloads already carry `sessionId`, so the
ticket id is available on every tool call and every session event. No environment
variable, no patch, no shared store.

Why not `DSH_SUPERAGENT_TICKET`? Because Super-agent only injects it into the
**prepare command's** child shell, not into the Harness process that hosts the
plugins. The Session id is the only key visible on both sides.

## Usage

Pure helpers — no plugin load required:

```ts
import { scopeOf, sessionIdOf, policyFor } from 'dsh-ticket-context'

const scope = scopeOf(sessionIdOf(payload), { masterId: process.env.DSH_MASTER_ID })
// { role: 'worker', sessionId: 'worker-t-42', ticketId: 't-42' }
// { role: 'router', sessionId: 'master-1' }
// undefined  → not a Super-agent session
```

As a Cordis service, for plugins that want the configured rule table:

```ts
export const inject = ['ticket']

export function apply(ctx: Context, config) {
  ctx.on('tools/pre-execute', payload => {
    const scope = ctx.ticket.scopeFrom(payload)
    if (!scope) return undefined
    const policy = scope.ticketId ? ctx.ticket.policyFor(scope.ticketId) : undefined
    // ... decide using scope + policy
  })
}
```

`ctx.ticket` exposes `scopeOf`, `scopeFrom`, `policyFor`, `masterId`,
`workerPrefix` and `rules`. When the plugin is not installed, `inject: ['ticket']`
simply never fires — importing the pure helpers keeps the consumer working.

## Configuration

```yaml
- insert:
  - id: dsh-ticket
    name: dsh-ticket-context
    config:
      enabled: true
      masterId: ""              # router Session id; empty = workers only
      workerPrefix: "worker-"
      rules:
        - match: "fix-*"
          tools: ["read", "edit", "bash"]
          blockedCommands: ["git", "gh", "lark-cli"]
          budgetUsd: 2.5
        - match: "*"
          blockedCommands: ["rm", "dd", "mkfs"]
```

| Key | Meaning |
| --- | --- |
| `masterId` | Router Session id. Without it only workers resolve, so router-side checks never fire — the plugin never claims a scope it cannot prove. |
| `workerPrefix` | Session-id prefix for workers. Change only if Super-agent changes its naming. |
| `rules[].match` | Glob over the ticket id (`*`, `?`). First match wins. |
| `rules[].tools` | Tool-name globs this ticket may call. Empty = no restriction. |
| `rules[].blockedCommands` | Command names this ticket must never run. |
| `rules[].budgetUsd` | Soft budget, read by `dsh-cost-eval` when installed. |

## What this package deliberately does not do

- **No ticket lifecycle.** It reads ids; it never creates, assigns or closes
  tickets. That is Super-agent's job.
- **No enforcement.** It resolves scope and policy; `dsh-tool-policy` enforces,
  `dsh-cost-eval` meters. Keeping the resolver inert is what makes it safe to
  load in every profile.
- **No global state.** Everything is derived from the payload passed in.

## Install

```bash
dsh plugin --profile web add dsh-ticket-context
dsh --profile web --dump-config | grep -A8 'id: dsh-ticket'
```

MIT.
