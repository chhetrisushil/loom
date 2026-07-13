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
| **K10-R3.2** — boot-time middleware-ordering *error* | partial (caller-ordered) | **SOFTEN → document + optional lint** | A hard boot-validator for middleware order is ceremony over a real-but-narrow concern. Document the required order (redaction outermost of data-shapers); a `defineConfig({validate})` warning is the ceiling. |
| **K10-R4 shredded read** — typed placeholder vs. loud throw | throws today | **DECIDE (dual-mode)** | The current `PayloadShreddedError` (fail-closed) is the right *default* (G1). But T3-R4.4 needs CI/deploy-sim to *tolerate* shredded logs. Reconcile: keep loud-throw default; add an opt-in **tolerant read mode** yielding `{$shredded}` for replay/deploy-sim/eval. Not throw-vs-placeholder — both. |
| **K10-R4.2** — branch key lineage for *distinct-subject* forks | shared-subject convention only | **DEFER** | The convention (fork shares subject → jointly shredded) covers the real cases; distinct-subject re-anchoring is speculative. Add `copyPrefix` key re-wrap only when a use case appears. |
| **K10-R6** — egress scrubbing (telemetry/a2ui/CLI) | missing | **DEFER (gated on R1)** | The genuine "6th surface," but it *drives off R1 markers* — build after the marker lands. Telemetry-post-redaction is the highest-value slice. |
| **K10-R7** — append benchmark + joint conformance | missing bench | **ACCEPT (bench)** | ADR 0022's own amendment A4 *promised* a marked-vs-unmarked append benchmark that was never shipped — close that. Add crypto/retention runners to `@loom/conformance`. |
| **T3 Phase A** — subject index (projection) + `exportSubject` (R2/R3) | missing | **ACCEPT (high value, K10-independent)** | Productizes Loom's *structural strength* (event-sourcing is superior for Art. 15/20 access + portability). Index is "just another projection," export is a fold — zero kernel risk. Ships without erasure. |
| **T3 R6.1** — RoPA / processing-inventory generator | missing | **DEFER** | Valuable to compliance teams, but depends on R1.3 (manifest subject-keys) + K10 classes + K7 egress — a heavy aggregation over several unshipped inputs. |
| **T3 R1.4** — email-shape pseudonymization warning | missing | **REJECT (as spec'd)** | Heuristic name/format sniffing is noisy and low-signal. Keep the *principle* (pseudonymous keys, resolve in effects — already the K10 R2 pattern); drop the guesser. |
| **T3 Phase B** — `eraseSubject` + 6-surface `--verify` | missing | **DEFER (gated on K10-R4 tolerant mode + T3 index)** | Sound, but downstream of the index (T3-A) *and* the shredded-tolerance decision. The **R4.3 honesty rule** ("an honest 5/6 with a named sixth beats a silent 6/6") is excellent and should be normative when it lands; the exhaustive 6-surface scanner is aspirational. |
| **T3 R4.5** — in-flight erasure protocol (`ERASURE_PENDING`) | missing | **ACCEPT within Phase B** | Correct: never shred state a live execution is folding over. Cancel-first (K8) or park. Non-negotiable for erasure correctness. |
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
