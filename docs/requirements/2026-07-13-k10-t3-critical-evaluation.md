# Critical evaluation — K10 data-protection expansion & T3 data-subject rights (GDPR/CCPA)

> **Status:** Evaluation (gatekeeper). Two proposals assessed against the *shipped* code before any
> implementation, per the project's strict-gatekeeper tradition ([execution-OS evaluation](2026-07-10-execution-operating-system-evaluation.md), [kernel-hardening evaluation](2026-07-10-kernel-hardening-evaluation.md)).
> **Method:** every premise verified against source (ADR 0022, `@loom/plugin-crypto`, `LogLifecycle`,
> `@loom/middleware` redaction, `replay-vm` pinned events, the store SPI). Nothing is legal advice.

## The headline that reframes both proposals

**K10 is already shipped.** [ADR 0022](../adr/0022-k10-log-lifecycle-retention-redaction-encryption.md)
declares "K10 complete": `redactionMiddleware` + `secretRef`/`SecretResolver` (R3), the
`EncryptingEventStore`/`EncryptingSnapshotStore` decorators + `KeyStore` SPI + `shredSubject` +
pinned `PAYLOAD_SHREDDED` fold (R4-core, snapshots covered), `LogLifecycle.applyRetention`/`compact`
(R5-core), and the store SPI `deleteExecution`/`truncatePrefix`/`copyPrefix` (R5b) — all with tests.
The K10 proposal is titled an "expansion," but ~60% of what it specifies **exists**. So it is not a
build; it is a **gap-closure + refinement** proposal, and it must be read that way.

Both specs are, architecturally, **well-reasoned and honest** — the subject-index-as-projection
(T3 R2), the six-surface completeness argument, the "compliance-*enabling* not compliant" disclaimer,
and the correct phasing (transparency-first, erasure-gated) are all sound and consistent with P2/P9/G3.
The critique below is therefore about *scope and sequencing*, not soundness.

## The four non-negotiables (inherited)

1. **G1 determinism** — no change may make replay diverge silently; loud/deterministic failure only.
2. **G2 zero-overhead when unwired** — benchmark-provable.
3. **G3 kernel/policy split** — the ring supplies mechanism; keys, fields, windows, lawful basis live above.
4. **DX bar** — one `defineConfig` key / one authoring marker; no cascading ceremony.

## Verdict summary

| Item | Shipped? | Verdict | Why |
|---|---|---|---|
| **K10-R5 gaps** — `defineConfig({retention})`, `EXECUTION_ARCHIVED`/`_DELETED` facts, branch-integrity guard, `loom retention` CLI | core done, surface missing | **ACCEPT — implement first** | Closes audit **MEM-F1** (retention never auto-driven), fixes a **latent correctness bug** (deleting a parent a live branch depends on), and an ADR-0022 doc-vs-code drift (it *claims* `defineConfig({retention})`). Additive, low kernel risk. |
| **K10-R1** — `sensitive()` authoring marker + 3-class taxonomy | **marker SHIPPED** (`@loom/classify`); manifest deferred | **ACCEPT (marker) / DEFER (manifest)** | Co-locating classification with the schema beats today's hand-authored store-wiring dot-paths. ✅ Shipped: `secret`/`sensitive`/`internal` markers + walker (`@loom/classify`), and `sensitivePathsFromSteps` derives the crypto map (see [data-classification.md](../data-classification.md)). **R1.3 manifest-level sensitivity** remains deferred — runtime enforcement is load-bearing; a static manifest surface is a nicety over real compiler work. |
| **K10-R2** — kernel secret-substitution before `STEP_STARTED` + `defineConfig({secrets})` | **low-risk half SHIPPED**; kernel substitution deferred | **ACCEPT direction / DEFER kernel build (gated on R1)** | ✅ Shipped without a kernel touch: `defineConfig({ secrets: { resolver } })` installs `redactionMiddleware` outermost, resolving input `secretRef`s for the tool while the log keeps the reference, and redacting `secret()`-marked OUTPUT fields (K10-R1) into references — derived from the registered steps (`secretOutputPathsByStep`/`redactOutputFrom`). The *one genuine kernel touch* — automatic substitution inside the hot path before `STEP_STARTED` — remains deferred (highest determinism stakes; the effect-path seam covers the MUST "secrets never enter the log" today). |
| **K10-R3.2** — boot-time middleware-ordering *error* | **SOFTENED → documented** | **SOFTEN → done** | ✅ Documented the convention (redaction outermost of data-shapers) in [data-classification.md](../data-classification.md), and `defineConfig({ secrets })` wires redaction outermost automatically. No hard boot-validator — it would be ceremony over opaque closures, and mis-ordering degrades redaction, not fold correctness. |
| **K10-R4 shredded read** — typed placeholder vs. loud throw | **SHIPPED (dual-mode)** | **DECIDE (dual-mode) → done** | ✅ `EncryptingEventStore` keeps `PayloadShreddedError` (fail-closed) as the **default** (G1 — the authoritative fold must fail loudly), and adds opt-in `onShredded: "tolerate"` yielding a `{ $shredded: true }` placeholder (`SHREDDED`/`isShredded`) so OFF-log consumers (deploy-sim, eval, subject export) process an erased log without crashing. Both, not either. Unblocks T3-R4.4 / Phase B. |
| **K10-R4.2** — branch key lineage for *distinct-subject* forks | shared-subject convention only | **DEFER** | The convention (fork shares subject → jointly shredded) covers the real cases; distinct-subject re-anchoring is speculative. Add `copyPrefix` key re-wrap only when a use case appears. |
| **K10-R6** — egress scrubbing (telemetry/a2ui/CLI) | **telemetry slice SHIPPED** | **DEFER (gated on R1) → telemetry done** | ✅ The highest-value slice landed now that R1 exists: `scrubbingAdapter` + `scrubPathsByStep` (`@loom/telemetry`) mask `sensitive`/`internal`-marked step input/output (`[redacted]`) before any telemetry adapter sees them; `defineConfig` wires it **automatically** from the registered steps (pass-through when unmarked, G2). `secret` needs no scrubbing (K10-R2 keeps it off the log/telemetry entirely). a2ui/CLI egress remain follow-ups on the same helper. |
| **K10-R7** — append benchmark + joint conformance | **SHIPPED** | **ACCEPT (bench) → done** | ✅ `plugins/crypto/src/append.bench.ts` — the marked-vs-unmarked-vs-unwired append benchmark ADR-0022 A4 promised (empty-map wrapper ~1.3x unwired = G2; one encrypted field ~20x = the opt-in cost). Plus a `runKeyStoreConformance` kit in `@loom/conformance` (structural type, no plugin dep) proving the erasure contract — the reference `InMemoryKeyStore` passes it. |
| **T3 Phase A** — subject index (projection) + `exportSubject` (R2/R3) | **SHIPPED** (`@loom/compliance`) | **ACCEPT (high value, K10-independent) → done** | ✅ `SubjectIndex` (`subjectId → executions`, `Map`+reverse-`Map`, live-fed + `fromEvents` rebuild) and `exportSubject` (Art. 15 access + Art. 20 portability — a fold). `defineConfig({ compliance: { subjectOf } })` exposes `app.subjectIndex` + `app.exportSubject`. Ships without erasure (Phase B). A partially-erased subject exports via the K10-R4 tolerant store. The `loom compliance report` inventory over cold storage is deferred (needs a `listExecutions` store-SPI enumerator). |
| **T3 R6.1** — RoPA / processing-inventory generator | missing | **DEFER** | Valuable to compliance teams, but depends on R1.3 (manifest subject-keys) + K10 classes + K7 egress — a heavy aggregation over several unshipped inputs. |
| **T3 R1.4** — email-shape pseudonymization warning | missing | **REJECT (as spec'd)** | Heuristic name/format sniffing is noisy and low-signal. Keep the *principle* (pseudonymous keys, resolve in effects — already the K10 R2 pattern); drop the guesser. |
| **T3 Phase B** — `eraseSubject` + 6-surface `--verify` | **erasure SHIPPED**; verify deferred | **DEFER (gated on K10-R4 + T3 index) → erasure done** | ✅ Now that R4 (tolerant read) and T3-A (index) landed: `EraseCoordinator` / `app.eraseSubject` (Art. 17) — liveness-gated (shred-now vs durable park), decoupled from the crypto plugin via an injected `shred`. The exhaustive 6-surface `--verify` scanner remains aspirational; the R4.3 honesty rule (name the exceptions) is realized by the `parked`/`pending` result shape. |
| **T3 R4.5** — in-flight erasure protocol (`ERASURE_PENDING`) | **SHIPPED** | **ACCEPT within Phase B → done** | ✅ Pinned `ERASURE_PENDING` control fact (EVENT_SCHEMA 1.14.0) + `EraseCoordinator` parks a request while any execution is live and auto-completes on the last termination — never shredding a fold in flight. Durable + restart-recoverable (folds back from the control stream). |
| **T3 R2.4** — tenant-scoped index | missing | **DEFER (gated on K12)** | Right requirement, but K12 tenancy is its dependency. |

## Recommended implementation (this pass): close the K10-R5 gap

The single accept-now, grounded, low-risk, correctness-relevant item is **K10-R5 completion** — and
it is the one that discharges a live audit finding (MEM-F1) and a real latent bug:

1. **`EXECUTION_ARCHIVED` / `EXECUTION_DELETED`** control facts — pinned (K5, `EVENT_SCHEMA` minor
   bump), folded to a terminal marker, so retention records its own pruning (P9). *(Structure over
   values — deleting an execution's payloads still leaves the fact that it was deleted.)*
2. **Branch-family-integrity guard** in `applyRetention` — refuse to delete a terminal execution
   while a live descendant branch depends on its copied prefix (check the `BranchRegistry`). This is
   a **correctness fix**, independent of the rest of the spec's fate.
3. **`defineConfig({ retention })`** — declarative per-workflow `{ archiveAfter, deleteAfter }`,
   closing the ADR-0022 doc-vs-code drift.
4. **`loom retention run`** — the explicit, non-background pass (the spec's own anti-hidden-thread
   stance), emitting the control facts.

Everything else is recorded above as ACCEPT-later (R1 marker → R2 substitution → R6 scrubbing; T3
Phase A index/export), DEFER, or SOFTEN/REJECT. The kernel touch (R2) and erasure (T3-B) are
deliberately **not** first — they are the highest-risk, most-gated pieces, and the taxonomy (R1)
must pressure-test in the outer layers before the kernel freezes it (the K10 spec's own sequencing).

## Doc-drift fixes (independent, cheap)

- `store-crypto` → `@loom/plugin-crypto` in `docs/architecture.md:465`, `docs/adr/0015`, `docs/benchmarks.md:60`.
- ADR 0022 amendment A4 promises an append benchmark that does not exist, and its decision body
  references `defineConfig({retention})` that does not exist — annotate/close both.
