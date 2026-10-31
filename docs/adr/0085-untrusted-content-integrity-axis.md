# ADR 0085 — The integrity axis: taint as a value, enforced at the prompt boundary

- Status: **Accepted — implemented** (2026-08-14)
- Date: 2026-08-14
- Resolves: [#295](https://github.com/chhetrisushil/loom/issues/295), split out of
  [#294](https://github.com/chhetrisushil/loom/issues/294)
- Corrects: [ADR 0072](0072-mcp-apps-ui-extension-placement.md) D6/S3, whose disposition named a
  mechanism that did not exist
- Builds on: the K10 classification taxonomy and the K10.3 `secretRef` value wrapper
  ([ADR 0022](0022-k10-log-lifecycle-retention-redaction-encryption.md)),
  MCP dynamic dispatch ([ADR 0063](0063-mcp-dynamic-dispatch.md)),
  the second-consumer rule ([ADR 0083](0083-second-consumer-rule.md))
- **KERNEL_ABI unchanged (1.1.0); EVENT_SCHEMA unchanged.** No syscall, no event type, no fold
  change. A value wrapper, a check at one seam, and one opt-in producer.

## Context

ADR 0072 D6 disposed of `ui/update-model-context` — untrusted view content overwriting an
agent's context — by saying the content "must be **tainted by classification**
(`@loom/classify`) and never merged into a system prompt."

That mechanism does not exist. `@loom/classify` carries two axes and neither is it:

- `DataClass` = `secret` / `sensitive` / `internal` — a **confidentiality** axis, governing what
  may *leave*, enforced by `maskPaths` / redaction / crypto.
- `externalized()` — an orthogonal *where-stored* axis (ADR 0046).

There is no **integrity** axis governing what may *enter* an instruction position. A repo-wide
search for taint machinery returned prose and comments only. So the disposition was
unimplementable as written, and the hazard it named was live.

The hazard is also not MCP-Apps-shaped, which is why this is its own ADR. A third-party MCP tool
result, an A2A peer's response, and a fetched document are the same problem: content the operator
did not author, arriving as an ordinary string, one interpolation away from a system prompt. The
second-consumer gate (ADR 0083) is met three times over before the first line of code.

## Decisions

### D1 — Taint is a property of a VALUE, not of a field

**Rejected: a fourth marker on the schema** (`untrusted(z.string())` beside `secret`/`sensitive`).
It is the obvious move — it matches the existing authoring ergonomics and the issue proposed it —
and it is wrong on the semantics.

Confidentiality is a property of a **field**: `ssn` is sensitive in every execution, forever, so
declaring it once at the schema is exactly right and a walker can collect it statically. Integrity
is a property of a **value**: the same `summary: string` is trustworthy when this flow computed it
and untrusted when a third-party server returned it, and which one it is cannot be known until
runtime. A schema marker would have to guess, and a marker that guesses is worse than none —
it reads as coverage while being wrong half the time.

**Accepted: a JSON value wrapper**, `tainted(value, origin)` →
`{ __loomTainted: { origin }, value }`, applied by the code that acquires the content. The shape
is deliberately the same structural trick K10.3's `secretRef` uses, for the same reason: it
survives the log verbatim, so a replay hands the effect back a value that is *still* tainted.

`unwrapTainted()` exists and is deliberately loud. Nothing can stop an application from unwrapping
and splicing the result into a system prompt. The guarantee is not "you cannot"; it is that the
call site is *visible* — one named function, greppable, at every point where provenance stops
travelling.

### D2 — The check lives at the prompt boundary, because that is the only place it can

The K6 safety ring (`@loom/middleware`) looks like the natural home and cannot be: a
`SafetyValidator` inspects the **effect input**, which for an `LlmEffect` is `TIn` — the
application's own type, *before* `buildRequest` assembles a prompt from it. The validator never
sees the assembled request. It is also verdict-only (`{ ok, reason }`) and this check must
*transform*.

So the check is `guardRequest`, in `@loom/llm`, running inside `createLlmEffect` between
`buildRequest` and `provider.complete`.

### D3 — The rule is positional, and narrow enough to be absolute

> **Tainted content may appear only in a `user` message, and only fenced.**

Every other position refuses with `UntrustedContentError`:

| Position | Why it refuses |
|---|---|
| `request.system` | The operator's voice. |
| a `role: "system"` message | Providers hoist these into the system instruction — guarding only `request.system` would leave the equivalent door wide open. |
| `role: "assistant"` | Content the model is told IT produced. Forging the model's own turn is a *stronger* injection than a user turn, not a weaker one. |
| tool `name` / `description` | Read as instructions by every provider, and the vector most often forgotten. A tool list proxied from a third-party MCP server carries third-party descriptions. |

**Be precise about which half is a guarantee.** The *refusal* is structural: after the guard runs,
third-party bytes cannot be sitting in an instruction slot, whatever the model then does. The
*fence* is a label — it marks a boundary the model can be told about, and a model can still be
talked across it. One is a property of the request; the other is a mitigation. Selling the second
as the first is how a security feature becomes a liability.

What the fence must at least do is be a boundary its own contents cannot move: a forged
`</untrusted-input>` inside the content would make everything after it read as trusted, so both
the closing and opening forms are escaped, and the `origin` attribute is stripped of `<>"`
because the origin routinely contains a third-party-controlled fragment (a tool name).

The guard does **not** write the system-prompt sentence that tells the model what the fence means.
`UNTRUSTED_CONTENT_SYSTEM_NOTE` is exported for the application to paste. A framework that writes
into the system prompt is doing the exact thing this module exists to prevent.

### D4 — No flag on the check; the flag is on the producer

`guardRequest` runs unconditionally. A check that defaults to off protects exactly the
applications that never think about it, and this is the second time in a week that a
declared-but-unreachable capability has turned up in this repo (#294). It is free to leave on: a
request with no tainted content is returned structurally unchanged.

The opt-in is at ingress instead — `registerMcpInvoke(..., { taintResults: true })` — because
tainting *does* change the step's output shape, and consumers must then `unwrapTainted()` to
compute with it. That friction is the point.

### D5 — Retrofitting is bounded, and the bound is honest

Taint applies to content ingested **after** a producer starts applying it. An existing log replays
exactly as it did, with no taint, because the fact was never recorded — the same argument ADR 0063
D3 made about principals. There is no way to infer, from a logged string, which third party wrote
it. Enabling `taintResults` on an existing deployment protects new executions and leaves old ones
alone.

## Consequences

- **Three surfaces, one primitive.** `@loom/classify` gains `tainted`/`isTainted`/`taintOf`/
  `unwrapTainted` (4 functions, 2 types) — no new package, per ADR 0083. Its remit widens from
  "data protection" to "data handling", which the package description now says.
- **Providers are untouched.** `LlmRequestInput` (what `buildRequest` returns) may carry taint;
  `LlmRequest` (what a provider receives) never does, because the guard normalizes. `LlmRequest`
  is assignable to `LlmRequestInput`, so an application that taints nothing compiles and behaves
  identically.
- **The failure is a throw, not a typed channel.** Tainted content in a system prompt is a wiring
  defect, not a domain outcome to branch on — the `SafetyViolationError` / `EffectModeViolationError`
  precedent. It fails the step through the normal `STEP_FAILED` path.
- **ADR 0072's S3 is now implementable.** A serving loom that ingests `ui/update-model-context`
  taints it at ingress and gets the refusal for free.
- **What is still not covered, stated plainly.** Taint travels on values, not through string
  concatenation: `` `${unwrapTainted(doc)} — summarize` `` produces a plain string and the guard
  cannot see it. This is the same limit every taint system in a language without runtime string
  tainting has. The mitigation is that unwrapping is one greppable call.

## Follow-up (2026-08-14) — the second producer, and a shape the first could not use

`A2APeerClient` gains the same opt-in. A peer agent writes its own artifact text and is exactly as
trustworthy as whoever operates it, which is the case D1's second-consumer argument named.

It taints **`content` only**, not the whole output, where `mcpInvoke$` taints everything. That is
not an inconsistency: `mcpInvoke$` yields `unknown` and has no field to single out, while
`A2APeerOutput` already separates the flattened text from `raw` (task state and artifact metadata,
which feed control flow). Tainting the whole object would force `unwrapTainted()` on code that
never touches a prompt — friction in the wrong place — whereas tainting the text puts it exactly
on the prompt path: `peer.content` drops straight into an `LlmMessage` slot where the guard sees
it, with no ceremony at the call site.

**The flag's literal type selects the output type** (`A2APeerConfig<TTaint extends boolean>` →
`A2APeerOutputFor<TTaint>`), so a caller who does not opt in keeps `A2APeerOutput` and compiles
unchanged — meeting the standard this ADR set for `LlmRequest`. A `boolean` (flag known only at
runtime) distributes to the union, which is the honest answer. The runtime `outputSchema` accepts
both shapes, since one schema backs both settings.

Verified against a temporary tsconfig that does **not** exclude tests, because loom test files are
not tsc-checked and a type-level assertion in one is otherwise decoration.

## Amendment (2026-10-31) - taint NESTED in a tool result (#735)

D1 puts the wrapper on a value, and a producer may taint only PART of what it returns: A2A taints
`content` and leaves `raw` untainted because `raw` feeds control flow. The agent loop checked
`isTainted` at the TOP of a tool result only, so `{ raw, content: tainted(...) }` was flattened by
`JSON.stringify` into plain tool_result text: not fenced, and `sawTaintFrom` never set, so a
`writeBack` memory entry (and, before the fix, a compaction input) was stored untainted. That is a
durable memory-poisoning path.

**Rule.** One shared walk, `scanTaint` / `nestedTaintOrigin` in `@loom/classify`, finds a wrapper at ANY
depth (iterative, cycle-safe, bounded: depth 64, 100,000 nodes; binary views skipped). It FAILS CLOSED:
a value too deep or too large to scan is reported tainted with origin
`unknown:taint-scan-bound-exceeded`, because "could not look" is not "clean". `toolResultContent`
fences the WHOLE `tool_result` when any nested wrapper is present (the body is the same
`{ tool, result }` JSON, re-tainted as one string with the origin(s), `a, b` when several), and
`agentLoop$` records the origin in `sawTaintFrom`, so write-back is tainted and the compaction summary
is fenced. The claim-check middleware uses the same helper for its envelope's origin.

**Why the whole result and not only the subtrees.** The fence is positional (D3): the model reads one
string, and a fence around a fragment of a JSON document leaves the rest to be read as instructions the
moment a tainted string quotes a closing brace. Fencing the whole result is the minimal safe choice;
the clean `raw` stays legible INSIDE the fence and the inner wrappers still show which parts are
untrusted. Cost: a result with one tainted field is shown as untrusted in full.

**Scan what is SERIALIZED (review round).** The model sees `JSON.stringify` output, not the live value:
`toJSON`, a Date subclass, a getter that changes between reads, or a tool that stringified a wrapper into
a string all make a live-value walk disagree with the prompt (an unfenced injection with an untainted
write-back), and on replay the log holds the JSON form, so live and replay would diverge. So
`toolResultContent` stringifies FIRST; if the text has no `__loomTainted` marker it is returned
unchanged (clean results are byte-identical and are never walked); otherwise the parsed text is
scanned and the whole string is fenced. A marker that is only TEXT (a stringified wrapper, a forged
string) is fenced with origin `unknown:taint-marker-in-text`: over-fencing is the fail-closed
direction. The claim-check middleware does the same on its serialized `json`. The joined origin label
is capped (8 distinct origins, then `+N more`, each at most 200 characters) so forged wrappers cannot
inflate the journaled label. A result that carries a marker AND exceeds the scan bound is fenced with
`unknown:taint-scan-bound-exceeded` and the loop warns once per tool (`LOOM_AGENT_TAINT_SCAN_BOUND`).

**Taint propagates through every derived artifact.** `sawTaintFrom` is now derived from the
`tool_result` part the model is actually shown (tainted text, or a media part marked
`untrusted: { origin }`), and a RECALLED tainted memory entry marks the run too, so an answer built on
recalled untrusted text is written back tainted (it used to be lost after one hop). A compaction
summary is tainted when the folded slice holds a wrapper or an untrusted media part.

**Unchanged.** The stored value is never altered (a flow still reads A2A's untainted `raw`); a clean
result is byte-identical; a top-level wrapper keeps its origin and unwrapped body; tainted text still
cannot reach a system prompt (`guardRequest`, D2/D3).

## Evidence

`packages/llm/src/untrusted.test.ts` (13) covers each refusal position, the fence-breakout cases,
and non-interference. `packages/classify/src/taint.test.ts` (6) covers the wrapper, including the
JSON round-trip the log depends on.

The one that matters is `plugins/mcp/src/taintedIngress.test.ts`: a real flow against a fake MCP
server whose tool returns an injection payload, asserting that it cannot become a system prompt,
that it *does* reach a fenced user message, that the taint is **in the durable log** rather than
in memory — and, as a control, that with `taintResults` off the same injection reaches the system
prompt unimpeded. Without that last case, the other three could be passing for reasons unrelated
to the guard.
