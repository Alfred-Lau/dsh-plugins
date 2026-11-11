# What a real harness told us

`examples/superagent-governance` replays recorded session events through the real
plugins. That proves the plugins' own logic, but it cannot prove the *contract*:
the replay feeds events in a shape we wrote down, so if we wrote the shape down
wrong, the replay happily agrees with us.

So we mounted all seven plugins on an actual dsh and ran an actual agent. Five
plugins were reading fields that do not exist. Every unit test was green.

This file records what the harness actually does, so the next person can check
the code against reality instead of against our guesses.

## The ten hooks, as observed

Dumped verbatim by a throwaway plugin that logged every hook's arguments to
jsonl. The surprises are marked.

| Hook | Real signature | Notes |
| --- | --- | --- |
| `tools/pre-execute` | `(exec, next)` → `{kind: 'allow' \| 'deny' \| 'ask' \| 'cancel'}` | as documented |
| `tools/post-execute` | `(exec, result, next)` → `{kind: 'accept' \| 'block'}` | as documented |
| `tools/execute` | `(exec, next)` | as documented |
| `session/event` | `(session, event)` | **two arguments, and not a waterfall** — the return value is discarded (`hasNext === false`) |
| `session/flush` | `()` | **log durability, not end-of-session** |
| `session/disposed` | `()` | this is the actual end-of-life signal |
| `llm/*` | `(payload, next)` | as documented |

## Where the session id lives

Not on the tool execution. On the agent that owns it:

```ts
interface ToolExecution {
  readonly agent: Agent        // ← sessionId is agent.id
  // no sessionId
}
interface Agent {
  readonly id: SessionId
}
```

Four plugins read `exec.sessionId` and got `undefined` on every call. A rule
scoped to one session silently matched nothing — no error, no log line, just a
policy that never fired.

## `session/flush` is not what it sounds like

It reads like "the session is ending, close your spans". It is not. In one probe
run of ten tool calls it fired **72 times**, including *between* a `tool/call`
and its matching `tool/result`.

`dsh-trace` was calling `flushAndClose` on it, so every in-flight tool span was
severed: the start produced a span named `execute_tool bash`, the end produced a
second, nameless span `execute_tool `, and the two never joined. Twelve spans
where there should have been nine.

The fix is one word: `session/flush` → `flushAll`, and `session/disposed` →
`flushAndClose`.

## Event payloads

```
tool/call        {turn, step, callId, name, arguments}
                 ← arguments is a JSON *string*, not an object

tool/result      {turn, step, message: {source: {kind: 'tool', callId},
                  content: [{type: 'tool-result', toolCallId,
                             content: [{type: 'text', text}], isError}]}}
                 ← no name anywhere. Only the callId connects it to the call.

assistant/message {turn, step, message: {role, content, source: {provider, model}, id},
                   usage: {inputTokens, outputTokens, totalTokens, cacheReadTokens}}
                 ← provider and model are on message.source, not message

request/context  {provider, model, contextWindow, systemPromptUpdate}
turn/start|end   {turn} / {turn, reason}
step/start|end   {turn, step}
```

`tool/result` carrying no name is the subtle one: a collector that merges
`{...pending, ...tool}` blanks out the name the start event already supplied. The
span still exists, it just loses its identity — `execute_tool ` instead of
`execute_tool bash`. Merge defensively:

```ts
pending.tool = { ...pending.tool, ...tool, name: tool.name || pending.tool?.name || '' }
```

## Profiles and presets

A profile is an ordered stack of bundle patch layers:

```json
{ "dsh": { "profile": { "bundles": ["dsh-base", "dsh-web-app", "my-bundle"] } } }
```

A bundle package declares `dsh.bundle.patch` pointing at its own
`cordis.patch.yml`, and **must list that file in `files`** — otherwise `pnpm`
skips it when copying a `file:` dependency and the bundle silently contributes
nothing.

Profile-level patches address rows by the `id` the bundle inserted, not by
package name. A mismatch does not warn loudly; the patch is dropped and the
plugin stays at its shipped default (usually `enabled: false`). This cost us an
entire debugging session: the profile said `id: dsh-tracing`, the row was
`dsh-trace`, and every span we were looking for was never generated.

## Mount at the top level, not inside a preset

`dsh-superagent` defines presets — a worker preset for the agent that executes a
ticket, a router preset for the agent that decides what to execute. Governance
plugins must see **both**, so they are inserted at the bundle top level:

```yaml
insert:
  - id: governance-trace
    name: dsh-tracing
  # ...
```

A row inside the worker preset would cover the worker and silently miss the
router. The plugin would look like it works, on half the traffic.

## `dsh-cost-eval` is not a plugin

It has no `apply`. Mounting it aborts boot:

```
dsh-cost-eval: invalid plugin, expect function or object with an "apply" method
```

It is a CLI that scores finished `dsh-eval` runs offline. It belongs in
`devDependencies`, not in a profile.

## How to check for yourself

The probe plugin is the cheapest way to re-derive all of the above on your own
dsh version:

```js
// probe-plugin/index.js — dump every hook's real arguments
export function apply(ctx) {
  for (const hook of ['tools/pre-execute', 'tools/post-execute', 'tools/execute',
                      'session/event', 'session/flush', 'session/disposed']) {
    ctx.on(hook, (...args) => {
      appendFileSync('probe.jsonl', JSON.stringify({
        hook, argc: args.length,
        types: args.map(a => typeof a),
        sample: describe(args),
      }) + '\n')
      return undefined
    })
  }
}
```

Run one session with a tool call, read `probe.jsonl`, and compare against the
table above. If dsh has changed, the file will say so — which is the whole point.
Guessing is what produced five silent bugs.
