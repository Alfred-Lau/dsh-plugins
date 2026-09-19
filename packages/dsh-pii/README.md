# dsh-pii-gate

PII detection & exfiltration guard for DeepSeek Harness. Scans tool arguments
(and optionally tool results) for personally identifiable information —
emails, phone numbers, CN resident IDs, credit cards, API keys and more —
audits every hit, and (in block mode) denies tool calls that would send PII
out of the machine.

**Plugin id:** `dsh-pii` · **npm:** `dsh-pii-gate`

## Install

```bash
dsh plugin --profile web add dsh-pii-gate
dsh --profile web --dump-config | grep -A3 'id: dsh-pii'   # verify
```

The plugin ships **disabled**. Set `enabled: true` in your profile patch to
opt in.

## Modes

| mode | behavior |
|------|----------|
| `audit` (default) | detect + audit + let the pipeline continue — pure observability |
| `block` | additionally **deny** calls on outbound tools (`outboundTools` globs) carrying ≥ `minMatches` PII hits |

A denial reason tells the model exactly which PII types were found and how
to proceed (scrub the input, or exempt the tool).

## Detectors

| id | default | notes |
|----|---------|-------|
| `email` | on | |
| `phone_cn` | on | mainland mobile numbers |
| `phone_intl` | on | E.164-ish `+…` forms |
| `cn_id` | on | 18-digit ID with **mod-11 checksum validation** — order numbers and timestamps don't trigger it |
| `credit_card` | on | 13–19 digits with **Luhn validation** |
| `api_key` | on | `sk-`, `ghp_`, `AKIA…`, `xox…`, `Bearer …` shapes |
| `ssn` | on | US social security numbers |
| `ipv4` | off | opt-in; version strings like `1.2.3.4` are legitimate false-positive risks |
| `iban` | off | opt-in |
| custom | — | `customPatterns: [{ name, pattern }]`, compiled as regex |

## Privacy invariants

- Audit entries carry PII **type counts** and an 8-hex evidence hash — the raw
  matched text never lands in logs, audit files or memory.
- The detector runs in-process; nothing is ever transmitted.

## Honest limitations

`tools/pre-execute` is an approval-chain waterfall: it can short-circuit a
call but **cannot rewrite its arguments in place**. In-place redaction of
arguments is therefore out of scope for v1 — the gate blocks or observes,
it does not silently edit tool input. If you need the arguments themselves
scrubbed before they reach a backend, pair this plugin with your own tool
wrapper or wait for a dsh mutation seam.

## Config

```yaml
- id: dsh-pii
  name: dsh-pii-gate
  config:
    enabled: false
    mode: audit                 # audit | block
    outboundTools: [bash, shell, "http*", "fetch*", "web*", "send*", "mail*", "email*", "upload*", "request*"]
    exemptTools: []
    detectors: { email: true, phone_cn: true, phone_intl: true, cn_id: true, credit_card: true, api_key: true, ssn: true, ipv4: false, iban: false }
    customPatterns: []          # - {name: mrn, pattern: 'MRN-\\d{8}'}
    minMatches: 1
    scanResults: true
    audit: { enabled: true }    # default file: <cwd>/.dsh-pii-gate/audit.jsonl
```

> A profile-level patch targeting `id: dsh-pii` replaces the WHOLE config row
> (no deep merge) — restate every key you want to keep.

## Audit format (JSONL)

```json
{"ts":"2026-09-19T12:00:00.000Z","pii_version":"0.1.0","phase":"decision","tool":"http_request","args_hash":"9f2b…","verdict":"deny","matches":{"email":1,"phone_cn":1},"total":2,"reason":"PII on outbound tool (email, phone_cn)"}
```

## Development

```bash
pnpm install && pnpm --filter dsh-pii-gate test   # build + node:test
```

MIT licensed. Part of the [dsh-plugins](https://github.com/Alfred-Lau/dsh-plugins) monorepo.
