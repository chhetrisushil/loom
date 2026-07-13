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
| `internal` | persisted in the clear | scrubbed from **external** egress only (telemetry / a2ui / CLI, K10-R6); never crosses the trust boundary |

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

`defineConfig({ secrets })` installs the redaction seam automatically, so `secret()`-marked
fields never reach the log — both directions, no kernel change:

```ts
const app = defineConfig({
  storage: sqliteStorage({ path: "app.db" }),
  flows: [chargeFlow],
  secrets: { resolver: myVaultResolver }, // resolve(id) → value; store(id, value) for output
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
OTel collector / a dashboard — outside the trust boundary. `defineConfig({ telemetry })`
automatically wraps your adapters so `sensitive()` and `internal()` fields are masked
(`[redacted]`) before any adapter sees them — derived from the registered steps, no extra
wiring:

```ts
const app = defineConfig({
  storage: sqliteStorage({ path: "app.db" }),
  flows: [lookupFlow],
  telemetry: [datadogAdapter], // sees { ssn: "[redacted]", ok: true }, never the plaintext
});
```

The **log** still holds the real value (that is encryption/erasure's concern, K10.2); egress
scrubbing governs only what leaves the boundary. `secret` fields need no scrubbing — K10-R2
keeps them off the log and telemetry entirely. Compose `scrubbingAdapter`/`scrubPathsByStep`
directly for other egress surfaces (a2ui, CLI).

## Triage (why a package, not the kernel)

`@loom/classify` is a small **authoring-tier** package above the kernel. The taxonomy is
policy *vocabulary*; the kernel supplies no data-protection semantics (G3). It is 1P shared
authoring (not a vendor adapter, so not a `plugin-*`), consumed by the crypto plugin, the
redaction middleware, and — when they land — egress scrubbing (K10-R6) and the subject
index (T3). See the [K10/T3 evaluation](requirements/2026-07-13-k10-t3-critical-evaluation.md).

## Not in scope (yet)

- **Manifest-level sensitivity (K10-R1.3)** — deferred. Runtime enforcement is load-bearing;
  a static manifest surface is a nicety over real compiler work.
- **Array-element paths** — the dot-path sinks address scalar paths; mark the scalar field
  inside an array element's object instead of the array.
