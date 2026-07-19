# DE Series — Placement Evaluation (GenUI dynamic execution)

- Status: **Verdicts recorded; corrected series accepted** — ADRs 0060–0065.
- Evaluates: [the DE series as submitted](2026-07-19-dynamic-execution-de-series.md).
- Method: the ADR 0051 discipline — a placement verdict (kernel / 1P plugin / 3P
  plugin / reject) per item, judged against the best userland alternative, bias
  outward (P10). Every claim in the submission was verified against the repo
  record before judgment; corrections are listed first because several verdicts
  turn on them.

## 0. Factual corrections to the submission

| # | Submitted claim | Repo record |
|---|---|---|
| C1 | DE-3 "promotes a deferred kernel item" (checkpoint replay barriers "identified during copilot design and deferred") | **No such deferral exists.** ADR 0051 ruled RC-9 `checkpoint$` **"not needed"** — snapshots (`snapshotEvery`, `loadLatestBefore`) + K10.4 compaction already bound replay depth. Disposition: shipped/not-needed. |
| C2 | Continuity with "RC-1…RC-11 and TS-1…TS-9 in `loom-copilot-stress-requirements.md`" | File doesn't exist. The series' dispositions live in `2026-07-15-perpetual-agents-sentinel-workloads.md` §6. |
| C3 | "the unresolved hot-path question from the GenUI/Loom fit evaluation" | No such document in the repo. |
| C4 | "External-wait transfer — remains deferred" | **Rejected permanently** (ADR 0052 D3), explicitly not to be reintroduced. |
| C5 | "K10.5/K11.5 seams" | Pin seam is **K10.6** (ADR 0055); K11.5 is state-migration-on-resume (ADR 0056). |
| C6 | DE-1: hand-rolled `Promise.all` over `ctx.run` makes replay "nondeterministic" via completion-order appends | Replay substitutes by **static stepId** (`frames[stepId]`), not log position. Completion-order interleaving is already replay-safe; `ctx.parallel` + `parallelLimit` preserve input order in results. |
| C7 | DE-2: "a per-effect Postgres append on every widget load is the wrong cost profile" | `ExecutionJournal.commit` is synchronous-in-memory + async-durable (serial FIFO, drained at barriers). The hot path never blocks per-effect on the store. Write *volume* is real; write *latency-in-path* is not. |

## 1. Verdicts

### DE-1 `all$` — REJECT as kernel primitive → userspace `fanout$` (shipped, `@loom/orchestration`)

The submission's two failure modes don't hold here: (a) serial-only — false,
`ctx.parallel` is an existing syscall; (b) nondeterministic replay — false (C6).
Crash-mid-fan-out recovery already re-executes only missing effects (completed
frames short-circuit). The *real* gap inside DE-1 is identity: a runtime-sized
fan-out must mint distinct step ids, which is the DE-5 identity rule. Canonical
join order adds nothing replay needs.

Accepted residue: `fanout$(ctx, baseStep, items)` — mints `${id}#${i}` per item
over `ctx.parallel` (the saga `#compensate:${i}` idiom), input-order results,
nesting composes by id. Pure userspace; KERNEL_ABI stays 1.1.0. The dormant
`PARALLEL_STARTED/COMPLETED` events stay dormant (observability, not correctness).

### DE-2 durability classes — REJECT (kernel) → hot-path architecture + ADR 0065 deferral

Buffering events until flush breaks three load-bearing properties at once: crash
recovery of a running execution (nothing durable to fold), K9.4 fencing (nothing
to fence against — zombie writers become invisible), and the snapshot invariant
(snapshots must only reference durable events). "Semantics observable to
application code are identical across classes" is unachievable: lost-run
semantics ARE observable. Two durability classes is precisely the second
semantic model the submission's own invariant forbids.

The workload is answered without the class:

**The P0 hydration path is not a loom run.** A transient interpreter service
walks the content-addressed `PrivateExecutionManifest` in plain code (optionally
fronted by `@loom/plugin-read-model`, ADR 0058, for materialized results). The
determinism boundary is crossed only when something durable happens: drift
detected → start a **durable repair run whose input carries the forensic
payload** (manifest ref, failed node, observed hash) and whose own log records
the repair. This is the recorded ST-R/ADR 0059 discipline — *transient
transport, durable outcome* — and it answers the submission's "split lifecycle"
objection directly: the handoff is one typed input; there remains exactly one
replay model. Planning runs (agent-in-the-loop) stay durable loom runs, where
replay/fork/provenance actually pay.

The submission's "flush boundary is the repair boundary" property is preserved
*better* by this split: the repair run's forensics are its validated input plus
its own complete log, not a buffered prefix whose atomic flush must be trusted.

If durable hydration runs are ever wanted and write volume is *measured* to be
the blocker, the semantics-free knob is engine-side group-commit batching inside
the existing serial append FIFO — recorded as a deferral-behind-evidence in
**ADR 0065**, ADR 0052 style. Explicitly not durability classes.

### DE-3 replay barriers — REJECT (already exists; premise false per C1)

Everything the product surface needs is shipped under other names:

- *Replay-to-checkpoint without re-invoking the planner LLM*: replay NEVER
  re-invokes effects — that is P2, `agent$` included. Materialize state at any
  sequence (`materializeStateAt`, snapshots bound the fold).
- *Fork with provenance*: `WorkflowRuntime.fork(parentId, atSequence)` — prefix
  copy + seed snapshot + `BranchRegistry` lineage (`forkedFrom`/`forkSequence`).
- *Independent forks*: two forks from one sequence share nothing mutable.

GenUI checkpoints are an application-level map `checkpointName → (executionId,
sequence)` — one table. A durable barrier *event* is actively harmful: fork
deliberately emits no `EXECUTION_FORKED` event because inserting one would
perturb sequence numbering and break the byte-identical-prefix guarantee.
The DE-3 "barrier forces flush" criterion evaporates with DE-2's rejection.

### DE-4 typed failure channels — ACCEPT, modified (ADR 0060, **the one kernel change**)

The genuine kernel gap, and the convergence claim holds (copilot probe failures
want the same). As submitted it implied a `ctx.fail` syscall + new event; the
governing precedent (saga: `ctx.compensate` + `COMPENSATION_*` proved
unnecessary) shapes the correction:

- `errors:` Zod map on step/tool/Effect contracts (step wins, registry fallback —
  the K9.3 idiom).
- `TypedFailure` is a **userspace throw** (`fail(channel, payload)`); no syscall,
  KERNEL_ABI stays 1.1.0.
- STEP_FAILED gains additive `{channel, payload}` (payload validated at emit
  time) — EVENT_SCHEMA 1.16.0 → 1.17.0.
- The execute seam **substitutes** a recorded declared-channel failure on
  replay/re-invocation (the failure twin of the completed short-circuit);
  undeclared channels and invalid payloads degrade loudly to legacy untyped
  semantics (G2).
- retryMiddleware's default stops retrying `TypedFailure` (a declared domain
  outcome is not transient).

### DE-5 data-dependent sequences — ACCEPT as audit + guardrails (ADR 0061; no kernel change)

The audit was performed and was NOT a no-op: it surfaced a real silent-corruption
hazard — `ctx.run(sameStep, itemN)` in a loop is served iteration-0's memoized
output for every subsequent iteration (frames are keyed by id). The corrected
contract: **the sequence of durable-step identities must be a pure function of
logged inputs; dynamic ids are minted deterministically** (`${id}#${index}`).
Shipped as: normative doc (architecture.md), compiler lint (`analyzeLoopIdentity`
— flags loop-scoped `ctx.run` whose id can't vary per iteration), kernel
crash-matrix test (interpreter loop, kill at each position, byte-identical
replay), and a `flowContentHash`/manifest scope statement (dynamic steps are
deliberately outside the structural hash; fold-compatibility is guaranteed by
the identity rule; dynamic steps bind a static `toolId` to a registered effect).

### DE-6 self-reference — ACCEPT as guard + test (no new machinery)

`@loom/orchestration`'s `awaitChild` already supports recursion (`parent::key`
child ids peel correctly). Shipped residue: `maxDepth` guard completing on a
typed `depthExceeded` channel (DE-4′), plus recursion tests. In-band same-run
re-entry is just calling the interpreter again with repaired input — id
discipline per DE-5′.

### DE-7 ephemeral SPI tier — REJECT (falls with DE-2; ADR 0065 records the sound residue)

### TS-10 batched refs — ACCEPT at the ContentStore SPI (ADR 0062)

Correct diagnosis, right layer, wrong series anchor (the effect-store surface is
the `ContentStore` SPI, ADR 0046/0054/0059 lineage). Today `resolveRefs` issues
one `get` per ref with object fields sequential — a latency cliff on network
backends. Shipped: optional `getMany(refs[])` (positional, null-on-absence),
batch-scoped coalescing in `ContentResolvingEventStore` (collect across the read
batch → dedupe → one round-trip → substitute), claim-check batch reader,
`CachingContentStore` (byte-budgeted LRU; content-addressed ⇒ cache-forever,
with delete-evicts-first so erasure is never resurrected), conformance + bench
against the p95 ≤ 150ms / 50-ref budget.

### DE-8 `mcpInvoke$` — ACCEPT, re-placed in `@loom/plugin-mcp` (ADR 0063)

Not "stdlib": the ADR 0043 litmus (exists because of a specific external system
→ plugin) puts MCP dispatch in the MCP plugin. The submission's mechanism is
sound and was net-new (the plugin captured `jsonInputSchema` but never hashed
it). Shipped: canonical JSON-schema hash in `@loom/core` (`canonicalJson` +
`fnv1a64` — importable by a registry change-detector without the plugin), ONE
registered `mcp.invoke` effect dispatched via dynamically-minted step ids (the
DE-5′ idiom — never an effect per tool), `schemaDrift`/`toolNotFound` declared
channels (DE-4′), principal via opaque `ctx.principal` mapped to transport
headers inside the effect (never logged; token-in-input fallback classified
`secret()` → SecretRef), dispatch-target as a userspace `MCP_DISPATCHED` domain
event indexed by a read-model projection (ADR 0058) — not log parsing, no
EVENT_SCHEMA bump (the fold skips unknown types).

### DE-9 sensitive fields — ACCEPT; mostly already built

The submission asked for a convention with deferred kernel promotion; the repo
already exceeds it: `@loom/classify` (`secret()`/`sensitive()`/`internal()`
authored at the Zod schema), `redactionMiddleware` (secret → SecretRef before
persist), crypto-at-rest, telemetry scrubbing, subject erasure. Work: apply the
vocabulary to tool contract fields (done in `mcpInvoke$`) and document the
pattern as normative for principal-carrying tools. No promotion decision needed.

### `sandboxEval$` — ACCEPT as new 1P plugin `@loom/plugin-sandbox` (ADR 0064)

Genuinely net-new (no JS-VM sandbox exists). The write-once-audit-once argument
is sound. Engine: quickjs-emscripten (capability-empty by construction — vs
`@loom/isolate`'s subtractive scrubbing of an ambient-authority child process);
contract shape follows `IsolatedToolSpec`. Content-addressed script refs via the
ContentStore; memory/interrupt/wall-clock limits; typed `scriptMissing` /
`limitExceeded` / `shapeMismatch` channels (DE-4′) so a planner can catch and
re-plan, and replay never re-burns CPU.

### Non-requirements §6 — ENDORSED, with C4's correction (external-wait transfer
is rejected, not deferred). The runtime-flow-registration rejection matches
P5/ADR 0043 exactly and is the submission's best judgment call.

## 2. The corrected series in one table

| Item | Verdict | Lands as | ADR |
|---|---|---|---|
| DE-1 | reject kernel / accept helper | `fanout$` in `@loom/orchestration` | 0061 (identity rule) |
| DE-2 | reject | transient hydration service + read-model; group-commit deferred | 0065 |
| DE-3 | reject (exists) | app map → `fork(parentId, atSequence)` + BranchRegistry | — |
| DE-4 | **accept (kernel)** | `errors:` contracts + TypedFailure substitution | 0060 |
| DE-5 | accept (guardrails) | identity rule + lint + crash-matrix tests | 0061 |
| DE-6 | accept (guard+test) | `awaitChild` maxDepth → typed `depthExceeded` | 0061 |
| DE-7 | reject | — (residue in 0065) | 0065 |
| TS-10 | accept (SPI) | `ContentStore.getMany` + coalescing + cache decorator | 0062 |
| DE-8 | accept (plugin) | `mcpInvoke$` in `@loom/plugin-mcp` + core schema hash | 0063 |
| DE-9 | accept (built) | `@loom/classify` applied to tool contracts | 0063 (usage) |
| sandboxEval$ | accept (plugin) | `@loom/plugin-sandbox` (quickjs) | 0064 |

**Net kernel growth: zero syscalls, zero event types, one additive event-payload
extension.** KERNEL_ABI stays 1.1.0; EVENT_SCHEMA 1.16.0 → 1.17.0; EVENT_STORE
SPI untouched; `CONTENT_STORE_SPI_VERSION` introduced at 1.2.0 (retroactively
naming 1.0.0 = ADR 0046, 1.1.0 = putStream).

## 3. Closing note

The submission's closing rationale claimed the strongest argument was what it
did *not* ask for. The evaluation agrees with the sentiment and applies it one
turn further: of the "two primitives and one contract extension" it proposed,
both primitives dissolve — one into an existing syscall plus an identity rule,
one into an architecture decision the kernel's own prior rejections (ST-R) had
already made — and the contract extension survives because two independent
workloads genuinely converge on it. The deferral discipline holds: nothing was
promoted on speculation, one deferral was recorded with an explicit evidence
gate (ADR 0065), and three claimed prior-record citations were corrected rather
than inherited (C1–C5).
