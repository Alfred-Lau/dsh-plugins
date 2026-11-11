# dsh-rate-shield

Rate & budget governance for DeepSeek Harness: 429 backoff windows, daily
token budgets and tool-call storm control — with a monitor-first default so
you can see the numbers before anything starts being denied.

**Plugin id:** `dsh-rate` · **npm:** `dsh-rate-shield`

## Install

```bash
dsh plugin --profile web add dsh-rate-shield
dsh --profile web --dump-config | grep -A3 'id: dsh-rate'   # verify
```

The plugin ships **disabled**.

## Modes

| mode | behavior |
|------|----------|
| `monitor` (default) | meter LLM usage, observe 429s, warn on budget thresholds — never deny |
| `enforce` | additionally **deny tool calls** while any shield condition is open |

## Shields

1. **429 backoff** — every observed 429 opens an exponentially growing quiet
   window (`baseMs`, `factor`, `maxMs`; default 30 s → 10 min cap). Any
   successful LLM completion resets the streak. In enforce mode, tool calls
   inside the window are denied with the remaining time in the reason.
2. **Daily token budget** — rolling per-UTC-day total of input+output tokens.
   Warns at `warnAt` (default 80%); at 100%, `criticalAction: block-tools`
   (enforce mode) denies tool calls until the day resets. The budget resets
   automatically at the UTC day boundary.
3. **Tool storm** — a rolling window (`windowMs` / `maxCalls`, e.g. 120
   calls/min); over-limit calls are denied in enforce mode.

## Honest limitations

The current dsh event surface has no short-circuit channel for **LLM
requests themselves** — the tool pipeline (`tools/pre-execute`) is the only
approval-chain seam. This shield therefore protects the *tool loop around
the model*: when the provider is rate-limited or the budget is gone, agent
tool activity pauses instead of piling onto requests that are about to fail.
Pair with `@goodandready/dsh-key-rotation` for multi-key setups.

## Config

```yaml
- id: dsh-rate
  name: dsh-rate-shield
  config:
    enabled: false
    mode: monitor               # monitor | enforce
    backoff: { enabled: true, baseMs: 30000, factor: 2, maxMs: 600000 }
    budget: { dailyTokens: 0, warnAt: 0.8, criticalAction: log }   # 0 = off
    toolStorm: { windowMs: 60000, maxCalls: 0 }                    # 0 = off
    audit: { enabled: true }    # default file: <cwd>/.dsh-rate-shield/audit.jsonl
    ticket:
      enabled: true
      masterId: ""              # router Session id; empty = workers only
      rules:
        - { match: "fix-*",   dailyTokens: 200000, maxCalls: 40 }
        - { match: "review-*", dailyTokens: 100000, maxCalls: 20, mode: enforce }
```

> A profile-level patch targeting `id: dsh-rate` replaces the WHOLE config
> row (no deep merge) — restate every key you want to keep.

## Per-ticket budgets (dsh-superagent)

A single daily budget answers the wrong question once tickets run in parallel:
one runaway ticket spends the whole allowance and every other ticket stalls
with it. With `ticket.rules`, every counter — tokens and tool calls — is also
bucketed per ticket, so a ticket can only exhaust **its own** allowance.

| Rule key | Effect |
| --- | --- |
| `dailyTokens` | This ticket's per-UTC-day token allowance |
| `maxCalls` | This ticket's tool-call limit per `toolStorm.windowMs` |
| `mode` | `monitor` / `enforce` for this ticket only |

The ticket comes from the `worker-<ticketId>` Session naming
`dsh-superagent` already uses, or from `dsh-ticket-context` when loaded. Rules
match on the ticket id (`*`, `?`, `**` globs, first match wins); the router
matches the literal `router`.

Two deliberate asymmetries:

- **429 backoff stays global.** The limit that produced it is the model's, not
  a ticket's — letting one ticket ignore it would just keep the 429s coming.
- **The tighter of the two budgets governs.** A ticket with a generous
  allowance still stops when the global budget is spent, and vice versa. The
  deny reason names whichever ran out.

Audit lines gain `ticket_id` / `ticket_role`, and usage lines add
`ticket_tokens_today`, so `jq 'select(.ticket_id=="t-42")'` gives one ticket's
spend.

## Audit format (JSONL)

```json
{"ts":"2026-09-19T12:00:00.000Z","rate_version":"0.1.0","event":"backoff_deny","tool":"bash","backoff_remaining_ms":28123,"ticket_id":"t-42","ticket_role":"worker"}
```

Events: `llm_usage` · `llm_429` · `llm_ok` · `budget_warn` · `budget_deny` · `backoff_deny` · `storm_hit` · `storm_deny`.

## Development

```bash
pnpm install && pnpm --filter dsh-rate-shield test
```

MIT licensed. Part of the [dsh-plugins](https://github.com/Alfred-Lau/dsh-plugins) monorepo.
