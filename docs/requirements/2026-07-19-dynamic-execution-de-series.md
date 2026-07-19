# Loom Dynamic Execution Requirements (DE Series) — as submitted

- Status: **Evaluated** — see the paired
  [evaluation](2026-07-19-dynamic-execution-de-series-evaluation.md) for per-item
  placement verdicts (kernel / 1P / 3P / reject), the factual corrections to this
  document's citations, and the accepted corrected series (ADRs 0060–0065).
- Motivating workload: Generative UI (GenUI / "Project Syncopate") — intent-driven
  blueprint planning (`planDashboard`, agent-produced `PrivateExecutionManifest`s)
  and deterministic, LLM-free blueprint execution (`executeBlueprint`).
- Provenance: submitted 2026-07-19 as the requirements companion to the GenUI
  platform proposal. Committed as received (structure preserved, prose condensed);
  editorial notes in brackets mark claims the evaluation found to be inaccurate —
  the text itself is otherwise unaltered so the record shows what was evaluated.

## 1. Context and scope (as submitted)

GenUI introduces **data-dependent deterministic execution**: a statically compiled
interpreter flow (`executeBlueprint`) walks a content-addressed manifest whose
structure — effect count, order, fan-out shape — is known only at runtime, yet must
remain fully replayable because the manifest is hash-pinned in the run's first
event. The planning flow (`planDashboard`) produces these manifests via an agent
whose output contract is the blueprint schema.

The submission tags each requirement by layer (kernel ×4, compiler ×2, engine SPI
×2, stdlib ×2 + one tool), states the demanding workload, the consequence of
absence, rejected alternatives, and acceptance criteria. Its stated design
invariant: every requirement is an *expression* of the existing model, not an
escape hatch.

[Editorial: the submission frames itself as a third series alongside "RC-1…RC-11
and TS-1…TS-9 in `loom-copilot-stress-requirements.md`". No such file exists; the
RC/TS series and their dispositions live in
`2026-07-15-perpetual-agents-sentinel-workloads.md` §6. It also cites a
"GenUI/Loom fit evaluation" that is not in this repository, and "K10.5/K11.5
seams" — the pin seam is K10.6 (ADR 0055); K11.5 is state migration (ADR 0056).]

## 2. Kernel requirements (as submitted)

### DE-1 — Deterministic parallel-effects combinator (`all$`)

A structured-concurrency primitive launching effects concurrently while recording
and joining results in canonical order (sorted by stepId) independent of
completion order; replay substitutes by canonical index; crash-mid-fan-out
recovery re-executes only the missing effects. Motivated by blueprint hydration
fan-out (a 12-widget dashboard with 3-node graphs ≈ 36 sequential round-trips).
Claims that without it, hand-rolled `Promise.all` over `ctx.run` "produces
completion-order log appends; replay after a crash during fan-out becomes
nondeterministic".

[Editorial: the nondeterminism claim is wrong for this kernel — replay substitutes
by static stepId (`frames[stepId]`), not log position, and `ctx.parallel` already
exists with input-order-preserved results. See evaluation §DE-1.]

### DE-2 — Run durability classes

`flow$({ durability: 'ephemeral' })`: event records buffered in memory, flushed
only on suspension/typed failure/checkpoint/completion; happy-path crash recovery
forfeited (run re-executed from input). Motivated by P0 hydration cost ("a
per-effect Postgres append on every widget of every dashboard load"). Key claimed
semantic: the flush boundary is the repair boundary — a `SchemaDriftError` flushes
the buffered prefix atomically before the suspension event, giving the repair
agent a complete ordered log. Rejects the "split lifecycle" alternative (executing
hydrations outside Loom) as creating two execution semantics.

[Editorial: the cost premise overstates today's write path — `ExecutionJournal`
is sync-in-memory + async-durable; appends never block the hot path per-effect.
See evaluation §DE-2 for why the class itself breaks P1/recovery/fencing.]

### DE-3 — Checkpoint replay barriers ("promotion of deferred kernel item")

Replay barriers: log positions to which replay proceeds with all recorded results
(including agent outputs) substituted, and from which a fork establishes a new run
with clean identity/provenance divergence. Motivated by GenUI prompt checkpointing
/ history scrubbing / Draft A-B forking. Claims "this item was identified during
copilot design and deferred for lack of a demanding workload".

[Editorial: the deferral record does not exist. ADR 0051 ruled RC-9 `checkpoint$`
**"not needed"** — snapshots + K10.4 compaction already bound replay depth — a
shipped/not-needed disposition, not a deferral. Fork-at-sequence with lineage
already exists (`WorkflowRuntime.fork` + BranchRegistry). See evaluation §DE-3.]

### DE-4 — Typed failure channels on effect contracts

`errors:` map of Zod schemas on the `$`-boundary contract; an effect completing on
a declared channel produces a first-class typed logged event; flows branch on it
deterministically; replay substitutes a recorded typed failure exactly as a
recorded success. Motivated by drift repair (`mcpInvoke$` raising `SchemaDriftError`
→ flow suspends into repair). Rejects encoding failures as success-schema unions.
Notes the copilot's identical need (probe failures: ConnectionRefused /
PermissionDenied / Timeout).

## 3. Compiler requirements (as submitted)

### DE-5 — Data-dependent effect sequence contract

Flows whose effect sequence is not statically enumerable but is a deterministic
function of run input; step identity assigned by execution order within the
deterministic walk; documented as an explicit compiler contract. "May resolve to a
no-op audit; it must be performed and documented either way."

### DE-6 — Flow self-reference / re-entry

A flow invokes itself (tail-call re-entry) as a subflow; the drift-repair path
re-enters `executeBlueprint` with the repaired blueprint ref; recursion depth
bounded by an explicit guard completing on a typed failure channel.

## 4. Engine SPI requirements (as submitted)

### DE-7 — Ephemeral tier in the Engine SPI

The buffer/flush lifecycle DE-2 requires: in-memory event buffer per ephemeral
run, atomic flush-on-demand, lost-run signaling on worker death.

### TS-10 — Low-latency batched reference resolution (extends TS series)

Effect-store backends support batched resolution of result references at
interactive read latency (target p95 ≤ 150ms for ≤ 50 references) with an
optional cache tier; motivated by frozen-snapshot sharing (a snapshot is a
pointer to a completed run; serving it is a read-path fan-out with a human
waiting). Cache invalidation trivial for content-addressed results.

## 5. Standard library requirements (as submitted)

### DE-8 — `mcpInvoke$`

Generic MCP invocation over `@modelcontextprotocol/sdk`: runtime tool name/args;
verification of observed output schema against a caller-supplied
`expectedSchemaHash`, completing on a typed `schemaDrift` channel on mismatch;
principal propagation for per-recipient RBAC; dispatch target as a first-class
indexed log field. One canonical schema-hashing implementation shared with the
registry's change-detection pipeline.

### DE-9 — Sensitive-field classification on contracts

Contracts annotate fields as `sensitive`; annotated fields stored by reference or
redacted in projections, never verbatim in the append-only log. Motivated by
live-blueprint sharing carrying recipient principals. "The annotation is cheap now
and impossible later."

### `sandboxEval$` — hardened reshaping executor

QuickJS/Wasm sandbox as a standard tool: content-addressed script ref in, resource
limits enforced, no ambient I/O, output validated against a shape hash (typed
failure on mismatch). "Per-application implementations are a security
anti-pattern — written once, audited once."

## 6. Explicit non-requirements (as submitted)

- Declarative rotation policies — remain deferred.
- External-wait transfer — "remains deferred". [Editorial: it is **rejected
  permanently** (ADR 0052 D3), not deferred.]
- Runtime flow registration — explicitly rejected (dynamic behavior is *data*,
  never dynamically compiled flows). [Editorial: matches the repo record — P5,
  ADR 0043.]
- A2UI batch/priority hydration semantics — protocol layer, tracked in the A2UI
  surface spec.
- Registry reverse index (tool-schema-hash → pinning blueprints) — registry
  schema addition, plain Postgres.

## 7. Dependency order (as submitted)

DE-5 gates all (interpreter pattern); DE-4 → DE-8/DE-6/DE-1 semantics; DE-1/DE-2/
DE-7 → interactive latency; DE-3 → product surface; TS-10 → snapshot GA; DE-9 →
before live-sharing traffic. Phases: (1) DE-5 audit + DE-4 + DE-8 + sandboxEval$;
(2) DE-1 + DE-2 + DE-7; (3) DE-3 + TS-10 + DE-9.

## 8. Closing rationale (as submitted)

"The kernel grows by exactly two primitives and one contract extension, and every
addition is exercised by a named product feature with a named failure mode in its
absence." Convergence of the copilot and GenUI on DE-1/DE-4/DE-8 is presented as
evidence these are kernel- and stdlib-shaped.

[Editorial: the accepted corrected series is smaller still — one kernel change
(DE-4′), one SPI method (TS-10′), everything else plugins/docs/lints. See the
evaluation's closing section.]
