# dsh-tool-memo

Tool-result memoization for DeepSeek Harness. Idempotent tool calls that
repeat with identical arguments are served from a TTL cache instead of
re-executing — fewer wasted executions, fewer burned tokens, faster loops.

**Plugin id:** `dsh-memo` · **npm:** `dsh-tool-memo`

## Install

```bash
dsh plugin --profile web add dsh-tool-memo
dsh --profile web --dump-config | grep -A3 'id: dsh-memo'   # verify
```

The plugin ships **disabled**.

## How a hit behaves

| mode | on a cache hit |
|------|----------------|
| `hint` (default) | the re-execution is **denied** with an explanatory reason carrying a bounded preview of the cached value and instructions to bypass with the fresh flag |
| `inject` | **EXPERIMENTAL** — the verdict additionally carries the full cached result (`result` field) for harnesses that honor it; on ones that don't, the call simply re-executes |

The fresh flag (default `_memoFresh: true` in the tool arguments) always
bypasses lookup. Mutating and outbound tools (`bash`, writes, `http*`,
`send*`, …) are **excluded by default** — a cached side effect is worse than
a repeated one.

## Cache semantics

- **Key** = `sha256(tool, stable-serialized args)` — content-addressed, safe
  across sessions of the same profile.
- **TTL** per tool via `perToolTtl` globs, `defaultTtlMs` otherwise; a TTL of
  `0` disables caching for that tool.
- **LRU** bounded by `maxEntries` (default 256); hits refresh recency.
- Error results are never cached.

## Config

```yaml
- id: dsh-memo
  name: dsh-tool-memo
  config:
    enabled: false
    mode: hint                  # hint | inject (inject = experimental)
    defaultTtlMs: 600000        # 10 min
    perToolTtl:                 # first matching glob wins
      - { tool: read_file, ttlMs: 300000 }
      - { tool: "search*", ttlMs: 120000 }
    maxEntries: 256
    excludeTools: []            # empty = built-in mutating/outbound list
    includeTools: []            # empty = all non-excluded tools
    freshFlag: _memoFresh
    audit: { enabled: true }    # default file: <cwd>/.dsh-tool-memo/audit.jsonl
    ticket:
      enabled: true
      masterId: ""              # router Session id; empty = workers only
      isolation: ticket         # ticket | session | none
```

> A profile-level patch targeting `id: dsh-memo` replaces the WHOLE config
> row (no deep merge) — restate every key you want to keep.

## Ticket isolation (dsh-superagent)

A cache shared across tickets is a data-leak path. Ticket A reads
`config/secrets.env`; ticket B asks for the same path; the cache answers
without touching the tool — and B has just read a file its ticket never
touched. `ticket.isolation` closes it by folding the ticket into the cache key.

| `isolation` | Bucket | Use when |
| --- | --- | --- |
| `ticket` (default) | one cache per ticket; router gets its own | tickets may touch different data |
| `session` | one cache per Session, router included | strictest; best hit rate sacrificed |
| `none` | one shared cache | single-tenant runs, or caching only immutable inputs |

The ticket comes from the `worker-<ticketId>` Session naming
`dsh-superagent` already uses, or from `dsh-ticket-context` when loaded.
Sessions outside Super-agent share the default bucket, so a plain run keeps the
pre-0.2 behaviour. Audit lines gain a `bucket` field.

Two honest notes:

- **Isolation costs hit rate.** Identical reads in two tickets both execute
  once. That is the point: the second execution is where the permission check
  lives.
- **`maxEntries` is one global ceiling, not one per ticket.** Bucketing
  separates keys, not memory, so a busy ticket can evict a quiet ticket's
  entries. A per-ticket ceiling would let N tickets multiply the process's
  memory by N.

## Audit format (JSONL)

```json
{"ts":"2026-09-19T12:00:00.000Z","memo_version":"0.1.0","event":"hit","tool":"read_file","key":"9296…","age_ms":4210}
```

Events: `store` · `hit` · `miss` · `skip` (not cacheable / fresh flag / error) · `evict`.

## Development

```bash
pnpm install && pnpm --filter dsh-tool-memo test
```

MIT licensed. Part of the [dsh-plugins](https://github.com/Alfred-Lau/dsh-plugins) monorepo.
