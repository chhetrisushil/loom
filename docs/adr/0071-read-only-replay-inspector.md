# ADR 0071 — Read-only replay inspector (`@loom/replay-inspector`), IX series

- Status: **Accepted — shipped** (IX-1, IX-2, IX-3, IX-5, IX-7)
- Date: 2026-08-07
- Builds on: read-models as a cache and never an authority ([ADR 0040](0040-live-query-and-orchestration.md),
  [ADR 0058](0058-read-model-plugin.md)), plugin packaging & the package/plugin split
  ([ADR 0043](0043-plugin-packaging-and-1p-3p-separation.md)), the mechanism-stays-in-`packages/*`
  precedent ([ADR 0068](0068-projection-selector-subscription.md) D2), run chaining deferred
  ([ADR 0052](0052-run-chaining-deferred-evidence-gate.md)), K11 flow-hash pinning, K10-R1
  data classification (`@loom/classify`).
- Part of: the kernel/1P/3P triage discipline (P10 — bias outward). **KERNEL_ABI unchanged
  (1.1.0); EVENT_SCHEMA unchanged (1.17.0); no new event kind, no new syscall, no new
  primitive, no compiler change.**

## Context

The IX series is the sole survivor of a withdrawn three-series proposal to import The Elm
Architecture into the kernel. That proposal was withdrawn in full: its two other series were
either already served by shipped mechanisms or re-litigated decisions recorded in ADRs 0051
and 0052. IX survived review because its justification did not route through the analogy —
loom already has deterministic replay, an append-only log, immutable folded state, and
snapshots; there was simply no surface to look at them through.

The withdrawn document is superseded and nothing is inherited from it except this series,
reduced. IX-4 (subscription timeline) and IX-6 (rotation-transparent timeline) are dropped:
the first depended on the withdrawn kernel series, the second on `rotate$`, which does not
exist and is deferred behind ADR 0052's evidence gate.

### The demand gate (G1), recorded honestly

The draft placed a gate ahead of implementation: name one demand artifact — an incident, a
debugging session that required manual log reading, a standing request — or do not build.
That gate is the right shape, and it is the one thing the withdrawn document's two gates
were not: failable on *nobody needs this* rather than on *we cannot build it*.

**No incident or issue exists.** The artifact is the repository owner's direct instruction to
proceed, given after reviewing the reduced scope and the gate itself. That is a real demand
signal — the operator is the addressee the gate names — but it is weaker than an incident,
and recording it as anything else would be the kind of manufactured justification this series
was written to avoid. If usage does not follow, that is evidence, and this package is small
and freestanding enough to retire.

## Decisions

### D1 — `packages/replay-inspector`, not a plugin

ADR 0043 puts vendor/framework **adapters** in `plugins/` and framework-agnostic
**mechanisms** in `packages/`; ADR 0068 D2 applied that same test to `subscribeSelector`.
A read-only inspector over the `EventStore`/`SnapshotStore` SPIs is generic over every
backend, so it is a mechanism. If a rendering surface is later built on it, that surface is
the plugin (`renderer-react` precedent).

This corrects the draft requirement's own header, which said "1P plugin" and cited
`plugins/read-model` + `@loom/plugin-kit` as an existing privileged-read *host*. **No such
host exists.** `plugins/read-model` is `ReadModelService` (register definitions,
`handleEvent`, cursor-paged `query`) — a projection service. `@loom/plugin-kit` is
`defineStoragePreset`/`CustomStorage` — a storage-preset helper. The inspector consumes the
store SPIs directly; tenant scoping is the caller's job via `TenantScopedEventStore`, and
the inspector never widens the scope it is given.

### D2 — The read-only boundary is a type narrowing, not a dependency-graph check

The draft's acceptance criterion — "the plugin's transitive dependency graph contains no
`EventStore` write method" — is not a checkable property. A dependency graph is over
modules, and `EventStore` carries `append`/`acquireFence`/`copyPrefix` on the same interface
as `read`/`readFrom`/`readRange`.

What is checkable, and stronger:

```ts
type ReadOnlyEventStore    = Pick<EventStore, "read" | "readFrom" | "readRange">;
type ReadOnlySnapshotStore = Pick<SnapshotStore, "loadLatest" | "loadAt" | "loadLatestBefore">;
```

`append` and `save` are out of scope everywhere in the package and `tsc` is the enforcement.
`subscribe` is excluded too, although read-shaped: a live subscription is a retained listener
and real load on the writer's backend, so excluding it is how IX-7 (non-perturbation) is
enforced structurally rather than by convention. Two tests pin this — a `@ts-expect-error`
type assertion, and a behavioural spy assertion that no mutating store method is called on
any public path.

### D3 — Reconstruction is snapshot-anchored and **batch**-folded; `ReplayVM` is unchanged

The draft cited `ReplayVM.applyEvent` + `getState` as "scrub-to-event directly — the
primitive already exists". It is not the primitive to build on. `applyEvent` is
`foldEvents([event], this.state)` (`ReplayVM.ts:61`), and `foldEvents` calls
`resetFoldOwnership()` at its head (`foldEvents.ts:33`), so one-event-per-call never reaches
`appendAudit`'s in-place branch and re-copies every audit list at every step — **O(n²)** in
audit-list length, against an acceptance criterion of 10⁴ events in interactive time.

The shape adopted needs no change to `@loom/replay-vm`:

```
anchor = snapshots.loadLatestBefore(id, firstPosition)   // already exists, built for fork()
events = events.readRange(id, anchor + 1, lastPosition)  // one bounded read
states = one foldEvents call PER REQUESTED POSITION
```

Two store round-trips per call regardless of how many positions are requested; O(E) event
work plus O(P·|audit|) for P positions instead of O(E·|audit|). Anchoring is at the *first*
requested position, not the last, or every earlier position would replay backwards.

Seeding a fold from a store-owned `Snapshot` is safe and needs no clone: `setFrame`
(`eventHandlers.ts:19-32`) and `appendAudit` (`62-70`) are both guarded by the `foldOwned`
WeakSet that `resetFoldOwnership()` clears per call, so the caller's arrays are copied on
first write. A regression test asserts the store's snapshot is unmutated after repeated
reconstruction.

### D4 — `workflowVersion` is not durable; the pin is `flowHash`

Found while writing the fidelity test, and it changes the requirement. The draft's
acceptance was "reconstruction at the final event is bit-identical to live state." That is
correct for everything the log determines and **wrong for one field**.

No event handler writes `ExecutionState.workflowVersion`. `WorkflowRuntime.foldState` seeds
it from `this.flows.get(workflowId).definition.version` — the **currently registered** flow
(`WorkflowRuntime.ts:857-861`). Under skew the kernel therefore reports the deployed version
for an old execution. Matching it would make the inspector present inferred-from-current
data as though the log said so — precisely the failure IX-5 exists to prevent.

So the inspector reports `""` ("not recorded") unless a snapshot carries the value, and the
durable pin is `variables._flowHash` (K11.1, folded from `EXECUTION_STARTED`). A skew test
pins the difference: after re-registering the flow at a new version, the kernel's projected
`workflowVersion` moves and the inspector's pin does not.

Relatedly, the acceptance wording "bit-identical" is replaced by **structural** equality.
Segment-wise and one-shot folds produce equal values with different array identities by
construction; a reference-identity assertion would fail on a correct implementation.

### D5 — IX-5's third case: `unpinned-legacy`

`EXECUTION_STARTED.flowHash` is optional, additive at EVENT_SCHEMA 1.4.0, folds treating
absence as legacy. The draft handled *pinned-and-retrievable* and *pinned-but-missing* and
missed *never pinned*. A pre-1.4.0 execution renders `unpinned (legacy)` explicitly — not a
blank, not an inference.

### D6 — IX-3 degrades explicitly instead of blocking (resolves the draft's §3.1 conflict)

The draft's own satisfiability pass found IX-3 unsatisfiable under version fidelity unless
superseded projection chunks remain retrievable, and blocked IX-3 on that answer. The answer
is knowable: chunks are Vite build artifacts emitted via `this.emitFile` into `build.outDir`
(`tools/compiler/src/plugin.ts:63-67`). They are deploy output, not versioned retrievable
objects, so retention is a property of the **deployment**, not of the chunking pipeline — and
by default old chunks are gone.

That unblocks IX-3 rather than blocking it, by designing the degradation:

| Slice status | When |
|---|---|
| `ok` | The pinned fold ran. |
| `unaffected` | The projection declares none of the event types in range. Reported with its initial state — **never omitted**, because absence and no-change are different facts. |
| `unavailable` | The pinned fold body could not be resolved, or threw. No state, a reason, and **no** current-version fallback. |

A throwing fold is scoped to its own projection so one broken fold cannot blank the view.

Projection reconstruction has no snapshot anchor at all (see D7 Q1), so it always folds from
zero — made affordable by pre-filtering the log through an inverted `eventType → projectionId`
index built from the manifest's statically extracted key sets, without loading any chunk.
One log read serves all projections; each folds only its own events.

### D7 — The routed claims, answered

| | Question | Answer |
|---|---|---|
| Q1 | Does the snapshot store hold projection state? | **No.** `Snapshot.state` is typed `ExecutionState`; projection state lives per-(projectionId, executionId) in the projection runtime and is never persisted through the SPI. Mitigated by manifest pre-filtering (D6). |
| Q2 | Can a superseded-version execution's log be retrieved? | **Yes, trivially.** `EventStore.read` is keyed by `executionId` alone; pinning has no bearing on retrieval. The real question behind it was Q3. |
| Q3 | Are superseded projection chunks retained? | **Not by default** — they are deploy artifacts. Resolved by design (D6), not by waiting. |
| Q4 | What is the real observability substrate? | **Still open.** The draft specified IX-7 against a "TS-series telemetry substrate" that does not exist. IX-7 is implemented with the direct criterion (no subscription, no lock, bounded reads on a replica) and no substrate dependency. |
| Q5 | Is there an existing state-diff renderer? | **No.** `agent-surface/applyPatch.ts` is a path-based immutable *update*; `resolvePath` resolves one dot-path. One small differ ships here, shared by IX-2 and IX-3. |

### D8 — IX-8 stays gated; the fold's silent skip is unchanged

`foldEvents` retrieves a handler and skips silently when there is none
(`foldEvents.ts:35-38`). That is load-bearing for **mixed-fleet tolerance** — an older node
folding a log a newer node wrote — and is not changed. Note this is not, as the draft
supposed, about flow-version skew: the `handlers` table is per-binary and keyed to
`EVENT_SCHEMA_VERSION`, and flow pinning has no bearing on which event kinds the fold knows.

Surfacing skipped events in the timeline (IX-8) is separately demand-gated and no demand has
been named, so it is not built. The inspector *does* reproduce the skip behaviour exactly —
an inspector that errors where the kernel skips is not showing what happened — and a test
pins that.

### D9 — Security posture

- **Access boundary is the caller's.** The inspector reads whatever store it is handed and
  never widens scope. Scope with `TenantScopedEventStore` / `TenantScopedSnapshotStore`.
- **Redaction is defence in depth**, wired to K10-R1 `@loom/classify` `maskPaths`, and is
  applied **before** the diff so a masked value cannot leak through a change record's
  `before`/`after`. The pin is read from the unredacted fold — it is a content hash, not
  user data.
- **Prototype pollution is structurally impossible** in the differ: output is a flat array of
  `{ path, kind }` records, so no user-controlled string is used as a write key, and reads
  use `Object.keys`/`Object.hasOwn`. Projection handlers and the `_flowHash` key are resolved
  with own-key checks so an inherited name never resolves to a callable or a pin.
- **Denial of service is bounded**: the differ is iterative (no stack exhaustion), cycle-safe,
  and capped on depth and output size with truncation reported; reconstruction refuses an
  over-budget read with `InspectorBudgetError` rather than returning a short one.

## Consequences

- New package `@loom/replay-inspector`; 67 tests green; repo build and lint clean.
- Kernel untouched. No event kind, no syscall, no primitive, no compiler change,
  no `@loom/spec` capability entry.
- `ReplayVM` is unchanged — D3's batching removes the need for an incremental API on it.
- Two findings recorded for their own sake, independent of this package: `workflowVersion`
  is not durable (D4), and projection state has no snapshot representation (D7 Q1).

## Alternatives considered

- **An ownership-preserving incremental API on `ReplayVM`** — would fix D3's quadratic path
  at the source, but changes a kernel-adjacent package for a caller that does not need it
  once batching is used. Rejected; revisit only if a second consumer needs single-stepping.
- **Caching loaded projection chunks in the inspector** — an unbounded Map keyed by
  projection × flow hash, duplicating the module system's own cache. Rejected as a retention
  surface for no gain.
- **Blocking IX-3 on Q3** as the draft specified — the answer was knowable without waiting,
  and the useful response was a degradation design rather than a pause. See D6.
- **Matching the kernel's `workflowVersion`** to satisfy "bit-identical" — would have made the
  tool report current-code inference as logged fact. Rejected; see D4.
