# Data classification (`@loom/classify`)

> **K10-R1.** Classify a field's sensitivity **once, at its schema**, and let every
> mechanism — encryption, redaction, egress-scrubbing — derive its wiring from that mark.
> The alternative (hand-authoring dot-paths like `{ STEP_COMPLETED: ["output.ssn"] }` at
> each store/middleware seam) drifts from the schema and repeats a fact the schema already
> knows.

## The three classes

Each class is named for the **mechanism** that acts on it, so a marker tells you what will
happen — not just "this is secret-ish":

| Class | Persistence | Mechanism |
|---|---|---|
| `secret` | **never persisted** | substituted / redacted before the value reaches the log (K10-R2 `secretRef`, K10.3 redaction) |
| `sensitive` | encrypted-at-rest, crypto-shreddable | field-level encryption ([`@loom/plugin-crypto`](adr/0022-k10-log-lifecycle-retention-redaction-encryption.md)) + scrubbed from egress |
| `internal` | persisted in the clear | scrubbed from **external** egress only (telemetry / agent-surface / CLI, K10-R6); never crosses the trust boundary |

An unmarked field is unclassified and handled by nothing — omitting the marker is a true
no-op (G2).

## Authoring

The markers return the **same Zod schema** (validation untouched), so they drop into a
`z.object({ … })` shape transparently:

```ts
import { z } from "zod";
import { sensitive, secret, internal } from "@loom/classify";

const payoutOutput = z.object({
  ssn: sensitive(z.string()),      // encrypt-at-rest + shred on erasure
  apiToken: secret(z.string()),    // never written to the log
  note: internal(z.string()),      // logged, but never egressed externally
  ok: z.boolean(),
});
```

A marker survives being wrapped afterwards — `sensitive(z.string()).optional()` and
`sensitive(z.string().default("…"))` are both still classified. A classified **object** is
treated as a unit (its whole subtree is encrypted together; inner marks are not also
emitted — the coarser mark wins).

### Marks inside arrays

Marking a field inside a list of records works, at any depth
([ADR 0076](adr/0076-wildcard-classification-paths.md)):

```ts
const output = z.object({
  people: z.array(z.object({ ssn: sensitive(z.string()), id: z.string() })),
});
```

The derived path is `people[].ssn`, where `[]` is an **array crossing**: every element is
masked, encrypted and externalized independently, and unmarked siblings (`id`) are untouched.
The crossing composes — `teams[].members[].ssn` and `grid[][].v` both work — and resolves
against the actual value, so a path that does not resolve (absent field, or a non-array) is
simply skipped.

Marking the array *itself* is still supported and means something different: the whole array
is covered as one unit, so masking yields `"[redacted]"` in place of the list.

Writing a *fourth* sink? `@loom/classify` exports `expandPaths(root, paths)` and
`hasWildcard(paths)` — resolve `[]` against the value with those rather than teaching another
walker about arrays, so array semantics stay in one place.

## Deriving the wiring

The kernel stays ignorant of the taxonomy (G3 — the vocabulary lives here, the mechanism
lives in the crypto plugin / middleware). Each mechanism reads the marks it cares about:

```ts
import { sensitivePathsFromSteps } from "@loom/plugin-crypto";
import { EncryptingEventStore } from "@loom/plugin-crypto";

// Fields marked `sensitive(...)` in a step's outputSchema become STEP_COMPLETED
// dot-paths `output.<path>` — the encryption map is derived, not hand-authored.
const store = new EncryptingEventStore(inner, keys, {
  sensitive: sensitivePathsFromSteps(flow.steps),
});
```

`sensitivePathsFromSteps` selects only the `sensitive` class (encryption is at-rest);
`secret` (never-persist) and `internal` (egress-only) are different mechanisms and are
correctly excluded. Paths are unioned and de-duplicated across steps; the store applies
each only to events that carry it, so unioning across differently-shaped steps is safe.

### Secrets, wired in one line (K10-R2)

`defineConfig({ security: { secrets } })` installs the redaction seam automatically, so `secret()`-marked
fields never reach the log — both directions, no kernel change:

```ts
const app = defineConfig({
  storage: sqliteStorage({ path: "app.db" }),
  flows: [chargeFlow],
  security: { secrets: { resolver: myVaultResolver } }, // resolve(id) → value; store(id, value)
});
```

- **Input** — a `secretRef("stripe-key")` in a step's input is resolved to the real value
  for the tool, while `STEP_STARTED` logs only the reference.
- **Output** — a step output field marked `secret()` is replaced by a deterministic
  reference before `STEP_COMPLETED` — the paths are derived from the registered flows'
  step schemas (`secretOutputPathsByStep` → `redactOutputFrom`), not hand-authored.

The kernel hot-path substitution (automatic, before `STEP_STARTED`) is deliberately deferred
— the effect-path seam already upholds the "secrets never enter the log" invariant.

### Egress scrubbing (K10-R6)

Telemetry is a **separate egress**: a step's `input`/`output` are shipped to Datadog / an
OTel collector / a dashboard — outside the trust boundary. `defineConfig({ observability: { telemetry } })`
automatically wraps your adapters so `sensitive()` and `internal()` fields are masked
(`[redacted]`) before any adapter sees them — derived from the registered steps, no extra
wiring:

```ts
const app = defineConfig({
  storage: sqliteStorage({ path: "app.db" }),
  flows: [lookupFlow],
  observability: { telemetry: [datadogAdapter] }, // sees { ssn: "[redacted]" }, never the plaintext
});
```

The **log** still holds the real value (that is encryption/erasure's concern, K10.2); egress
scrubbing governs only what leaves the boundary. `secret` fields need no scrubbing — K10-R2
keeps them off the log and telemetry entirely.

### The other egress surfaces: agent-surface + CLI

Telemetry sits at the effect boundary, so it derives its scrub paths from step schemas
(`scrubPathsByStep`). The other two egress surfaces are **not** schema-bound, so they take
explicit paths — but all three share one masking primitive (`maskPaths` from `@loom/classify`,
masking to `[redacted]`):

- **agent-surface** — surface state is *app-authored* (agents emit free-form patches, not step
  outputs), so classification marks can't reach it. Declare the sensitive surface dot-paths
  when registering the surface; they're masked in the folded state before any reader
  (`getSurface`/`getState`/a client renderer) sees them:

  ```ts
  defineConfig({ surfaces: [{ id: "ui", redact: ["user.ssn"] }] });
  ```

- **CLI** — `loom logs` / `loom debug` read a cold log with no flow schemas, so the operator
  names the sensitive output paths explicitly:

  ```
  loom debug --db app.db <execId> --redact ssn,user.token
  ```

## Middleware ordering (K10-R3.2)

Redaction is a **data-shaping** middleware: it must run *outermost* of any middleware that
inspects or transforms effect I/O, so a secret is resolved for the tool (input) and redacted
from the result (output) before anything else sees the value. `defineConfig({ security: { secrets } })`
wires it outermost for you (it is `unshift`-ed ahead of `effectMiddleware`), so you only need
to think about order when composing `redactionMiddleware` **by hand** — put it first:

```ts
new EffectRuntime([
  redactionMiddleware({ resolver }), // outermost — resolves/redacts before the rest
  meteringMiddleware(...),
  retryMiddleware(...),
]);
```

This is a documented convention, not a hard boot-validator (K10-R3.2 was softened — a
middleware-order validator is ceremony over opaque closures). Getting it wrong degrades
redaction, not correctness of the fold.

## The integrity axis — untrusted content (ADR 0085)

Everything above is a **confidentiality** axis: it governs what may *leave*. There is an
opposite direction — what may *enter* an instruction position — and it does not work the same
way, so it does not use a marker.

Confidentiality is a property of a **field**: `ssn` is sensitive in every execution, forever, so
declaring it once at the schema is exactly right. Integrity is a property of a **value**: the same
`summary: string` is trustworthy when your flow computed it and untrusted when a third-party MCP
server returned it, and which one it is cannot be known until runtime. So taint is attached to the
value, at ingress, by the code that acquired it:

```ts
import { tainted, unwrapTainted } from "@loom/classify";

const doc = tainted(await fetchThirdPartyDoc(), "mcp:acme/fetch_doc");
```

The wrapper is plain JSON (`{ __loomTainted: { origin }, value }` — the same structural trick as
K10.3's `secretRef`), so it survives the log verbatim and a **replay hands back a value that is
still tainted**.

### What it buys you

`@loom/llm`'s `guardRequest` runs inside every `createLlmEffect`, unconditionally, between
`buildRequest` and the provider:

> **Tainted content may appear only in a `user` message, and only fenced.**

`request.system`, a `role: "system"` message, a `role: "assistant"` turn, and any tool
`name`/`description` all throw `UntrustedContentError`. In a `user` message the content is wrapped
as `<untrusted-input origin="…">…</untrusted-input>`, with any forged closing tag escaped so the
content cannot move its own boundary.

Two halves, and they are not equally strong. The **refusal is structural** — after the guard runs,
third-party bytes are not in an instruction slot. The **fence is a label** — a model can still be
talked across it. Put [`UNTRUSTED_CONTENT_SYSTEM_NOTE`](adr/0085-untrusted-content-integrity-axis.md)
in your system prompt so the model knows what the tag means; the guard will not write it for you,
because a framework that writes into your system prompt is doing the very thing this prevents.

### Producing taint

`registerMcpInvoke(client, runtime, { taintResults: true })` taints every MCP tool result with
`mcp:<server>/<toolName>`. It is opt-in because it changes the step's output *shape* — consumers
call `unwrapTainted()` to compute with it, and that friction is deliberate: every unwrap is a
visible place where provenance stops travelling.

### Limits, stated plainly

- Taint travels on **values**, not through string concatenation. `` `${unwrapTainted(doc)} …` ``
  produces a plain string the guard cannot see. Unwrapping is one greppable call, which is the
  whole mitigation.
- It applies to content ingested **after** you turn a producer on. Existing logs replay untainted,
  because the fact was never recorded — you cannot infer from a logged string which third party
  wrote it.

## Triage (why a package, not the kernel)

`@loom/classify` is a small **authoring-tier** package above the kernel. The taxonomy is
policy *vocabulary*; the kernel supplies no data-protection semantics (G3). It is 1P shared
authoring (not a vendor adapter, so not a `plugin-*`), consumed by the crypto plugin, the
redaction middleware, and — when they land — egress scrubbing (K10-R6) and the subject
index (T3). See the [K10/T3 evaluation](requirements/2026-07-13-k10-t3-critical-evaluation.md).

## Not in scope (yet)

- **Manifest-level sensitivity (K10-R1.3)** — deferred. Runtime enforcement is load-bearing;
  a static manifest surface is a nicety over real compiler work.
- **Record / union / tuple / intersection members** — the dot-path sinks walk objects and
  arrays only. A mark inside a `z.record` value, a `z.union` branch, a `z.tuple` member or
  either side of a `z.intersection` collects no path and does nothing. Mark the container
  itself, or restructure it as an object or array. The
  [`classification-reachability`](adr/0028-runtime-verification.md) check fails the build on this rather than
  letting it fail silently.
