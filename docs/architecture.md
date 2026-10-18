# Architecture

This document describes how `pi-context-gc` works internally. The public
surface (README) covers install, tiers, and configuration.

## Entry point

The default export is a function `piContextGc(pi: ExtensionAPI)`. It registers
four hooks:

```ts
pi.on("session_start",   onSessionStart);
pi.on("agent_start",      onAgentStart);
pi.on("agent_settled",    onAgentSettled);
pi.on("context",          onContext);
```

Only `onContext` performs work. The other three just track the *first call of a
run* so the pipeline runs exactly once per run (see `stats.freshTurn`).

## The pipeline (`onContext`)

1. Guard: if this is not the first `context` call since `agent_start`, do
   nothing (mid-run calls are left alone — the model's ongoing turn must not be
   silently trimmed).
2. Read Pi's usage percentage. Clamp it to `[0, 100]`.
3. Map `percent → tier` via `tierForPercent` (clamped to `[0, 3]`).
4. If tier is `0`, skip (there is room; nothing to trim).
5. Call `cleanMessages(messages, tier)` on a working copy and collect results.
6. If nothing was removed *and* nothing was compacted, leave the turn untouched
   (return undefined) so Pi keeps its own copy unchanged.
7. Otherwise write the cleaned messages back to Pi.

`cleanMessages` returns `{ messages, removed, estimatedTokensSaved, diag,
quarantined }`.

## `cleanMessages`

- Works on a shallow-cloned array (`working = messages`).
- Computes `mutatedFiles` (paths edited/written this run).
- For tier ≥ 2, records the last read index per path.
- Compacts heavy `edit.newText` / `write.content` arguments (tier ≥ 1) —
  truncation, **not** removal.
- Iterates once over toolResults, applying (in order):
  1. **Collapse** (tier ≥ 2) — giant bodies → head + tail placeholder.
  2. **Read invalidation** (tier ≥ 2) — keep only the latest read of a mutated
     path; drop earlier superseded reads.
  3. **Exact dedup** (tier ≥ 1) — drop earlier identical results.
  4. **Bash dedup** (tier ≥ 3) — drop earlier identical short bash outputs.
  - Each removal is quarantined.
- Narrative messages and anything in the last `PROTECTED_RECENT` positions are
  pushed through untouched.

## `collapseToolResult` (pure string surgery)

Given a tool result whose text exceeds `TOOL_RESULT_MAX_CHARS`:

- Keep the first `HEAD` (5) and last `TAIL` (50) lines.
- Replace the middle with a single line containing `Tool Output Collapsed`.
- Only collapses if there are more than `HEAD + TAIL` lines (so a body that is
  long in *bytes* but short in *lines* is left alone).
- Returns the new content plus `{ collapsed, removedChars, removedLines }`.

The removed byte count flows back into `diag.compactedChars` so the stats
reflect the real savings. No LLM call is involved.

## `redactSecrets` (pure)

Runs a list of secret regexes against text and replaces matches. Order matters:
a JWT regex runs first so the generic key/secret/token pattern does not leave a
signature tail behind. Hex/base64 blobs use look-around guards so a matched
token is not glued onto a surrounding word.

## Testing model

`CONTEXT_GC_NO_LOG=1` disables the info log so tests never touch the real
`~/.pi/agent/logs`. The exported functions are pure, so they are unit-tested
directly; `integration.test.ts` drives the real hooks through a fake `pi`
object.
