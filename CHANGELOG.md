# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`@loom/workflow-runtime`: compaction integrity**
  ([ADR 0106](docs/adr/0106-compaction-integrity.md), backlog L11). Defects in
  `LogLifecycle.compact` and the code that reads what it leaves:

  - **A resume after compaction lost its events.** The checkpoint was folded with no identity,
    so its `executionId`/`workflowId`/`workflowVersion` were `""`, and the journal stamped
    every envelope from the folded state: the resume's events were appended to execution `""`.
    The checkpoint now takes its identity from the log. Its version comes from the base
    snapshot, or from the latest snapshot when the base is a blank pre-0106 checkpoint. The
    journal writes under the id it was started for and refuses a blank one, so a legacy
    `restoreFromState` state appends nothing. Every snapshot-seeded fold (`resume`, `resumeAs`,
    `loadState`, `cancel`, `fork`) fills a blank identity. A NON-blank one naming another
    execution is refused (`SnapshotIdentityMismatchError`) rather than overwritten.
  - **A second compaction dropped the first one's prefix.** It folded the surviving events
    from scratch. It now folds on the latest snapshot at or below its checkpoint, and throws
    `CompactionCheckpointMissingError` (nothing saved or truncated) when a compacted log has
    none at or above its gap.
  - **A denied resume wrote into the checkpoint's slot.** `EXECUTION_DENIED` was recorded
    after the log's last event. On a log compacted through its tip (`[0]`), that slot sits at
    or below the checkpoint, so the log looked never-compacted and the next compaction lost the
    suspension. It is now recorded after the folded tip.
  - **Compaction deleted pinned events (ADR 0055 D1).** `LogLifecycle` takes
    `pinnedEventTypes` (`defineConfig({ durability: { retention: { pinnedEventTypes } } })`,
    validated at boot) and keeps those events in place. Non-strings and every kernel-written
    kind are refused, including `EXECUTION_RECOVERED` and `EffectInDoubtResolved`. `compact`
    consults the `pinned` predicate only when no kinds are declared. With kinds declared, a
    pinned execution (the documented sentinel setup pins by the same kinds) compacts around
    them. Reserved control streams are refused.
  - **The shred tombstone landed in the checkpoint's slot.** `shredSubject` placed
    `PAYLOAD_SHREDDED` at `read().length`, at or below a compacted log's checkpoint. The next
    compaction then deleted the A3 evidence, or the log read as never compacted. It now follows
    the folded tip. **Breaking:** on a store that can `truncatePrefix`, pass the raw
    `snapshotStore` (or `tombstoneSequenceOf`). Otherwise it refuses, before the key is
    destroyed.
  - **Erasure waited forever on a compacted terminal execution.** `EraseCoordinator` folded
    the log alone. It now takes `snapshotStore` (`defineConfig` wires it).
  - **The tip rule.** When compaction keeps events, it never removes the log's tip. A
    checkpoint is therefore always the log's highest missing sequence, a gap-free log was never
    compacted, and no reader needs a "checkpoint above the tip" special case (except the
    bootstrap-only `[0]` a keep-nothing compaction leaves).

  **EventStore SPI 1.5.0:** optional `truncatePrefixKeeping(executionId, through,
  keepEventTypes)`, one atomic delete. In-memory, SQLite and Postgres implement it, and every
  decorator forwards it; the hash-chained store refuses it, as it refuses `truncatePrefix`.
  **A store without it can never compact past a log's first pinned event**, so a long-lived
  execution that records a finding early keeps an unbounded replay tail there. `compact` warns
  (`onWarn`) once per execution. The conformance kit now checks `truncatePrefix` and
  `truncatePrefixKeeping`.

  Readers updated:
  - The content sweep finds a gapped log's checkpoint as the lowest snapshot in `[gap, tip]`.
    A kept finding at sequence 1 used to hide a compaction and let the orphan pass erase
    checkpoint-only refs, and a child forked from a compacted parent was refused.
  - `liveQuery` checks a delta's whole span.
  - The replay inspector refuses a position inside compacted history (`CompactedHistoryError`)
    instead of folding across the gap. It probes past the segment with one `head` read.
  - The content sweep reads a forked child's seed directly (`metadata.forkSequence`,
    `loadAt`).

### Changed

- **`@loom/replay-vm`: a step failure the flow catches no longer fails the execution**
  ([ADR 0105](docs/adr/0105-a-caught-step-failure-is-not-the-executions.md)). `STEP_FAILED`
  folded the EXECUTION status to `failed` as well as the step's frame, so a flow that caught the
  failure (try/catch around `ctx.run`, a saga compensation, a typed-failure fallback) ran on
  under a terminal status. A crash after the catch left an execution `recoverAbandoned` and the
  dispatcher would never re-drive, `cancel` refused, retention could prune as finished, and A2A
  peers polling it were told `failed` (`"unknown error"`). A parallel sibling failing AFTER the
  flow parked did the same to a suspended execution: its gate could not be resumed, and
  `TimerService` retired a timed park's row as obsolete. `STEP_FAILED` now folds the frame only, like `STEP_CANCELLED`;
  `EXECUTION_FAILED`, which the kernel commits when a failure escapes the runner, stays the
  execution's terminal failure.

  - **EVENT_SCHEMA 1.21.0** (no new kind or payload field; KERNEL_ABI unchanged): the status
    fold changed, and a new reserved fold key `_failedWhileParked` (`FAILED_WHILE_PARKED`) marks a
    parked execution a `STEP_FAILED` landed on. A `null` `EXECUTION_RESUMED` in that position stays
    status-only, as 1.20.0 folded it (a 1.20.0 `resumeAs` wrote exactly that entry), so every gate
    passthrough folds as under 1.20.0 and the result no longer depends on which snapshot seeds the
    fold. The key is removed by whatever ends the park (a park, a resume, or a terminal event).
    **Cost (fail-closed), refused at ingress:** a caller's `null` answer to such a gate cannot be
    its answer, so `resume` / `resumeAs` refuse it with `ResumeRefusedError`
    (`null-answer-after-parked-failure`, new reason) and append nothing; resume with a non-null
    answer.
  - Snapshots saved by an older fold are repaired on read: `normalizeSnapshotState`
    (`@loom/replay-vm`, new export) reads `failed` with no `_error` and a failed frame as
    `running` (`suspended` when parked) — on every stored-fold read, including `restoreFromState`.
    Two shapes it cannot tell from a genuine failure, so an old snapshot keeps `failed`: an
    `EXECUTION_FAILED` without `error` (never kernel-written), and an execution that genuinely
    failed, was re-opened by `resumeAs` (stale `_error`) and then caught a step failure. Delete
    that execution's snapshots (`snapshotStore.deleteExecution`) to make the log authoritative.
  - New `reconcileTimers(runtime, { source, timers })` (`@loom/workflow-runtime`) re-arms the
    timer row of every execution suspended on a `wakeAt` (idempotent). Needed once after
    upgrading: a timed park whose sibling failed under the old fold had its row retired by
    `TimerService`, and now reads `suspended` with nothing to wake it.
  - **Behaviour change:** when the `EXECUTION_FAILED` write itself fails, the run now rejects with
    `StorageWriteError` (`cause` = the store's error) instead of the step's error — the log folds
    `running`, so the caller must not be told "failed". `handle.getState()` and `onEvent` remain
    the in-memory view (they saw the commit) and read `failed`.
  - `recoverAbandoned` takes an optional `maxRecoveries` (≥ 1; default unbounded): the number of
    CONSECUTIVE re-drives without progress (`EXECUTION_RECOVERED` at the log's tail since the
    last `STEP_COMPLETED` / `EXECUTION_SUSPENDED` / `EXECUTION_RESUMED`), checked only for claimed
    candidates. Executions at the bound are skipped, counted in `summary.exhausted` (new field)
    and reported through `onExhausted`. `loom recover --max-recoveries N` lists them.
  - `loom eval` goldens that pinned `status: "failed"` for a log ending after a caught failure
    now fail and must be re-recorded.
  - **Upgrade note.** On the first deploy every stored execution whose log ends after a caught
    step failure changes from `failed` to `running`. A staleness-predicate `recoverAbandoned`
    pass then selects all of them, however old, and re-drives each (re-executing an untyped
    failing effect; a changed flow hash throws on every pass), and `LogLifecycle` stops pruning
    them; timed parks whose row the old `TimerService` retired never wake. Before enabling
    recovery: run `orphanCensus` or `recoverAbandoned({ dryRun: true })`, bound `isAbandoned` by
    age, cancel what should not resume, set `maxRecoveries`, and run `reconcileTimers` once.

- **`@loom/workflow-runtime`: a gate is answered only by a resume addressed to it**
  ([ADR 0104](docs/adr/0104-recovery-never-answers-a-gate.md)). **Security fix.**
  `ctx.suspend` serves the recorded resume payloads to gates in order (ADR 0057), so every
  `EXECUTION_RESUMED` payload is some gate's answer. Four writers recorded one that answered no
  gate, and the flow's NEXT gate consumed it: no resume named the gate, no authenticator saw an
  approval, and the gate's declared `resumeSchemas` entry (ADR 0077) was never consulted.

  - Crash recovery (`recoverAbandoned`, `LocalWorkerRuntime`) wrote `EXECUTION_RESUMED {}`. A
    flow that crashed before `ctx.suspend({ on: "go1" })` passed go1 with `{}`. Recovery now
    records `EXECUTION_RECOVERED` alone.
  - An in-doubt verdict (K9.3) became the next gate's approval. It is now a kernel
    `DECISION_RECORDED` keyed by step and attempt, so a verdict also goes stale correctly: a
    "retry-fresh" attempt that itself crashes re-parks in doubt rather than calling the
    non-idempotent tool again. A resume at an in-doubt park that is not a verdict for the parked
    step is now refused (`ResumePayloadValidationError`, nothing appended); it used to be
    appended and re-park.
  - A HumanEffect step's answer went to the next gate while the step re-parked forever. A
    `kind: "human"` step now consumes its answer in order with `ctx.suspend` and completes with
    it.
  - `resumeAs` onto a crashed execution answered its next gate. Onto a terminal one it now
    records `EXECUTION_RESUMED(null)`, which re-opens the execution (a crash during the migrated
    run is recoverable) without answering a gate.
  - `resumeAs` onto an execution parked at a gate answered it under ANY event name, with no
    schema, authenticator or authorizer check. It now enforces all of `resume`'s gate rules
    there.
  - Flow and effect code could forge kernel state: `ctx.emit("EXECUTION_RESUMED", …)` answered
    the flow's own gate, and `STEP_STARTED` + `EFFECT_INDOUBT` + `EXECUTION_RESUMED(verdict)` got
    a non-idempotent step adopted with no tool call. **Behaviour tightening:** `ctx.emit` /
    `stream` / `ui` and `EffectContext.emit` now refuse every kernel event type except
    `RESOURCE_METERED`, `QUOTA_EXCEEDED`, `SAFETY_BLOCKED`, `EGRESS_DENIED`, `EFFECT_DENIED`,
    `OUTCOME_RECORDED` and `DECISION_RECORDED`, and validate those.
    - Meter values must be finite, non-negative and plausible.
    - An EFFECT's `DECISION_RECORDED` is recorded as `effect:<stepId>#<attempt>:<id>`, so it can
      never pre-empt the flow's `ctx.decide`. `AgentRunner`'s routing facts move to that id.
    - No userspace emit may change a recorded choice.
    - An isolated tool's relay forwards application events only; a kernel type fails the run.
    - Decision ids beginning `__loom_` are reserved (`ctx.decide` and emits refuse them; a getter
      cannot dodge the check).
    - A verdict counts only beside the kernel's own `EFFECT_INDOUBT` fact for that step and
      attempt.
  - A human step's park now records `condition.stepId` (kernel-only). A pre-0104 log whose open
    human step's answer cannot be told apart from another entry is refused
    (`ResumeRefusedError`, new reason `ambiguous-legacy-answers`) unless the operator resumes
    with an event carrying `discardLegacyAnswers: { stepId, count }` that the configured
    `ResumeAuthenticator` VERIFIES (never on recovery or a timer). It is recorded durably with
    the verified actor. The old kernel never completed a human step, so nothing that ran is lost.

  **EVENT_SCHEMA 1.20.0:** the fold treats a `null` `EXECUTION_RESUMED` into an unparked or
  in-doubt execution as status-only. The EventStore conformance kit now asserts that a `null`
  payload round-trips. Logs written by the old kernel replay as written, because withdrawing an
  entry that already passed a gate would re-park the flow behind recorded steps or shift later
  payloads one gate early. `resume()` classifies them via `onWarn`, once per execution: "passed"
  (audit which gate) or "at-risk" (the next gate WILL pass with it — act now). **Rolling deploys:**
  hold in-doubt verdicts and `resumeAs` onto terminal executions until every node runs this
  version; an old node folds the new `null` resume as a gate answer. Downgrade is unsafe for the
  same reason. A recovery no longer counts as a
  resume in `@loom/analytics` or fires telemetry's `onFlowResume`. KERNEL_ABI unchanged (1.1.0).

- **`@loom/agent`: `agentLoop$` compaction also triggers on bytes** ([ADR 0087](docs/adr/0087-durable-agent-loop.md)
  D5, amended). D5 named claim-check as the "bytes per turn" answer to the log-growth trade-off;
  it isn't — claim-check offloads a tool RESULT's bytes, not the transcript an agent journals as
  every turn's `STEP_STARTED` input, so one oversized tool result rode along uncompacted until it
  aged past `keepRecent` on message count alone. `compaction` gains `afterBytes` (a running UTF-8
  byte count maintained per message push, O(1) amortized, never a re-serialization — so it stays
  replay-deterministic) alongside the original `afterMessages`; at least one is now required,
  enforced by a constructor guard. The byte trigger keeps the longest run of the newest messages
  whose bytes total at most `afterBytes / 2` (floored at 1, capped at `keepRecent`), and skips
  compacting a turn where the newest message alone is already over budget rather than paying a
  summary call that folds nothing. Also documents, rather than adds a hook for, the claim-check
  contract toward the model: a claim-checked tool's result reaches the model as the recorded
  envelope (ref + digest), never resolved back to its bytes — resolving it would put those bytes
  into the NEXT turn's journaled input, undoing the offload — so declare a `digests[toolId]`
  projection for model-facing claim-checked tools. A `resolveToolResult` hook was considered and
  rejected for the same reason. No kernel change; EVENT_SCHEMA and KERNEL_ABI unchanged; existing
  `afterMessages`-only configurations are unaffected.

- **`@loom/plugin-a2ui`, `@loom/plugin-mcp-app`: A2UI structural validation — dangling ids,
  cycles, unreachable components, malformed catalogues** ([ADR 0088](docs/adr/0088-blueprint-conformance.md)
  D5, amended). `validateComponents` gains four finding codes checkable without JSON Schema —
  `dangling-child`/`dangling-template` (error; a `children` reference no component in scope
  defines), `child-cycle` (error; a component reachable from itself via `children`), and
  `unreachable-component` (warn; no path from `root` reaches it, reported only when
  `requireRoot` and a root exists) — via one iterative white/grey/black DFS, O(V+E), no
  recursion. `column("root", ["ghost"])` and `column("root", ["root"])` previously passed with
  `ok: true`; both now fail. New `validateCatalog(catalog)` checks that every `components`/
  `functions` entry's key agrees with its own `component.const`/`name`
  (`catalog-entry-key-mismatch`/`catalog-function-key-mismatch`), run in the
  `A2UISurfaceBridge` constructor. `ValidateComponentsOptions` gains
  `knownComponents?: ReadonlyMap<string, ComponentInstance>` so a batch's `children` may resolve
  against ids outside itself. `@loom/plugin-mcp-app`'s `surfacePayload` never validated at all
  (an unknown component silently rendered as nothing); `SurfacePayloadOptions` gains
  `catalog?: A2UICatalog` (default `defaultCatalog`) and `surfacePayload` now validates with
  `requireRoot: true` and throws like the A2UI bridge — **one breaking change, loud:** a
  previously-unexamined bad tree now throws.

  **The correction that made recompose checkable:** `A2UISurfaceBridge.recompose` replaces its
  stored tree with each batch, while an A2UI client MERGES `updateComponents` by id — so
  validating a batch against only itself (or the bridge's previous batch) would reject a
  batch's correct reference to an already-delivered sibling. The bridge now keeps
  `clientView: Map<id, ComponentInstance>`, seeded in full when the session opens and merged
  incrementally per batch (O(batch)), and `recompose` validates and walks cycle detection
  against the batch overlaid on that view — so a batch may reference any earlier batch's
  component, and a batch that closes a cycle back through an already-sent component is still
  caught. Deferred: prop-VALUE JSON-Schema checking and `callFunction` argument validation
  (need a JSON-Schema engine plus A2UI `common_types.json` `$ref` resolution — a consumer with
  a typed catalogue, likely loom-ui, is the trigger). No kernel change; EVENT_SCHEMA and
  KERNEL_ABI unchanged.

- **`@loom/conformance`: `runLlmProviderConformance` no longer passes a stream that
  silently drops a tool call.** The kit's own request carries no `tools`, so the general
  parity test could never observe a dropped `toolCalls` — a vacuous input twice over
  (the 2026-09-27 backlog audit, item 4). `runLlmProviderConformance` gains a third,
  optional argument, `opts?: { toolRequest?: LlmRequest | null }`:
  - given a `toolRequest` (a request the provider is known to answer WITH a tool call),
    and when the provider has `stream`, `complete(toolRequest)` MUST itself return ≥1
    tool call (a fixture that makes none is a refusal, not a pass), the stream's
    assembled `toolCalls` MUST `toEqual` it, and when `completed.stopReason` is
    `"tool_use"` the streamed `stopReason` MUST equal it;
  - omitting `toolRequest` on a provider that has `stream` is now a FAILING case —
    "stream parity for tool calls is unproven — pass `toolRequest`" — an absent input is
    a refusal, per the vacuous-check pattern;
  - a text-only provider that genuinely cannot call tools opts out explicitly with
    `{ toolRequest: null }`, visible in its own test file rather than inherited from an
    unset default.

  This is a behavioural tightening of the conformance contract, not an SPI shape change:
  there is no `LLM_SPI_VERSION` constant to bump (`@loom/llm` has none, and the LLM SPI
  is absent from `docs/spec/compatibility-matrix.md`), so the tightening is recorded here
  and on `LlmStreamChunk`'s docstring (`packages/llm/src/types.ts`) instead. The rule
  itself lives in a new internal module, `packages/conformance/src/toolCallParity.ts`
  (not re-exported from the package's single public entry point — no second consumer has
  named a standalone need for it, ADR 0083), so its negative cases (a stream that drops a
  tool call, a vacuous fixture, a missing `toolRequest`) can be unit-tested directly —
  vitest has no supported way to prove a nested `describe`/`it` fails from inside a
  running test. `loom-plugins` and `loom-examples` call the kit zero times today
  (re-grepped at execution time), so the blast radius is the scaffold template only
  (`tools/scaffold/src/plugin.ts`), which now shows `toolRequest` in its generated example
  call. `docs/requirements/2026-08-18-agent-runtime-placement-evaluation.md` gets three
  status notes: K8.4 shipped via ADR 0020 A8's `streamTokenBudget`, not the dropped
  `EffectContext` usage-reporter field the doc still described as pending; and
  `@loom/live-query` is not the "transient delta sink" a since-corrected paragraph named
  it as (it has no delta-push API — see the 2026-09-27 backlog audit's item 2 and
  [ADR 0040](docs/adr/0040-live-query-and-orchestration.md)).

- **`@loom/live-query`: `subscribe` folds incrementally — O(N), not O(N²)**
  ([ADR 0040](docs/adr/0040-live-query-and-orchestration.md) Amendment). The 2026-09-27 audit
  confirmed `subscribe` re-folded from genesis (`reader.loadState`) on every wake-up — exactly
  the O(N) rows/event, O(N²)/lifetime cost `WorkflowRuntime.foldState`'s own docstring names
  (measured: N²/2 rows folded, 10.6s at N=4,000 on SQLite). `subscribe` now calls
  `reader.loadState` exactly once per subscription and folds every later delta
  (`eventStore.readFrom(id, tip + 1)`) onto the kept state with `@loom/replay-vm`'s
  `foldEvents` — no new fold, no new version (`fold(snapshot, suffix) === fold(events)`, already
  load-bearing for snapshots/compaction). Also fixes a doc bug the same audit found:
  `createLlmEffect.ts` and `chunkDeltas.ts` named live-query a "natural"/"purely transient" sink
  for streamed deltas, but live-query has no delta-push API (`snapshot` + `subscribe` over
  DURABLE events) — both now name `progressHub` (or the app's own `onDelta` handler). New
  dependency: `@loom/replay-vm`. No kernel change; EVENT_SCHEMA and KERNEL_ABI unchanged.

- **`@loom/plugin-sandbox`: a script's own exception is a typed `scriptError` channel**
  ([ADR 0064](docs/adr/0064-sandbox-eval-plugin.md) D3, amended). `SANDBOX_ERRORS` gains
  `scriptError { name?: string; message: string }` — whatever the script threw on this input,
  including a non-Error value (`throw 42` → `{ message: "42" }`), a SyntaxError in its source,
  and a ReferenceError for `fetch`/`require`/`process` (previously deliberately untyped: the VM
  cannot tell a missing capability from a typo). `name` is kept only when it is a string
  (≤ 128 chars), `message` is bounded at 2048, and no stack is ever carried. Callers can now tell
  "the script threw" from an infrastructure failure without parsing error text: a closed or
  failed worker pool, a script whose bytes do not match their content address, input
  marshalling and cancellation all stay untyped, and a guard kill stays `limitExceeded` even
  when the script catches it and rethrows. Being declared, it is recorded as
  `STEP_FAILED { channel, payload }`, substituted on replay and not retried (ADR 0060). The error
  message keeps the old `sandbox script failed: Name: message` text. Additive for replay: an old
  log's untyped STEP_FAILED has no channel, is never substituted as `scriptError`, and keeps
  legacy re-execution. `docs/api-reference.org` had the channel map wrong
  (`limitExceeded`/`badShape`) and stale `sandboxEval$`/`registerSandboxEval` signatures; both
  are fixed. No kernel change; EVENT_SCHEMA and KERNEL_ABI unchanged.

  Also: memory/CPU kills are read from the text of the engine's own `InternalError` only — a
  script's `throw new Error("connection interrupted")` (or "…out of memory…") was previously
  reported as `limitExceeded` and is now `scriptError`. Script-authored text is bounded without
  splitting a surrogate pair, and lone surrogates and NUL become U+FFFD, so the failure event is
  storable in Postgres `jsonb`. The text is untrusted and not taint-wrapped: never put it in a
  prompt's instruction position.

  **Upgrade note:** a run that is paused or suspended past an untyped failed sandbox step (a
  flow that caught the old `Error("sandbox script failed: …")`) re-runs that step when resumed
  on this version — untyped failures were never substituted — and the re-run now throws a
  `TypedFailure` on `scriptError`. A catch that tests `instanceof TypedFailure` or the channel
  takes that branch on the re-run; the recorded events are untouched.

- **Blueprint IR 2.4.0 (ADR 0101).** A minor bump so a container keeps its identity when a
  recompose inserts or reorders containers around it:

  - `GridLayout`, `FlexLayout` and `StackLayout` gain an optional `id` — the same rule as
    `Widget.id` (a non-empty string, no charset, no length cap; `isLayoutId` is the one spelling
    of it). `grid`/`flex`/`stack` accept it
    and omit the key when absent, so an unid'd layout's bytes and content address are 2.3.0's; a
    present id enters the address.
  - Widget ids and layout ids are one namespace: `duplicate-node-id` now also fires for
    widget↔layout and layout↔layout collisions. `validateBlueprint` gains `layout-id-invalid` — a
    `warn` for a present id that is not a non-empty string, which every reader then treats as
    absent. Layout-level findings name the layout by its id when it has a valid one.
  - New `blueprintLayoutIds`; `preservesBlueprintNodes` compares widget ids AND layout ids, so a
    re-identified container is a `dropped-node-id` finding. `blueprintNodeIds` stays widget-only.
  - `@loom/plugin-renderer-react` keys a container by its id, fixing the index keys nested
    containers got: inserting a container mid-list no longer re-creates the widgets of the
    containers after it (typed input and focus survive). Grid cell keys are prefixed (`k:` keyed,
    `i:` by index) so an id like `"1"` cannot collide with an index key. The DOM is unchanged.
    `@loom/plugin-renderer-terminal` ignores the id; its output is byte-identical.
  - `BLUEPRINT_IR_VERSION` moves `2.3.0` → `2.4.0` with a sixth pinned digest; 2.3.0 (like 2.0.0
    to 2.2.0) is read as it is by `validateBlueprint` and `upgradeBlueprint`.

- **Blueprint IR 2.3.0 (ADR 0100).** A minor bump so a bound widget whose upstream answered with
  nothing can say "no data" instead of failing:

  - `BindingState` gains `"empty"` — delivery succeeded and there is no subject to show. It
    travels the existing status channel (`binding.status.path`); `isBindingStatus` admits it
    under the same rules as the other four states. Not an error; it triggers nothing.
  - The canonical matrix gains an `empty` row right after `error` and before the `check` slot
    (there is no value to check). A producer must clear the bound value when it publishes `empty`;
    a reader ignores one if it is there.
    `@loom/plugin-renderer-react` renders `data-binding-state="empty"` with a `role="status"`
    marker `○ <title>: no data` (or the finding's message); `@loom/plugin-renderer-terminal`
    prints the same row. A pre-2.3.0 reader sees `empty` as a malformed status and falls back to
    its loading/ready row, never its error row.
  - `BLUEPRINT_IR_VERSION` moves `2.2.0` → `2.3.0` with a fifth pinned digest; 2.2.0 (like 2.0.0
    and 2.1.0) is read as it is by `validateBlueprint` and `upgradeBlueprint`. No new finding: a
    status is runtime projection data, never part of the artifact.

- **Blueprint IR 2.2.0 (ADR 0099).** A minor bump so a container can ask for a renderer of its
  own, the way a widget does through `kind`:

  - `GridLayout`, `FlexLayout` and `StackLayout` gain an optional `role` — the open,
    app-defined container axis (`"stepped"`, `"tabbed"`, …); `type` stays the geometry.
    `grid`/`flex`/`stack` accept it and omit the key when absent. Never an ARIA role, never
    display text.
  - `isLayoutRole` is the one spelling of a well-formed role (`/^[a-z][a-z0-9-]{0,63}$/`);
    absent, malformed or unknown ⇒ the plain container. A renderer that keys containers keys
    them by ordinal + `type` + `role`, so a role change is a remount.
  - `BLUEPRINT_IR_VERSION` moves `2.1.0` → `2.2.0` with a fourth pinned digest; 2.1.0 (like
    2.0.0) is read as it is by `validateBlueprint` and `upgradeBlueprint`.
  - `validateBlueprint` gains `role-invalid` — a `warn`, once per layout whose `role` is present
    but not `isLayoutRole`. A well-formed role no renderer knows is not a finding.
  - `@loom/plugin-renderer-react` and `@loom/plugin-renderer-terminal` ignore the role: a roled
    artifact renders exactly as the unroled one.

- **Blueprint IR 2.1.0 (ADR 0098).** A minor bump for genUI's migration onto loom-ui, which
  needs free placement and titled views:

  - `GridCell` gains optional `row`, `rowSpan` and `column` (1-based grid lines; `span` is still
    the width). All absent = flow placement, as before. `cell(span, node, { row, column,
    rowSpan })` states a placement.
  - `GridLayout`, `FlexLayout` and `StackLayout` gain an optional `title` (a section heading);
    `grid`/`flex`/`stack` accept it.
  - `BLUEPRINT_IR_VERSION` moves `2.0.0` → `2.1.0` with a third pinned digest. 2.0.0 artifacts
    are read as they are: `validateBlueprint` knows `2.0.0`, and `upgradeBlueprint` is identity
    on it, so no stored artifact is re-addressed.
  - `validateBlueprint` gains `placement-out-of-range` (one finding per cell; never a cascade
    from a bad `span` or `columns`).
  - `@loom/plugin-renderer-react` wraps a placed cell with explicit `grid-column`/`grid-row`
    and renders a titled layout as `<section><h2/>…</section>`; `@loom/plugin-renderer-terminal`
    prints placed cells in reading order and a titled layout under an underlined heading. An
    unplaced, untitled artifact renders exactly as it did under 2.0.0 on both.

- **Blueprint IR 2.0.0 (ADR 0097).** Three leaks loom-ui's adapters had been working around —
  never reaching loom's own renderers, or a third consumer — are now channels the IR itself
  carries:

  - `GridLayout.children` is now `GridCell[]` (`{ span?: number; node: Widget | Layout }`)
    instead of a bare `Array<Widget | Layout>`, so a grid child's column span is a fact of the
    IR rather than a `props.span` side channel one renderer honoured and the other silently
    dropped.
  - `DataBinding.status?: { path }` names where, in the *same* projection state as the bound
    value, that binding's delivery state (`BindingStatus`: `state: BindingState` —
    `"pending" | "ready" | "stale" | "error"` — plus optional `seq` and `finding`) lives. Both
    first-party renderers now show pending/stale/error from a declared channel.
  - `Widget.source?: WidgetSource` (`{ type, version, degradedFrom? }`) names what a widget
    actually stands for and the semantic types it was degraded through to reach its rendered
    `kind` — never smuggled through `props`.
  - `DataBinding.sensitivity?: DataClass` (from `@loom/classify`, type-only) declares a
    binding's confidentiality class on the artifact; this ships the field only, audience
    enforcement is a loom-ui concern.

  This is a **MAJOR** bump: `BLUEPRINT_IR_VERSION` moves `1.0.0` → `2.0.0`, with the `1.0.0`
  digest kept pinned beside the new `2.0.0` one ([ADR 0096](docs/adr/0096-blueprint-stable-rendering-ir.md)'s
  guard). Readers accept 1.0.0 transparently — `asCell` normalises a legacy bare grid child on
  every read path, and `upgradeBlueprint(bp)` re-addresses a whole 1.0.0 artifact to 2.0.0
  explicitly (identity on already-2.0.0 input) for a caller that wants to. Writers always emit
  2.0.0: `blueprint$` stamps `irVersion`, and `grid({ columns, children })` now accepts
  `Array<GridCell | Widget | Layout>` and normalises every element, so every existing
  `grid({ children: [...] })` call in this repo and its examples keeps compiling unchanged; a
  new `cell(span, node)` builder is how a caller states an explicit span.

  `validateBlueprint` gains seven new finding codes: `span-out-of-range`, `columns-invalid`,
  `malformed-node`, `status-path-invalid`, `sensitivity-unknown`, `source-invalid`,
  `ir-version-unknown` — all findings, never throws. `columns-invalid` (a grid's `columns` is
  not a positive integer) suppresses that grid's span check, so one bad `columns` yields one
  finding rather than one per child; `malformed-node` (a layout child that is neither a
  `Widget` nor a `Layout` — a stray `null`, a string, a `GridCell` outside a grid) makes the
  walk total, so a model-composed artifact can never make `validateBlueprint` throw.

  `@loom/plugin-renderer-react` gains `WidgetFrame` (applies the canonical binding-status
  matrix and `source` data attributes around a widget's rendered body — adds **no** wrapper
  element for a widget with neither a declared status channel nor a `source`, so a 1.0.0
  artifact's DOM is unchanged) and `useWidgetSlice` (a fiber selector over `{ value, status }`
  together). A grid child gains a wrapper element **only** when its span exceeds 1; span-1
  children, and therefore every 1.0.0 grid, are DOM-identical to 1.0.0 and still reconcile by
  widget id. `@loom/plugin-renderer-terminal`'s `TerminalWidgetRenderer` gains an optional
  third `status?: BindingStatus` parameter, and the terminal output gains status glyphs
  (`⋯` pending **and the loading row** — a declared channel with no value yet renders
  `⋯ <title>` rather than `<title>: —` — `~` stale, `✗` error) and a degraded-from suffix when
  a channel or `source` is declared — output for a widget with neither is byte-identical to
  before.

  Both renderers take an optional `check(widget, value)` (`TerminalRenderOptions.check`; the
  `check` prop on `BlueprintRenderer` and `WidgetFrame`): the value-contract slot the matrix
  leaves between `error` and `stale`. loom validates nothing about a bound value itself — a
  framework's own kind contract plugs in there, and a returned `{ code, message }` renders as
  the error row. It runs only for a widget that declares a status channel and only when
  delivery has not already failed.

  A widget with no declared status channel — the overwhelming majority of existing artifacts —
  renders exactly as it did under IR 1.0.0, on both renderers.

### Fixed

- **`docs/scaling.md` and ADR 0074 D4 corrected: bucketed NOTIFY fixes client-side delivery,
  not the writer-side cost; `tools/bench-throughput` section C is un-vacuated**
  ([ADR 0074](docs/adr/0074-storage-scale-out-decorators.md) Amendment). D4 claimed bucketed
  `LISTEN loom_events_<bucket>` "fixes an O(events × nodes) broadcast whose cost lands on the
  writer." It fixes client-side filtering and the follow-up per-notification `SELECT`; it does
  not fix the writer cost, which is per LISTENing backend and channel-independent — a listener
  that receives **zero** notifications (LISTENing on a channel nobody publishes to) costs the
  writer almost as much as one receiving every notification (measured 1.18×–1.73× vs.
  1.22×–1.90×, 4 runs, own local PG 17). The bug this corrects was caught because the bench
  that produced D4's original numbers had gone vacuous: `attachListeners` still LISTENed on the
  pre-bucketing legacy channel after `PostgresEventStore` moved to bucketed channels, so section
  C's listeners received nothing every run and printed "0 delivered … = 0 per event" beside a
  writer-throughput number that still dropped 2.28× in the same run — and `scaling.md` §3.1 read
  "**[open]** … nothing implements it yet" under a heading of SHIPPED. `attachListeners` now
  takes the real channel list off the writer's own store instance
  (`PostgresEventStore#notifyChannels()`, an instance method, not a free function taking
  `notifyBuckets` by hand — review round 1: a bench-side literal has no way to notice the
  instance's configured value change) and the bench fails outright (`VacuousDeliveryError` via
  `assertDelivered`) if any expected channel delivers nothing — a PER-CHANNEL check, not
  merely a nonzero total, so a partial coverage gap (half the expected buckets silently idle)
  cannot hide behind an aggregate that still reads nonzero. A negative case proves the guard
  does NOT fire on a legitimately-empty unrelated-channel row, and another proves it fires on
  partial coverage even when the aggregate total is nonzero.
  Scenario H gains a disjoint-interest variant (`partitionDisjoint`, confirming delivered
  notifications per node drop to exactly `1/nodeCount` while writer throughput does not track a
  clean prediction — plausibly single-host contention, not a fan-out win) and a
  `CoalescingEventStore` variant (measured 1.21×–1.54× recovery). **Recommend
  `CoalescingEventStore` for multi-node deployments with live subscribers**, and record a
  transport change (separate notifier connection, watermark polling, or a Redis/NATS bus as a
  3P plugin) as considered and rejected for now — `CoalescingEventStore`'s measured headroom is
  enough without it. No SPI change, no kernel change; `EVENT_STORE_SPI_VERSION` stays 1.4.0.

- **Kernel: a duplicate `start()` with a caller-chosen execution id is refused before any effect
  runs** ([ADR 0103](docs/adr/0103-durable-bootstrap-for-caller-chosen-ids.md); KERNEL_ABI and
  EVENT_SCHEMA unchanged). `start()` checked nothing: the bootstrap `EXECUTION_STARTED` was folded,
  delivered to `onEvent` and only enqueued, and the body ran at once, so a second start of the same
  deterministic id invoked its effects (a paid model call in the probe) before the store refused
  sequence 0. Now, when the caller supplies `executionId`, `start()` awaits the durable write of
  sequence 0 first — the same envelope, byte for byte, through a builder shared with the journal —
  and a sequence/id conflict — confirmed by reading this execution's sequence 0 back, because a
  coalesced batch hands every caller the same conflict error (an unconfirmed one is retried once)
  — throws the new `ExecutionAlreadyExistsError` with nothing folded, nothing delivered and
  nothing run. Any other failure of that write rejects `start()` with
  `StorageWriteError`. `TimerService` treats the typed error as "already started", which closes
  the cross-node race its `loadState` pre-check left open. There is no `startOnce` helper: catch
  the error. A minted ULID cannot collide, so `start()` without an `executionId` pays no extra
  write and behaves byte-identically. `onEvent` remains pre-durability for every later event, now
  documented; a consumer that must act only on durable facts uses a catch-up read.

  **Upgrade note:** code that started the same caller-chosen id twice and awaited the second
  handle now gets `ExecutionAlreadyExistsError` from `start()` itself. A test that relied on the
  duplicate "succeeding" was testing the defect.

- **The content sweep is race-safe, reclaims orphans, and takes external root sets; ContentStore
  SPI 1.3.0** ([ADR 0055](docs/adr/0055-k10-6-pin-seam-content-gc.md) D5–D7, amended).
  - **D5, the re-cite race.** A `put` of bytes the store already held was a no-op (`INSERT OR
    IGNORE`). A sweep that ran between a re-citing `put` and that execution's event append
    therefore erased the blob by its *old* citation time, and the new event cited a blob that
    was gone. SPI 1.3.0 adds an optional atomic `deleteIfUntouchedSince(ref, cutoffMs)` and
    `touchClock()`. A store implementing them MUST bump a blob's touch time, monotonically, on
    every `put`/`putStream`. The guard cutoff is on the STORE's clock: `touchedBefore`, which
    defaults to `touchClock() − olderThanMs` read at the sweep's start. The caller's `now` is
    log time and only measures the TTL, so a simulated or skewed log clock cannot disarm the
    guard. The sweep erases only through the conditional delete when the store has one.
    Otherwise it falls back to `delete` and reports `raceSafe: false`; `loom sweep content`
    prints `race-safe:`.
  - **D6, orphans.** Blobs nothing cited any more were never reclaimed: a run deleted with no
    archive, a crash between `put` and the append, a truncated prefix. SPI 1.3.0 adds an
    optional `listPage({ cursor, limit, touchedBefore })`, keyset on address, and a bad `limit`
    is a `RangeError`. With `reclaimOrphans: true` (CLI `--orphans`), the sweep erases
    conditionally every stored address untouched since the cutoff that no scanned event, no
    compaction snapshot and no root cites. A touch time of 0 (a pre-1.3.0 writer) is unknown
    and never erased. It refuses a store without the optionals. The report gains
    `orphansReclaimed`. `snapshotStores` lets the sweep read compaction checkpoints: refs in a
    compacted execution's compaction checkpoint (`loadLatestBefore(events[1].sequence − 1)`) and
    latest snapshot are pinned, so `fork()` from between them still resolves. The orphan pass
    refuses to run without them over a store that can `truncatePrefix`, and whenever an
    execution looks compacted (a gap, or only sequence 0 left) but no checkpoint is found. **The sweep cannot see a citing store you did not pass it**, so scan live first,
    then every archive. The CLI scans the config's `durability.retention.archive`, and refuses
    `--orphans --apply` with no archive unless `--no-archive` (warning before it erases).
    `--orphans` needs `--snap` on the `--db` path, and `--archive-snap` with `--archive-db`.
    Every `loom sweep content` refusal exits non-zero.
  - **D7, roots.** `sweepUnpinnedContent({ roots: () => AsyncIterable<string> })` pins
    addresses held in an app's own tables through both passes.
  - `SqliteContentStore` implements all three optionals. On open it migrates an older file: it adds
    `touched_at` and backfills existing blobs to the migration time once, so nothing ages out
    until a full TTL after the upgrade. The re-put bump is monotonic
    (`max(touched_at, excluded.touched_at)`). `InMemoryContentStore` implements all three with an
    injectable clock (`new InMemoryContentStore({ now })`), and so does `SqliteContentStore`
    (`new SqliteContentStore(path, { now })`). `CachingContentStore` forwards all three. The
    conformance kit checks the optionals when present. The three must come as a set, and the
    re-put bump is checked through the conditional delete alone (an internal kit check that
    fails an `INSERT OR IGNORE` store). Monotonicity is checked with a clocked factory.
    `LogLifecycle` exposes its configured `archive` (read-only). The kernel manifest and the
    compatibility matrix now list ContentStore SPI 1.3.0, and `checkCompatibility` accepts
    `contentStoreSpi`. The `loom plugin new content` template names the new methods.
  - `docs/data-protection-patterns.md` says the archive is REQUIRED once retention archives,
    and scopes "erasable without history rewrite" to the log. Content-store blobs have no
    subject mapping; erase them with an explicit `contentStore.delete(ref)`.
    `docs/api-reference.org` had the wrong signatures for `collectContentRefs` and
    `pinByEventKinds`; both are fixed.

  **Behaviour change:** a test fixture that puts a blob at today's wall clock and then cites it
  at a fabricated past time now sees the blob kept, because it was touched after the cutoff.
  Give such a store a clock that matches the fabricated history. Likewise, a harness that runs
  the log on a simulated clock must give the content store that clock or pass `touchedBefore`.
  Otherwise nothing it "aged" is erased, because the guard is on the store's clock.

- **The content sweep no longer erases a load-bearing externalized ref**
  ([ADR 0055](docs/adr/0055-k10-6-pin-seam-content-gc.md) D4, amended). `sweepUnpinnedContent`
  treated every `__loomContent` ref as TTL-reclaimable unless a pinned event kind cited it. An
  ADR 0046 externalized field is a bare ref that `ContentResolvingEventStore.read` resolves, so
  `loom sweep content --ttl 30d --apply` over a 60-day-old externalized `STEP_COMPLETED.output`
  erased the blob, and the next read of that still-running execution threw
  `ContentMissingError`. Resume, replay, fork and compliance export all failed. Now only a ref
  that is an envelope's own `ref` ages out. A ref cited anywhere else, including inside an
  envelope's `digest`, is kept while any scanned event cites it, and so is a ref cited both
  ways. An envelope is recognised by the same structural test as `isClaimCheck`, so an app
  object that only carries `__loomClaimCheck: true` does not make its refs reclaimable.
  `ContentSweepReport` gains `refsLoadBearing`, and `loom sweep content` prints it.

  **Behaviour change:** an app that emits a bare ref itself (`ctx.emit(KIND, { ref })`) and
  relied on the sweep to reclaim it will find the blob kept. The sweep cannot tell such a ref
  from an externalized one. To make it reclaimable, cite it as a claim-check envelope's `ref`.
  Nothing is erased that was kept before. This also works under a `ContentResolvingEventStore`,
  which now leaves claim-check envelopes alone (the ADR 0055 D4 gap, closed by the decorator
  entry below).

- **Every store decorator now carries the whole optional SPI through, so the ADR 0074
  composition actually batches**
  ([ADR 0074](docs/adr/0074-storage-scale-out-decorators.md) Amendment,
  [ADR 0022](docs/adr/0022-k10-log-lifecycle-retention-redaction-encryption.md) Amendment).
  Seven decorators silently dropped optional methods of the store they wrapped:
  - `TenantScopedEventStore` dropped `appendBatch` and `listExecutionsPage`.
  - `EncryptingEventStore` dropped `appendBatch`, `deleteExecution`, `truncatePrefix` and
    `listExecutionsPage`.
  - `ContentResolvingEventStore` dropped `appendBatch` and `listExecutionsPage`.
  - `hashChainedEventStore` dropped `appendBatch`, `listExecutions` and `listExecutionsPage`.
  - The DST `faultInjectingStore` and the `@loom/testing` `crashingEventStore` dropped up to
    seven methods between them.
  - `EncryptingSnapshotStore` dropped `deleteExecution`.

  The consequences:
  - `Coalescing(TenantScoped(backend))`, the order ADR 0074 documents, issued zero batches (50
    appends reached the backend as 50 appends).
  - Over that fallback's non-atomic loop, a batch holding a stale-fence zombie left earlier
    writers' events durable while telling them the write failed.
  - Encrypted logs could be neither retained nor compacted.
  - The audit chain could not be enumerated by `loom retention` or `loom census`.

  Each decorator now declares a `DecoratorPlan` over the whole optional-method union and
  installs it with the new `installOptional` (`@loom/event-runtime`). Every plan key is
  required, so a plan that omits a method, including a future optional SPI method, fails to
  compile (pinned by a `@ts-expect-error` that `pnpm typecheck` checks). The conformance kit
  catches a decorator that uses no plan at all.
  `OPTIONAL_EVENT_STORE_METHODS` / `OPTIONAL_SNAPSHOT_STORE_METHODS` are compile-time
  exhaustive, `refusalsOf` reads a recorded refusal, and `CoalescingEventStore`,
  `ProfilingEventStore` and `TenantScopedSnapshotStore` moved onto plans too.
  `runEventStoreDecoratorConformance` / `runSnapshotStoreDecoratorConformance`
  (`@loom/conformance`) wrap a full-capability store. They assert that every optional method
  survives (or is refused with a reason) and then run the whole SPI suite THROUGH the
  decorator, over the in-memory store by default or a real backend via `inner`. Every in-repo
  decorator is registered, the two tenant compositions also run over Postgres, and
  `packages/spec/src/decoratorConformance.test.ts` discovers decorators and fails on one that
  is not registered. `EVENT_STORE_SPI_VERSION` stays 1.4.0; the SPI history comment now
  records 1.4.0 (`head`).

  Behaviour changes to know about:
  - **`hashChainedEventStore` no longer offers `truncatePrefix`.** It used to forward it, and a
    compacted chain fails `verifyChain` at the first surviving event (measured). Compaction
    over an audit-chained store now returns `null` instead of silently breaking every later
    audit.
  - **`LogLifecycle` enforces a key rule for encrypted logs.** `compact` throws the new
    `UnsafeCompactionError` when the event store encrypts at rest and the snapshot store does
    not share its `KeyStore`. `applyRetention` / `evaluate` return the new `RetentionOutcome`
    `"unsafe-archive"` when an archive does not share it. Without the rule, compaction and
    archiving would write the decrypted fold or events outside the erasure boundary, where a
    key shred no longer reaches. A test shreds the subject after compacting and archiving an
    encrypting store over SQLite and asserts that both copies are unreadable.
  - **The encryption marker (`keys`) now survives decoration**: `installOptional` carries it up,
    and `ShardedEventStore` exposes one shared KeyStore (or a fail-closed marker if its shards
    disagree). So `loom doctor` and the key rule see `Coalescing(Encrypting(pg))` as encrypting.
  - **A compacted execution is reclaimable.** `LogLifecycle.evaluate` folded only the surviving
    log, so an execution compacted through its tip read as `not-terminal` forever. It now folds
    from the latest snapshot when the log has a gap or only its bootstrap left.
  - **Tightening: `TenantScopedEventStore` and `TenantScopedSnapshotStore` reject a tenant
    name that is empty or contains the `:` separator** (a `TypeError` at construction).
    Tenant `"a"` scoped `"b:x"` to `"a:b:x"`, which is tenant `"a:b"`'s `"x"`, so one tenant
    could address another's executions. No in-repo or sibling-repo caller passes such a name.
  - **`ShardedEventStore` declares a plan too**, and is registered with the kit as
    `new ShardedEventStore([inner])`. The fitness test now also discovers decorators whose
    constructor takes an array of stores. The `listExecutionsPage` contract now says, and the
    kit checks, that a page with a `nextCursor` carries at least one id.
  - **`TenantScopedEventStore.listExecutionsPage` never relies on the store's sort order.** It
    pages the inner store and filters, bounded to one page of memory. Postgres pages in the
    database collation (measured: `"a~"` before `"ab"` on an `en_US.UTF-8` PG 17), so a
    "stop at the first id past the tenant's range" shortcut would miss ids.
  - **`ContentResolvingEventStore` leaves ADR 0054 claim-check envelopes alone.** The
    `collectContentRefs` / `substituteContentRefs` / `hasContentRef` walkers treat an envelope
    as a leaf, so an envelope whose blob the sweep reclaimed reads back as the envelope rather
    than throwing `ContentMissingError`, and a `codec: "bytes"` envelope reads at all. A bare
    ref beside it still resolves. This closes the known gap ADR 0055 D4 records. The stale
    "refcounted blob GC … deferred" docstring (it shipped in ADR 0055) is corrected.
  - `CoalescingEventStore`'s docstring no longer claims a failed flush leaves the log untouched
    over any inner store: that holds only when the inner store implements `appendBatch`. It
    also records the coalesced-zombie blast radius.

- **Kernel: flow-level `ctx.emit` / `ctx.stream` / `ctx.ui` append once per execution**
  ([ADR 0102](docs/adr/0102-flow-emits-append-once.md), EVENT_SCHEMA **1.19.0**, KERNEL_ABI
  unchanged at 1.1.0). A flow re-runs from the top on resume and on recovery. `execute`,
  `decide` and `suspend` were served from the log on that re-run; a flow-level emit was not. It was
  appended again every time, so an `emit` before a gate appeared N times after N resumes, and a
  surface built with `ctx.ui.append` before a gate folded to `["x","x"]`.

  Now an emit is served from the log only when the log PROVES it was already made. That means
  a stamped emit of the same `(type, payload)` in the same gate segment that this run has not
  yet matched, with every step and decision so far in the segment itself served from the log.
  Everything else is appended.
  - Stamps: `metadata.flowEmit = <digest of segment, type, payload>`; the fold counts them per
    digest in `variables._flowEmits`.
  - An emit is stamped only if nothing earlier in the run ended unsettled (an untyped failure, a
    timeout, a cancellation, an in-doubt park, a throwing decider) and none of the run's own
    steps or deciders was still executing.
  - Timing can cost a duplicate, never an emit: a different interleaving can turn a served emit
    into an unstamped append, never into a lost one.
  - Kernel facts (`STEP_*`, `DECISION_RECORDED`, `EFFECT_INDOUBT`) and `EffectContext.emit` are
    unchanged and never stamped.

  **Upgrade note:** an execution written before 1.19.0 re-emits its pre-resume emits **once
  more** on its next resume or recovery. No migration is needed. A test or projection that
  counted the duplicates was counting the bug.

  Duplicates remain possible in these cases; none of them loses an emit:
  - Emits after a step that fails untyped: it re-executes on every re-run, so they are appended
    again each time. Declare its failure channel (ADR 0060) and they converge.
  - An emit made while one of the run's own steps is still un-awaited: one extra copy.
  - A payload with no JSON form: appended on every re-run.
  - A deploy that edits an emit: the new content is appended and the old stays.

  An emit can be served in place of a new one only if a deploy moves identical content within a
  segment whose steps are all served, if flow code breaks ADR 0061 determinism, or on a 64-bit
  hash collision (ADR 0102 D2).

  Also: `fnv1a64` (`@loom/core`) now uses 16-bit limb arithmetic instead of BigInt. The output
  is identical, pinned by a differential test, and the cost per byte is roughly a tenth.

- **`loom plugin new keystore` scaffolded a package that could not compile.** The template
  writes `Buffer` in four signatures and the generated `package.json` declared no
  `@types/node`, so the first thing a plugin author did after scaffolding was watch `tsc`
  fail. The template typecheck added yesterday hid it by handing the compiler node's types —
  which the real package never declares. A scaffolded package's dependencies are now derived
  from the code it emits, and a guard asserts that any template using a node global ships the
  types for it.

  The detector strips comments first, and that is the point of its own unit test: two seams
  describe "the process" in prose, and matching those would have added a dependency their code
  never touches. A sweep that reads comments is measuring prose.

- **An encrypting store with in-memory keys now FAILS `loom doctor`.** K10 crypto-shredding
  makes the key the erasure boundary, so losing a key is indistinguishable from shredding the
  subject: the writes succeed, the log survives, and every encrypted field is unreadable from
  the next boot — with nothing failing at the moment it happens. `KeyStore` had exactly one
  implementation, `InMemoryKeyStore`, and the only protection was a README sentence saying
  "back it with a KMS in production".

  `KeyStore` now declares `durable`, `InMemoryKeyStore` declares `false`, and the new
  `encryption keys` check reads it through whichever store exposes a `keys` property — so a
  third party's own encrypting wrapper is covered for free, and the CLI still depends on no
  crypto package. Three states, kept apart: declared non-durable **fails**, undeclared is an
  **advisory** (*this store does not say*), declared durable passes, and nothing encrypting at
  all is a skip. Snapshots are checked alongside the event log, since they carry the same
  fields.

- **A globally installed `loom` did nothing and exited 0.** The entry guard was
  `process.argv[1]?.endsWith("cli.js")`, but a global install puts a SYMLINK named `loom` on
  PATH — so `argv[1]` is `…/bin/loom`, the guard was false, and the binary returned success
  having run no command. `pnpm link --global` hid it by writing a shim that execs `cli.js` by
  name; `npm i -g` creates a plain symlink, which is what a published package gets. Now
  `require.main === module`. `create-loom-app` had the same guard and the same silence.

- **`create-loom-app --help` scaffolded eleven files into a directory named `--help`**, and
  reported success — the only check on the argument was that it existed. `loom-compile --help`
  crashed with an ENOENT naming a path the user never typed. Both now validate their
  arguments and print usage. These were newly *reachable*: before the guard fix, neither ran
  at all through a global install.

- **`pnpm run unlink:global` failed with `ERR_PNPM_UNEXPECTED_STORE`.** The repo pins
  `pnpm@9.14.4` via `packageManager`, so a machine running pnpm 10 self-downgrades inside the
  repo — and 9.x refuses to touch a global directory 10.x created. The global store's format
  is tied to pnpm's major version, so any script touching it is coupled to whichever pnpm
  created it. Both scripts now use `npm link`, whose global has no such versioning.

### Added

- **The Blueprint is a declared rendering IR (ADR 0096).** `@loom/blueprint-runtime` exports
  `BLUEPRINT_IR_VERSION` (`1.0.0`) beside a shape manifest that `tsc` checks exhaustively against
  the `Widget`/`Layout`/`Blueprint` types and that a test pins by digest per version — so a shape
  change fails the build until the manifest agrees, and the manifest cannot change without the
  version. Needed because a sibling framework ([loom-ui](docs/requirements/2026-09-21-loom-ui-design.md))
  now compiles to the Blueprint, and a compile target in another repository is an interface.

  `@loom/plugin-renderer-terminal` is kind-aware when given a registry: `defaultTerminalRegistry`
  covers the eight built-in kinds (asserted with `catalogCoverage`, ADR 0088's second direction,
  which the terminal surface never had), and a kind the registry lacks is marked `[kind]` instead
  of flattened silently. With no registry the output is byte-identical to before.

- **Two printable reference cards: [`docs/cheatsheet-features.md`](docs/cheatsheet-features.md)
  and [`docs/cheatsheet-dx.md`](docs/cheatsheet-dx.md).** Card I is what the kernel gives you
  — the ten syscalls, the builders, the three authority rings, the subsystems on the log.
  Card II is how you work — the CLI, `<store>`, doctor's four marks, the operator passes,
  testing helpers, plugin seams, and the handful of things that reliably bite. Laid out to be
  read on screen or printed (A4, two columns, every block kept whole).

  Both are derived from the kernel manifest, the CLI usage text and the SPI map rather than
  from memory, and a fitness test keeps them that way: every syscall must appear on Card I,
  every seam and CLI command on Card II, and the version and count headlines must match their
  sources. A cheatsheet is the densest enumeration a repo has and nothing about it fails when
  a name changes — which is exactly how three other seam lists here went stale.

- **Three seams that were never in the SPI map at all: `execution-authorizer`,
  `resume-authenticator`, `timer-dispatcher`.** Each is a `defineConfig` option whose type is
  an interface an application implements — replaceable by construction, which is what the map
  says it enumerates — with no row, no conformance kit and no scaffold. They sat in the blind
  spot the other two guards share: both start from a conformance kit, so a seam nobody wrote a
  kit for was invisible to both. A third guard now starts from the config instead — **every
  `defineConfig` option typed as an interface must appear in the SPI map** — and it found the
  third one (`ResumeAuthenticator`) on its first run, along with three data shapes now
  exempted with stated reasons.

  The two new kits' types are declared structurally in `@loom/conformance`, because importing
  them would close a cycle (workflow-runtime dev-depends on plugin-sqlite, which depends on
  conformance). Duplication drifts, so `@loom/worker-runtime-local` — the one package that
  sees both — carries a two-way compile-time proof that the kits still describe the real SPIs;
  adding a method to either interface fails that build. The proof earned itself immediately:
  the first draft of the resume kit declared the verdict as `{ ok: boolean }`, while the real
  `ResumeVerdict` is a three-way union whose third status (`not-applicable`) means *not mine
  to judge* and lets the resume PROCEED. Shipped as drafted, it would have certified a
  contract loom does not have.

- **The seam enumerations are guarded everywhere they appear.** `docs/usage-cli.md` listed
  eleven seams and showed a stale `loom plugin seams` sample; the existing guard covered only
  `docs/plugins.md`, so one enumeration was checked and the other drifted. Both are checked
  now. ADR 0033's hard-coded six-seam list is replaced by the invariant (it was missing five),
  and the SPI map — the doc an implementer opens first — finally says how to *start*.

  Also: a seam's `wiring` line is now checked to name a real `defineConfig` option.
  `durable-state` shipped with `durableState: { store }`, a key invented by analogy with
  `timers: { store }` that does not exist; the real entry point is
  `durableState({ id, version, schema, store })`. The wiring line is the first thing an author
  copies, so a fabricated one sends them to a compile error with loom's name on it.

- **Four more seams: `content`, `durable-state`, `read-model`, `keystore`.** With `lease`
  that closes every SPI loom publishes a conformance kit for — and a kit is loom saying
  "third parties implement this", so an SPI with one and no scaffold was advertising with no
  door. A fitness test now asserts exactly that: **every kitted SPI is scaffoldable**, which
  generalises past any hand-maintained list. Each template documents the property its backend
  is silently wrong about otherwise — content addressing making `put` idempotent, compare-and-set
  on `expectedRevision`, watermark monotonicity under re-apply, and `destroy` being
  irreversible because the key IS the erasure boundary.

- **`loom plugin new lease <name>` — a `LeaseStore` seam.** The interface, the conformance
  kit (`runLeaseStoreConformance`), the SPI-map row and the composition wiring
  (`timers.leases`) all existed; the scaffold did not, so loom advertised a seam a third
  party could not start from. The template documents the three return values that carry the
  whole contract — `acquire` returning `null` for another owner (re-acquiring your own is a
  renewal, not a conflict), `renew` returning `false` meaning ownership is LOST and never
  resurrected, and `expired` as the evidence of an orphan.

- **The seam/doc fitness function now runs both ways.** It checked scaffold → docs only, so
  an SPI could ship an interface, a conformance kit and a map row with no `loom plugin new`
  template and nothing would notice — which is exactly how `LeaseStore` sat. Published SPIs
  must now be scaffoldable or carry a stated reason, and a reason that goes stale (the SPI
  became scaffoldable) fails too. A one-directional fitness function is the failure it exists
  to prevent, pointed the other way.

- **Seam templates are typechecked against the real SPIs, and one was already broken.** The
  scaffold is a generator: when an SPI gains a method, every existing plugin fails loudly
  while the template keeps emitting the old shape silently. The new check found
  `loom plugin new projection` emitting a class missing `subscribeSelector`, added to
  `ProjectionRuntime` by ADR 0068 — so that seam had been scaffolding code that does not
  compile ever since. Fixed, and now guarded for all twelve seams.

- **Verification reports its own coverage (V1–V5).** `suspension-safety`, `capability-compat`
  and `effect-class` see past a flow's declared steps only with the compiler's runner-body
  analysis (ADR 0086) — and without it they reported exactly as they do with it. `loom verify`
  printed the same `0 error(s), 0 warning(s)` whether the rules read the runner bodies or
  never saw them. `reachAnalyzed` existed to tell those apart and no rule read it.

  Each of the three now emits one `info` coverage note per rule (not per flow — the same fact
  twenty times is noise), the headline counts them (`8 rule(s) passed — 0 error(s), 0
  warning(s), 1 coverage note(s)`), the CLI says when no analysis was injected, and
  `loom doctor` surfaces it as an advisory instead of flattening the report to "0 errors".

  `info` deliberately: the compiler is opt-in, so `warn` would scold every correct project
  that does not use it, and a verifier people switch off checks nothing at all.

  A fitness test now runs the same app with and without reach data and requires that **any**
  rule whose real findings change also reports that it could not look — so the next rule added
  cannot silently reintroduce the gap. It guards itself against passing vacuously.

- **`loom doctor` gains two timer checks, and a fourth status to report them honestly.**
  `durable timers` fails when schedules are declared with no `timers: { store }` (they can
  never fire) and advises when flows declare resume gates but nothing can wake them.
  `timer wake ownership` advises when a TimerStore has no `timers.leases`: if more than one
  process polls it, every node resumes the same due execution — fencing makes that safe, not
  cheap, since the loser still pays for its effects up to the point it loses.

  Both are `advisory` (`!`), a new status, because they are defects on a multi-node
  deployment and fine on one — and `doctor` cannot see how many nodes you run. Failing the
  build would be a guess; staying silent would be the same "unchecked reads as checked"
  failure a skip avoids. Advisories are counted in the summary, and now so are caveats on a
  FAILED run, where they were previously dropped.

  The `durable timers` advisory also names what verification does *not* cover: a `timeout`
  lives in the runner body, so `suspension-safety`'s timed-suspend rule cannot see it either
  (`FlowSpec.suspends` has no producer) and a clean `loom verify` says nothing about it.

- **`loom doctor` and `loom verify` no longer fail on an ESM config module, and `doctor` no
  longer starts the app it inspects.** Both used a bare `require`, so a config with top-level
  await produced two spurious ✗ — and `doctor` composing an app meant starting its timer
  service, the same side-effect-of-being-inspected the other commands were fixed for. Both
  now use the shared loader, which sets `LOOM_NO_AUTOSTART` first; `doctor` loads the app
  once per run and hands the same result to every check that needs it.

- **`loom recover` / `loom branches retire` / `loom branches prune` — front doors for the
  three maintenance passes.** Recovering executions whose supervisor died, retiring branches
  nobody is coming back to, and pruning refs that name nothing all shipped as library
  functions a scheduled job had to be written by hand to call. All three are **dry by
  default** and act only under `--apply`.

  Each one turns on a judgement loom will not make for you, so each refuses rather than
  guesses: `recover` needs either `timers.leases` (an expired lease is evidence) or an
  explicit `--stale`, and says *why* no default is defensible; `branches retire` needs
  `--stale` because a branch parked on a human gate is someone's open question. `recover
  --apply` additionally requires `--config`, because re-driving an execution runs its steps
  and only a composition has the flows registered — the `--db` shorthand can preview, and the
  message says so instead of only refusing.

- **`dryRun` + `onCandidate` on `recoverAbandoned`, `retireAbandonedBranches` and
  `pruneBranchRefs`.** The preview runs through the pass rather than beside it, because
  `loom retention` shipped the other arrangement once: a dry run computed alongside the real
  pass skipped a guard the pass applied, and promised an outcome the run would not deliver.
  A preview claims no lease (claiming is a write, and would fence the real pass out of the
  execution it was about to take), deletes no ref, and leaves `deleted`/`recovered` at zero —
  a count of writes that never happened is the same lie in a different place.

- **Every storage-backed `loom` command takes `--config <module>`.** `census`, `retention`,
  `logs`, `debug`, `inspect`/`dev`, `profile`, `introspect`, `optimize`, `learn report|eval`,
  `compliance report` and `sweep content` resolve their stores from the app's composition, so
  they run on whatever it wired — SQLite, Postgres, or any conforming backend. Before this,
  ten CLI files constructed `SqliteEventStore` directly and the CLI had no Postgres dependency
  at all: the entire operator surface ran only on the single-node backend, while the features
  it serves (leases, placement, the live-descendant guard) exist *because* a deployment has
  more than one node. `--db` remains, as the SQLite shorthand it always was.

  Sniffing `postgres://` was considered and rejected: it would bless two backends in a
  framework whose premise is that storage is yours, leaving every 3P store unreachable. The
  resolver therefore knows *no* backends — a fitness test now keeps it that way, with an
  allowlist that states its reasons.

  Messages name which half to fix: missing lease coverage reads *"this app wires no lease
  store (`timers.leases`)"* on the config path and *"no --leases given"* on the shorthand. A
  capability a store lacks is named with the store, not raised as a stack trace.

- **`defineConfig({ autostart: false })` + `app.start()` — composing an app need not also run
  it.** Composition has always called `timerService.start()`, so a command that reads a
  deployment's stores by importing its config module would begin polling production storage and
  fire whatever was due — a side effect of being *inspected*, happening during `import`, before
  any of that command's own code runs. The flag builds without starting; `app.start()` is the
  other half, so "build now, run later" never means "built, and can never run". Default
  unchanged, and `start()` is idempotent.

- **`timers.leases` — the lease seam `defineConfig` never had.** `TimerService` has accepted a
  `LeaseStore` since #380 (claim before waking, renew while the wake is in flight), but
  `defineConfig` builds that service itself and forwarded every option except this one. Nothing
  in the repository wired `leases:` outside tests, so the leased-wake path had **no reachable
  entry point** from loom's own front door — while `docs/user-guide.md` taught the staleness
  predicate and then advised preferring "a real liveness signal". A lease *is* that signal; the
  guide now shows it.

- **`LoomStores.timerStore` / `LoomStores.leaseStore`.** Present only when configured, on the
  same contract as `memoryStore`: absent means *not wired*, which an operator pass must be able
  to see rather than infer. "Nobody is tracking ownership" and "every lease is expired" are
  different answers — the first is a coverage gap, the second is a fleet that died.

- **`loom census` — the operator half of the same thing.** A number that requires writing
  TypeScript against your own composition root is a number nobody looks at, so the census now
  has a front door: `loom census --db <path> [--leases <path>] [--buckets 5m,1h,6h,24h]`, which
  writes nothing and takes no predicate. It prints in-flight counts by age band and, with a
  lease store, the `held / expired / no lease at all` split that decides #408. Without
  `--leases` it says the coverage was **not asked** rather than printing zeros. Consecutive
  identical band breakdowns are collapsed — bands are cumulative, so repeating them turns a
  four-line answer into a wall, and a report nobody scans is a report nobody reads.

  `orphanCensus` now takes a `CensusStateReader` (`{ loadState }`) rather than a whole
  `WorkflowRuntime` — the same narrowing `@loom/live-query` uses, so asking a read-only question
  does not require a deployment's full wiring.

- **`orphanCensus` — the read-only pass that was missing (#408).** Every other maintenance pass
  reads state in order to *act*: `recoverAbandoned` resumes what a predicate claims,
  `retireAbandonedBranches` cancels, `pruneBranchRefs` deletes. Nothing just looked — which is
  why "defer until a deployment reports orphans the staleness predicate misses" was never a real
  condition: a false negative sits `running` forever, silently, and nobody files an issue about
  work that quietly never finished.

  The census takes **no predicate** — that is the point, since the question it answers is whether
  yours is right — and writes nothing. It bands in-flight executions by age (cumulative, with a
  sample of ids so a report points somewhere) and, given a lease store, classifies each as
  `held` / `expired` / `none`. `none` is the number [#408](https://github.com/chhetrisushil/loom/issues/408)
  turns on: a stuck execution nothing ever leased cannot be recovered from evidence at all, and
  counting those is how "should the runtime lease every run" stops being a guess. Lease counts are
  **omitted** rather than zeroed when no store is given, because zeros would read as "nothing is
  unwatched" instead of "not asked".

  `LeaseStore` gains an optional `get` (SPI 1.1.0) for exactly that classification: `expired()`
  cannot tell an actively-renewed lease from one that never existed.

- **Durable leases: only one node pays for a duplicated wake (#380, L1–L2).** `TimerStore.due()`
  has no claim, so two nodes polling the same store both receive the same due timer, both
  resume, and both pay for every effect until one loses at the fence. Fencing (K9.4) makes that
  outcome *safe*, not *cheap* — and durable placement (#392) made the duplicate expensive on
  purpose, since a branch is placed precisely when its work is heavy.

  New optional `LeaseStore` SPI (`acquire` / `renew` / `expired` / `release`), shaped like
  `TimerStore`: `acquire` returns `null` when another owner holds an unexpired lease — that
  single `null` is the mutual exclusion "only one node should run this execution" needs — and
  `renew` returns `false` once ownership is lost, so a node declared dead stops believing it is
  alive. `InMemoryLeaseStore` ships with it, held to `runLeaseStoreConformance`.

  `TimerService` takes `leases: { store, owner, ttlMs? }` and claims before firing. A node that
  cannot claim skips **without completing the timer**, so a wake is never lost if the holder
  dies between claiming and resuming; ownership is released afterwards, because it covers the
  fire rather than the execution's whole life. Unwired, every path is byte-identical.

  `recoverAbandoned` then stops needing a predicate: with `leases` wired, **`isAbandoned`
  becomes optional** — an expired lease *is* the evidence the log cannot hold — and the scan
  narrows from every execution to every expired lease, which is the set you wanted. A predicate
  passed anyway is still asked, so it never becomes a lie, and the pass **claims** each orphan
  before re-driving it so two recovery passes racing the same one do not both pay for it.

  `SqliteLeaseStore` and `PostgresLeaseStore` ship with it. Acquisition is **one statement** on
  both — read-then-write would let several nodes each observe a free lease and all take it,
  which is the race the whole primitive exists to lose loudly. Verified against a real
  PostgreSQL 17, including twelve simultaneous acquires granting exactly one.

  **A claim is renewed for as long as the work takes.** Both paths that take one hold it across
  the whole resumed run, because both await it settling. Unrenewed, the lease expired *under a
  healthy holder* and a recovery pass would fence that holder out mid-run — not duplicate work,
  a killed execution. `renewWhileHeld` covers both, and reports the case where ownership is lost
  anyway, since two nodes on one execution is worth being told about even when fencing keeps the
  log sound.

  Staged deliberately (`docs/requirements/2026-09-15-durable-lease.md`): the runtime does not
  yet hold a lease across a whole run, because renewal is a ticker on the owning process's
  event loop and a CPU-bound effect can starve it into declaring a healthy execution abandoned.
  That false positive is how this feature fails, and it is written down rather than buried in a
  TTL constant.

- **The audit chain can be verified by someone who could not have written it (#382,
  [ADR 0037](docs/adr/0037-tamper-evident-audit-chain.md) amendment).** The HMAC signature makes
  the log tamper-evident *against a third party who lacks the secret* — but verification needs
  that same secret, so anyone enabled to check the log can also rewrite it: re-chain the hashes,
  re-compute the HMACs, and it verifies cleanly. The verifier and the forger were the same role,
  which is exactly what an auditor must not be.

  The signature seam is now pluggable — `ChainSigner` / `ChainVerifier` — with `ed25519Signer`
  and `ed25519Verifier` shipped over `node:crypto` (no dependency, 64-byte signatures, nothing
  to parameterize wrongly). `ChainMetadata.keyId` names the signing key so rotation does not
  invalidate history; `hmacSecret` and `signer` are mutually exclusive because they make
  different promises; and `ChainVerification` gains **`signaturesChecked`**, so a hash-only
  `ok: true` can never be read as an authorship guarantee. An entry signed by a key the verifier
  does not know is **rejected, not skipped** — authorship that cannot be checked has not been.

  Loom still makes no trust-root decision: it signs with the key you hand it, exactly as it
  HMACs with the secret you hand it.

- **`defineConfig({ timers: { dispatcher } })`** — the composition-root half of #392. An app
  that places executions deliberately can now wire the wake path in one line, instead of
  building its own `TimerService` to get at the option.

- **Placement survives the process that chose it (#392).** `ExecutionPolicy` was a
  caller-side struct mapped to `DispatchMetadata` at dispatch time, so where an execution
  belonged lived in one process's memory. Invisible for an execution that runs once — and
  gone by the time anything re-drives one that suspended for a human, which is how a branch
  sized for a cloned database wakes up inside a web server.

  `start({ computeTarget })` now records the lane on the `EXECUTION_STARTED` anchor
  (sequence 0 — where `truncatePrefix` preserves it through compaction, `deleteExecution`
  removes it, and `metadata.fence` already established that operational data rides), and
  `placementOf(eventStore, executionId)` reads it back in one indexed point-read. **No
  syscall and no EVENT_SCHEMA change**: metadata is descriptive, nothing folds it, replay is
  byte-identical.

  Both wake paths can then use it. `TimerService` and `recoverAbandoned` take an optional
  `dispatcher` and dispatch an `ExecutionPackage` to the recorded lane instead of resuming on
  whatever runtime they happen to hold; without one, behaviour is unchanged. A fork
  **inherits** its parent's lane for free (the prefix copy carries the anchor's metadata) and
  `fork(…, { computeTarget })` overrides it — the case that matters, since a simulation
  branch is exactly the work you do not want on the parent's lane.

  It is a **hint, not a pin**: it is input to a `PlacementPolicy`, which may route elsewhere.
  A target that has since been retired must not strand the executions that named it, so
  `PlacementDispatcher` falls back — and now warns once per unknown name, because falling
  back silently is how an execution placed on sized compute ends up running somewhere else
  forever. That matters most in `recoverAbandoned`, where a node is often recovering an
  execution *because* its original lane went away.

- **Branch registry rows no longer outlive the executions they describe (BranchRegistry SPI
  1.2.0).** Two rows survive a reclaimed branch and nothing collected either. A **fork edge**
  described data that no longer exists — and `LogLifecycle` walks `children()` on every sweep,
  so dead edges make retention slower forever, in proportion to every fork ever taken; the new
  optional `removeLineage(executionId)` is called at the one point where the id is known and
  the data is provably gone, inside `applyRetention`'s delete. A **ref** survives it too, and
  that is worse than untidy: `promote(ghost, "main")` succeeds, leaving `main` naming an
  execution that cannot be read, resumed or replayed. `pruneBranchRefs(eventStore, registry)`
  pages over `listRefs` and deletes refs whose execution has no events — and takes **no
  predicate**, because unlike "is this branch abandoned" (someone's open question, only the app
  can judge), "the execution is gone" is a fact. It protects `main` by default and *reports* it
  as dangling instead: turning "main names a ghost" into "there is no main" makes the problem
  harder to diagnose, not easier.

- **`retireAbandonedBranches()` — a forked parent could never be reclaimed.** `applyRetention`
  refuses anything non-terminal, and refuses a parent while a live descendant branch still has
  events (R5.3, correctly: the fork's copied prefix aliases the parent's). A branch that was
  forked, simulated and then never answered is suspended *forever* — so it is never reclaimed,
  so its parent is never reclaimed either: `blocked-by-branch`, every sweep, permanently. The
  retention policy quietly stopped applying to exactly the executions that did the most work.

  The lever is not deletion. An abandoned branch should become **terminal**, which `cancel()`
  already does durably and auditably — `EXECUTION_CANCELLED` records that the branch was
  abandoned and why, rather than erasing that it existed — after which ordinary retention
  collects the branch on its own TTL and the parent unblocks behind it. The new pass is
  parent-centric (bounded by one parent's children, no global scan), and `isAbandoned` is
  **required with no default** for `recoverAbandoned`'s reason: a branch parked on a human gate
  is someone's open question, not garbage, and only the application knows whether that person
  is still coming. It reports what it left alone, so "still open" is an answer rather than a
  silence.

- **A declared deadline no runtime can honour now says so.** `suspend({ timeout })` becomes a
  durable `wakeAt` only when a `TimerStore` is wired; unwired, the condition is committed
  *without* one — byte-identically, and silently. That is invisible while everything runs in
  one process and becomes a permanently parked execution the moment compute is split: a
  worker built as "a runtime with the flows registered" discards every timeout of every
  execution it suspends, and nothing downstream can tell "no deadline" from "the deadline was
  dropped on the machine that suspended". `WorkflowRuntime` now warns at exactly that point,
  once per (flow, gate), naming both and pointing at `loom verify`'s `suspension-safety` rule
  — which catches it statically, if you run verify against the composition that suspends.
  Routed through a new `onWarn` dep (defaulting to `console.warn`, like `defineConfig`'s
  warning for schedules that can never fire) and wired to `defineConfig({ onWarn })`. The log
  is untouched: this is a diagnostic, not a behaviour, and a test pins the committed condition
  byte-for-byte.

- **`fork()` no longer reads the parent's whole log (EventStore SPI 1.4.0).** It needed the
  tip to validate a fork point and was calling `read()` to get it — materializing every event
  of a long-lived parent, including the entire tail *above* the fork point, and paying that
  even when the store could copy the prefix natively. The SPI gains an optional
  `head(executionId)` (one indexed `MAX(sequence)`; `headOf()` falls back to reading for
  stores that omit it), and `fork()` now reads exactly one window: the tail a snapshot does
  not already cover, widened to the full prefix only when the copy itself needs it (no native
  `copyPrefix`, or live projections that must see the copied events). In the common case — a
  branch forked at a durable gate, where the suspend path has just checkpointed — it reads
  **no events at all**. Implemented natively on SQLite/Postgres/in-memory and forwarded by
  every store decorator (tenant-scoping, coalescing, sharding, profiling, content-resolving,
  hash-chaining, encrypting), so a capability probe behaves the same through a wrapper stack.

- **`BranchRegistry.promote` can be a compare-and-set, and `listRefs` can be paged
  (BranchRegistry SPI 1.1.0).** `promote(from, to)` was read-then-write on every backend, so
  two nodes promoting different winners onto `main` both succeeded and the loser silently
  became what `main` named — a pointer move with no way to say *"only if it still names what
  I read"*. It now takes `{ expect }`: the executionId `to` must name right now, or `null`
  for "must not exist yet". A mismatch throws `BranchPromotionConflictError` and **nothing
  moves**, so a caller re-reads and decides rather than retrying blind. Each backend does the
  check where it is actually atomic — one `UPDATE … WHERE execution_id = $expected` (or an
  `INSERT … ON CONFLICT DO NOTHING`) on Postgres, inside a transaction on SQLite, and
  in-process for the Map. Omitting `expect` keeps 1.0.0's last-write-wins behaviour
  byte-identically. `listRefs({ limit, after })` adds keyset paging for a ref table that is
  unbounded by design — forking is cheap — and the shared `assertListRefsLimit` guard refuses
  a non-positive or fractional `limit` on every backend, because `LIMIT -1` is SQLite for *no
  limit* and would hand the whole table to a caller that asked for one row.

  Found while writing the conformance cases: **the Postgres `BranchRegistry` had never been
  run against the conformance kit at all.** SQLite was held to the portable contract while
  the Postgres implementation — the one with hand-written SQL — was merely assumed to match
  it. `plugins/postgres/src/conformance.test.ts` now runs `runBranchRegistryConformance`
  too (verified against a real PostgreSQL 17: 71/71, up from 64).

- **Recovering executions whose supervisor died ([ADR 0004](docs/adr/0004-failure-recovery.md)
  amendment).** A dead or wedged *worker* was already handled: the dispatcher's
  `executeTimeoutMs` turns a hung attempt into a failed one, redispatches, and the worker
  resumes idempotently from durable state. What that cannot cover is the *supervisor* itself
  dying — detection lives in the dispatcher's process memory, so killing that process leaves
  an execution `running` in the log with no owner. Loom cannot resolve this from the log:
  a `running` execution owned by a healthy node elsewhere is byte-identical to an orphaned
  one, because the difference is a fact about your cluster. `recoverAbandoned(runtime, {
  source, isAbandoned })` (`@loom/workflow-runtime`) therefore does everything *except*
  decide — enumerate, filter to `running`/`pending`, ask your predicate, and resume what it
  claims through the same `EXECUTION_RECOVERED` path the worker uses under redispatch.
  `isAbandoned` is **required with no default**: `true` would preempt live work on other
  nodes, `false` would be a pass that silently recovers nothing while reading as coverage.
  Run it from a cron or a Kubernetes Job — it is a maintenance pass, not a service. A
  `LeaseStore`/heartbeat SPI that would let Loom answer the question itself is deliberately
  deferred to a second consumer ([ADR 0083](docs/adr/0083-second-consumer-rule.md)).

- **A query is an input, and an input has a bound (MemoryStore SPI 2.0.0 → 2.1.0).** Terms are
  OR-ed, so a repeated term is the same term — it cannot change which entries match, only how
  long a store takes to say so. A 128 KB question repeating one word 20,000 times built a
  20,000-clause FTS5 `MATCH` and took `SqliteMemoryStore` **32.7 seconds**: a denial of service
  bought from a text box, on a call any agent makes with whatever a user typed. `queryTerms`
  now deduplicates and caps at `MAX_QUERY_TERMS` (256, far past any real question, and the
  point at which distinct terms stop being signal), and all three backends derive their terms
  from it. It degrades rather than refuses — the choice `searchableText`'s depth limit already
  makes — and a similarity backend, which derives no terms, is unaffected. The same bound is
  applied to `SkillRegistry.find` and `CapabilityCatalog.find`, whose keyword scoring is
  `O(entries × terms)` of substring searches over an equally unbounded query.

- **A pin map is read as data, never as an object.** A derivation id is an untrusted string —
  the premise of ADR 0088 is that a model may have composed the blueprint that names it — and
  `{}["__proto__"] = version` sets a prototype instead of adding a key. The pin vanished,
  `Object.keys` never saw it, and the binding dropped out of `checkBlueprintPins` entirely:
  `compared` counted one fewer and **no finding was raised**, which is precisely the silent
  omission the seam exists to prevent. Every pin map is now built without a prototype
  (`blueprintPins`, `checkBlueprintPins`, `InMemoryProjectionRuntime.pins`,
  `ReadModelService.pins`/`checkPins`) and every read is an own-property read, so a derivation
  called `constructor` or `toString` can no longer be answered for by `Object.prototype`.
  `parseArgs` gets the same treatment: with a prototype, `flags["valueOf"] ?? fallback`
  answered with a function for a flag nobody passed.

- **The binding-semantics pin — a content address that freezes a name, not a meaning.** A
  composed surface is content-addressed, and `docs/composed-surfaces.md` listed *bindings* among
  the things that address freezes, under the heading "the meaning of a view never changes
  silently". It froze `{ projectionId, path }` — a **name**. The projection behind it is live code
  registered under that name with no version, so the query, the filter predicates, the join keys,
  the aggregation and the window all sat on the floating side, and editing a fold changed what
  every pinned view meant under an unchanged hash. The same hole was a live defect in
  `plugins/read-model`, where an edited `extract` leaves old rows in place, the watermark already
  past them, one `query` answering from two extractors, and `rebuild()` the fix nobody is told to
  run. An optional declared `version` on `ProjectionDefinition` / `Projection` /
  `ReadModelDefinition` (declared, not derived — `flowContentHash` excludes handler code for the
  same reason a fold closure has no stable fingerprint), `checkVersionPins(recorded, current)`
  reporting `drift` as an error and `unpinned` as a warn with the side it is missing from, and
  `compared` as the denominator so `ok: true` over nothing cannot read as a pass. The recorded pin
  rides in `Blueprint.projectionVersions`, inside the content address rather than beside it — a
  test asserts two views differing only in their recorded versions hash differently, which is
  what makes the recipe's frozen list true rather than aspirational. `projectionRuntime.pins()`
  is what a composer records; `checkBlueprintPins(view, pins)` is what a render compares.
  Second consumer, wired: `ReadModelService.pins()` / `checkPins(recorded)` — a query, like
  `identityDiff`, that reports what is wrong without rebuilding anything (ADR 0095).

- **Row-granular `purge` on the read-model store SPI (1.0.0 → 1.1.0).** Erasing one subject
  from a read model used to mean `clear` + rebuild — work proportional to the whole log, no
  matter how few rows the subject owned. `purge(modelId, where)` deletes by indexed-field
  equality with the same semantics `query` uses, so a caller can see what it is about to erase
  with the tool it already has, and returns the count. Measured at **68×** on
  `purge.bench.ts` (0.49 ms vs 33.8 ms, one subject of 50 in a 20k-event corpus).
  Three refusals, because an erasure that quietly does nothing is worse than one that fails:
  an empty filter throws rather than meaning either "every row" or "no rows"; a filter naming
  an undeclared field throws rather than reporting zero; and a backend without the method
  raises a typed `PurgeUnsupportedError` naming the fallback rather than resolving with zero.
  Watermarks are deliberately untouched — clearing them would let the next catch-up re-derive
  the rows just erased. Implemented for the in-memory, SQLite and Postgres backends and pinned
  by the conformance kit, which `PostgresReadModelStore` now runs for the first time
  (ADR 0093).

- **`preservesNodes` — node identity across a structural change.** A widget's `id` is derived
  from kind + props unless supplied, so a prop edit *re-identifies* the node: it remounts, and
  any pin, annotation or agent reference keyed on the old id dangles. `validateBlueprint` checks
  one tree (including `duplicate-node-id` within it); nothing compared one tree to another, which
  is where identity is actually lost. `preservesNodes(before, after)` reports which ids the change
  dropped, with `added` as data (a `dropped` beside an `added` is what a re-identification looks
  like) and `compared` as the denominator, so `ok: true` over an empty `before` cannot read as a
  pass. `blueprintNodeIds` / `preservesBlueprintNodes` spell the blueprint case; passing a floor's
  ids as `before` answers "does this variant contain the floor?" with no new vocabulary. Second
  consumer: `A2UISurfaceBridge.identityDiff(next)`, which reports what a proposed `recompose`
  would unmount without committing the tree or emitting — and which is why the API takes id sets
  rather than blueprints, A2UI components being a flat list (ADR 0094).

- **A corpus can have more than one writer** — `DocRecord.source`, `sync(docs, { source })`,
  `putDoc(doc, { source })`, and `SyncResult.retained`. `sync` is a destructive reconcile over
  everything the manifest holds, so an agent writing down what it learned from feedback into the
  same scope as an authored corpus would lose all of it to the next nightly wiki job: those
  documents are not in the set the wiki produced, and never will be. Stamped with a writer, a
  reconcile only ever touches its own documents; the rest come back as `retained`, so the
  protection is visible rather than silent. A write to a document ANOTHER writer owns is refused
  loudly — silently re-stamping would make the two delete each other's revisions on alternate
  syncs, with every individual run looking correct. An absent document has no owner, so any
  writer may create it, and an unstamped corpus behaves exactly as before (the default writer is
  a source of its own, never a wildcard). `loom knowledge sync --source <s>` carries it.

- **Blueprint conformance** ([ADR 0088](docs/adr/0088-blueprint-conformance.md)). A blueprint a
  *person* writes is checked by the type system; one a *model* composes at run time is data, and
  the only thing between an off-catalogue component and a viewer is whatever validates it on the
  way out. `validateBlueprint` / `catalogCoverage` in `@loom/blueprint-runtime` check a composed
  blueprint against the widget catalogue the app already declared — two pure functions and a
  declaration type, no kernel change.

- **Worker-thread sandbox evaluation and the hard kill**
  ([ADR 0089](docs/adr/0089-sandbox-worker-pool.md)). `vm.evalCode` is synchronous and cannot
  yield, so `wallClockMs` was not only the longest a script may run — it was the longest the
  CALLING thread was unavailable. The opt-in `workers` option on `SandboxSpec` moves evaluation
  to a worker pool, which adds the one guarantee the in-engine guards structurally cannot: a hard
  kill for a script that never reaches the interrupt handler (measured at 790ms against a 50ms
  wall clock). In-process stays the default and ADR 0064's security list is parameterized over
  both engines rather than copied.

- **`app.knowledge(scope)`, `loom knowledge`, and a `loom doctor` memory-store check** — the DX
  follow-on to ADR 0091. `app.knowledge` opens a corpus over the app's configured `memoryStore`
  (one per scope, cached; options honoured on the first call only, since two parts of an app
  configuring one corpus with different chunkers would chunk it differently on alternate ingests),
  and refuses a tier a registered `memory$` would evict — both run over the same store, and only
  the runtime that reads applies its own policy.

  `loom knowledge sync --dir <path>` reconciles a directory into a corpus, `list` shows what it
  holds, `search` asks it what a flow would retrieve. `sync` is a **dry run by default** because
  the reconcile is destructive — a document the directory no longer contains is deleted — and the
  preview runs `KnowledgeBase.planSync`, the same classification `sync` itself uses. Skipped files
  (symlinks, over the size cap, empty) are listed rather than quietly dropped, because a file the
  corpus does not contain is the answer to a "why did retrieval miss that" question. `search`
  prints that it is **not a recorded retrieval**: an operator query has no execution to record
  into, so a transcript of it is not what an execution saw. All three refuse an app with no
  configured `memoryStore` — that corpus lives in a store the process discards on exit.

  `loom doctor` gains a memory-store check: no `memoryStore` is a SKIP that names the cost (memory
  and any corpus lost on restart — the shape ADR 0090 opened with), while a configured store
  without `search` is a FAILURE, since `recallRelevant`/`retrieve` refuse it at run time rather
  than degrading.

- **`@loom/memory` is in `SPI_PACKAGES`**, so `loom plugin check` finally holds a memory backend
  to the peer-dependency rule. It had been absent for as long as the seam existed, reporting a
  green "SPI packages are peer dependencies" while being unable to see the one package that
  matters to it. A bundled copy here is not a duplicate kernel but a duplicate CONTRACT:
  `searchableText`/`tokenize`/`clampSearchLimit` decide what a backend indexes and what counts
  as a term, so a plugin carrying its own copy can answer a different question than the app
  asked and still pass conformance.

- **A corpus is mutable, and the SPI could not say so**
  ([ADR 0091](docs/adr/0091-corpus-lifecycle-and-the-knowledge-package.md)). `MemoryStore.search`
  ranks within ONE key, so a searchable corpus has to be one key — while a DOCUMENT, the unit that
  actually gets revised and deleted, is a subset of that key the SPI could not name. Re-ingesting
  an edited document therefore DUPLICATED it (retrieval returning the superseded passage beside the
  current one, with nothing saying which was live), the only removal verb was `clear` on the whole
  scope, and a document deleted upstream kept answering questions. None of it shows in a green
  suite, because every test ingests once.

  `MemoryEntry.id` is now optional for a caller and **required for a backend to round-trip**, with
  the optional `MemoryStore.remove(key, ids)` beside it. The asymmetry is deliberate: `remove` has
  a correct fallback (read-filter-`replace`), but that fallback matches on the id `read` gives
  back, so a backend that dropped ids would turn a delete into a silent no-op on exactly the path
  taken by backends with no native delete. **`MEMORY_STORE_SPI_VERSION` is 2.0.0** — MAJOR because
  a backend that decomposes an entry into columns drops a field nobody told it to keep, which is
  invisible to every case that only checks `content`. Neither first-party SQL backend needed a
  migration: both already store the entry as JSON, so removal reads the id back out of it
  (`json_extract` / `entry->>'id'`) behind a partial expression index.

- **`@loom/knowledge` — document corpora over a memory tier.** `KnowledgeBase.putDoc` is an UPSERT
  and `sync(docs)` reconciles a corpus against its source: write what changed (by a
  `canonicalJson`+`fnv1a64` fingerprint), leave what did not, remove what the source dropped — an
  unchanged source costs one manifest read and zero writes. Manifest rows are APPENDED and pruned
  only after the new one is durable, because the obvious alternative (delete the old row, write the
  new one) has a crash window in which a document has no row at all, and a document nothing counts
  is a document nothing can remove.

  `groundedRequest`/`passageMessages` assemble the one prompt shape `guardRequest` accepts — one
  `user` message per passage, taint intact, never joined — so the shape every RAG tutorial writes
  (passages in the SYSTEM prompt) does not compile rather than being refused at run time.
  `openKnowledgeBase(store, { scope })` is the two-line form of the four every consumer was
  writing by hand — a corpus needs exactly one tier and that tier must not evict, which is a
  fact about corpora rather than a decision each app re-derives (and `app.memory` is a
  `MemoryRuntime`, one layer below the `TieredMemory` the constructor takes, so the
  boilerplate was mandatory rather than incidental).

  `checkCitations`/`assertGrounded` reject a citation to a document that was never retrieved: the
  one hallucination in a RAG answer that is decidable rather than judged, because the retrieval was
  recorded. Chunking stays injected (`packParagraphs` is an ignorable default), embeddings stay
  third-party, and the `knowledge$` construct stays rejected.

- **The `MemoryStore` SPI is versioned** (`MEMORY_STORE_SPI_VERSION`, 1.0.0), carried in the kernel
  manifest and `checkCompatibility` beside the event-store / snapshot / branch / dispatcher SPIs.
  A formality while every implementation lived in this workspace, where a breaking change breaks
  the build that made it — and not one once the seam grew a backend OUTSIDE it, which nothing here
  builds, tests, or can see.

- **A `memory` seam for `loom plugin new`**, and an exports-map rule in `loom plugin check`: an
  `exports` map declaring `require` with no `default`/`import` resolves for CJS and raises
  `ERR_PACKAGE_PATH_NOT_EXPORTED` for ESM — a shape neither tsc nor a CJS test runner can see.

- **Agent memory that survives a restart, and can answer a question**
  ([ADR 0090](docs/adr/0090-knowledge-is-retrieval-over-memory.md)). `@loom/memory` shipped tiers,
  TTL/size policy, summarization and `ctx.decide`-recorded recall over a pluggable `MemoryStore` —
  and exactly one implementation of it, `InMemoryMemoryStore`. Every store plugin carried an event
  store, a snapshot store, a timer store, a durable-state store and a read model, and no memory
  store, so what shipped was a prompt-context manager: an agent that restarted remembered nothing.

  `SqliteMemoryStore` and `PostgresMemoryStore` live in the plugins that already own those
  databases — point them at the event log's file/URL and one backup captures both. A key names an
  ORDERED LIST read back in APPEND order, never timestamp order (entries routinely share a
  timestamp, and ordering by it reshuffles a conversation). `MemoryStore.replace` (OPTIONAL) is a
  durability fix rather than an optimisation: `MemoryRuntime` rewrites a scope's whole list on
  every eviction, and as clear-then-re-append a crash between the two makes routine eviction the
  thing that loses the scope.

- **`MemoryStore.search` — recall by relevance, not just by recency.** `read` answers *what
  happened last*; the `semantic`/`procedural` tiers never evict, so their "newest N" means nothing
  and the only way to use one was to load it whole. `search` ships with three first-party
  implementations (in-memory IDF, SQLite FTS5, Postgres `tsvector`) plus a third-party cosine
  backend, all passing one `runMemoryStoreConformance` — which is what makes the seam a contract
  rather than a description of an inverted index. `searchableText` and `tokenize` are exported
  because *what gets indexed* and *what counts as a term* are the contract; ranking is not, and the
  kit deliberately does not pin an order.

  `TieredMemory.recallRelevant(tier, scope, query, { decide })` takes `decide` as a **required**
  option where `recall`'s is optional: relevance ranks over a corpus that grows, so the set it
  returns differs between a run and its replay, and a type requirement beats a documented one.
  `MemoryRuntime.search` refuses a store without `search` rather than degrading to `read` — a
  silent fallback would look like retrieval and be undetectable downstream.

- **A `memory` seam for `loom plugin new`.** Emits only the three required verbs and explains
  `replace`/`search`/`close` in prose, because for an optional method presence IS the feature flag:
  the runtime tests for it and falls back when absent, so a generated stub that throws advertises a
  capability the store does not have. `loom plugin check` gains an exports-map rule — `require`
  with no `default`/`import` resolves for CJS and raises `ERR_PACKAGE_PATH_NOT_EXPORTED` for ESM.

- **The agent loop is a runner body, and the seams it can now reach are wired**
  ([ADR 0087](docs/adr/0087-durable-agent-loop.md)). `agentStep$` wrapped the whole ReAct loop in
  one `step$({ handler })`, and a handler receives `StepHandlerContext` — `emit`, and nothing else.
  So forty model calls and N tool calls were ONE frame (a crash at turn 39 re-ran all 39), approval
  had to be hoisted out of the agent entirely, and routing choices were hand-emitted in a shape
  `@loom/learning` cannot evaluate. Nothing was missing from the kernel; the loop was on the wrong
  side of it.

  `agentLoop$(ctx, config, input)` is an ordinary function over `ExecutionContext`, called from a
  runner body, issuing `ctx.execute` per turn with ids minted `#turn:<i>` / `#turn:<i>:tool:<j>` per
  the [ADR 0061](docs/adr/0061-step-identity-interpreter-guardrails.md) identity rule. The model
  call resolves through the `EffectRuntime` by `modelToolId`, so K2, metering, retry,
  `idempotencyKey` and K9 in-doubt all apply to it. `requireApproval` parks the execution on a gate
  BEFORE a destructive tool runs, and a refusal is fed back to the model as a tool result rather
  than thrown — a human declining is information the agent can settle on.

  Its choices go through the decision seam: skill selection and memory recall via `ctx.decide`
  (so a replay reconstructs the prompt that actually ran, not the one a re-selection would build),
  compaction via `ctx.execute` (a lossy, nondeterministic summary has to be a recorded fact), and
  Reasoning-Runtime routing likewise. `agentStep$` is retained and NOT deprecated: one frame instead
  of 2N, for an agent that wants none of this.

- **A streamed model call that is still one durable outcome.** `LlmStreamChunk` carries optional
  `toolCalls`/`stopReason`/`usage` on its terminal chunk — without them a stream could carry prose
  to a human and nothing else, since a ReAct loop branches on exactly those. `assembleStream` /
  `collectStream` fold a stream into the `LlmResponse` it represents, and
  `runLlmProviderConformance` pins the contract that makes two paths to one outcome safe: **a
  streamed result MUST equal what `complete` returns** — [ADR 0059](docs/adr/0059-content-put-stream.md)
  D1's streamed-≡-buffered discipline applied to the model call. `createLlmEffect({ stream: true })`
  consumes it internally: deltas reach a transient sink, the journal sees one `STEP_COMPLETED`, and
  an interrupted generation keeps its partial text on an ADR 0060 channel instead of discarding it.

- **K8.4 — a runaway generation is severed while it generates**
  ([ADR 0020](docs/adr/0020-k8-cancellation-deadlines-bounded-effects.md) A8). Every other K3 gate
  is admission control: it decides whether the NEXT effect runs, so a model that emits 100K tokens
  was billed in full and stopped afterwards. `streamTokenBudget(budget)` (`@loom/middleware`) guards
  `collectStream`, estimating output tokens from the text so far plus what `ctx.resources` already
  metered, and on breach emits `QUOTA_EXCEEDED` — the same durable fact `meteringMiddleware`
  writes — then throws `QuotaExceededError`. The estimate is named as an estimate in the type, in
  the reason, and in the default; final metering still uses the provider's own numbers.

### Fixed

- **`loom retention run` could delete a parent its branches still depended on.** The command
  built `LogLifecycle` with **no branch registry**, and R5.3's live-descendant guard is a no-op
  without one — so `--apply` on a branched database deleted parents whose forks alias their
  prefix, breaking exactly the invariant the guard exists for. The file's own comment said the
  opposite (*"the branch-integrity guard … handled by `LogLifecycle.applyRetention`"*), true of
  the method and false of this caller.

  It also re-implemented eligibility locally for the dry run — terminal + aged — so the preview
  silently skipped the branch **and** pin gates and printed `would-reclaim` for executions the
  library would refuse. A `--apply` flag whose preview disagrees with its apply is worse than no
  preview. `LogLifecycle.evaluate()` now holds every gate and `applyRetention` consults it, so
  the two cannot drift; the CLI takes `--branches <path>`, and **says the guard is off** when it
  is not given rather than looking complete.

- **`wallClockMs` charged the parent's own latency to the script.** The sandbox pool's kill
  deadline is a `setTimeout` on the parent's event loop, and the worker's reply arrives as a
  message to that same loop — so the budget measured the script *plus* however long the parent
  took to post the eval and to drain the reply. libuv runs the timers phase before the poll
  phase, so on a contended host a due deadline fires ahead of a reply that already arrived,
  and a trivial script comes back `limitExceeded { wallClock }`: a resource kill routed to
  drift-repair, where an LLM rewrites a script that was never the problem. (Same failure the
  pool already fixed for cold starts, by a different route.) The deadline is now a **question
  asked of shared memory** rather than a verdict: the worker stamps when the script actually
  started and when it stopped into a `SharedArrayBuffer`, which the parent reads
  *synchronously* inside the timer callback — where it cannot receive a message. A script is
  killed only if it is still running and has outrun its budget **by the worker's own clock**;
  otherwise the parent re-asks. A worker that never starts the run at all is still reclaimed,
  as a worker fault rather than a script breach. Pinned by a test that starves the parent for
  four times the deadline and asserts the fast script still resolves.

- **The retention guard read whole logs to ask a yes/no question.** `hasLiveDescendant` called
  `eventStore.read(child)` and checked `.length > 0` — per child, per swept execution, against
  branch logs, which are the long ones precisely because a branch is forked to do expensive
  work. It is a tip query, and now uses `headOf` (EventStore SPI 1.4.0).

- **A fork copied the gate but not the alarm.** `WorkflowRuntime.fork()` copies the parent's
  prefix verbatim, so a branch forked at a suspension is parked on the same condition —
  including a `wakeAt` derived from `suspend({ timeout })`. But a timer row is keyed by
  executionId, and `timerStore.schedule` was called from exactly one place: the suspend path
  of the run loop. A branch therefore inherited, in its own log, a deadline that nothing
  would ever fire, and nothing else could catch it — `recoverAbandoned` ignores suspended
  executions by design, because suspension is a normal outcome rather than an abandonment.
  The parent timed out on schedule while every branch waited forever. `fork()` now schedules
  the child's wake, after the prefix and seed snapshot are durable (the same invariant the
  suspend path holds: a timer must never fire into a log that does not yet record the
  suspend), and reports a failed schedule through `onStorageError` rather than failing a fork
  that is already complete. **The branch inherits the recorded deadline and cannot re-base
  it**: `TimerService` fires only when `state.suspendedOn.wakeAt === timer.wakeAt` and the
  copied prefix is byte-identical by design, so a re-based deadline would be a timer that
  could never match its own log. A branch that wants its own deadline resumes the gate and
  suspends again with a fresh `timeout` — a fact it appends, not one it inherits. Untimed
  gates gain no timer, a fork before the gate gains none, and with no `TimerStore` wired the
  behaviour is byte-identical to before.

- **`DelegationAuthorizer`'s `base` is required (potentially breaking).** It was optional,
  documented as "omit to allow the full verified delegated set (the callee delegates all of
  its authority decisions upstream)". That mode cannot deliver what it claims: the delegation
  secret is **symmetric**, so the party that verifies a token is also a party that can mint
  one. A callee can sign itself `{ grants: ["*"] }` and the result is *genuine* — no signature
  check can reject it, because it is not forgery. What actually bounds a callee is the
  intersection with `base`, so an absent `base` silently reduced that check to a no-op while
  still reading as a working gate. `base` is now required, with a constructor guard as well as
  the type (the type is not enforcement for JS callers). No production construction sites
  existed in this repo or any sibling, so the practical blast radius is zero;
  [ADR 0024](docs/adr/0024-k12-identity-tenancy-delegated-authority.md) now records the trust
  model and marks cross-organisation delegation — where the verifier must not be able to mint,
  and which needs asymmetric signatures — an explicit non-goal. The same symmetry applies to
  [ADR 0037](docs/adr/0037-tamper-evident-audit-chain.md)'s audit chain: an auditor handed the
  HMAC secret to verify history can also rewrite it, so it is tamper-*evident* against third
  parties rather than third-party *verifiable*.

- **Subject erasure never reached a derived read model, and "just rebuild it" did not work
  either.** A crypto-shred (K10.2) erases the log; it says nothing about anything built from
  the log, and `eraseSubject` does not know a read model exists. Every derived row kept the
  plaintext its extractor copied out before the key died — and those rows are what a query
  reads. The prescribed repair, `clear(modelId)` + re-scan, then failed on its own terms: the
  authoritative read of a shredded subject throws `PayloadShreddedError` by design, and a
  rebuild is a read, so it needs a source configured `onShredded: "tolerate"` — the throw is
  at the SOURCE, before any extractor runs. Under a tolerant source the extractor must then
  decide what `{ $shredded: true }` means, because indexing it verbatim rebuilds the
  placeholder into the cache and collapses every erased subject onto one bucket. All three are
  now documented (`docs/compliance.md`, the `ReadModelStore.clear` contract) and pinned by
  `plugins/read-model/src/erasure.test.ts`. Erasure cost is *O(log)*, not *O(subject)*; a
  row-granular purge stays deferred behind a measured cost (ADR 0092 D6).

- **Indexing recursed without a bound over ingested memory content.** `searchableText` walked
  `entry.content` recursively with no depth cap and no cycle guard, and `content` is whatever was
  ingested. A nesting depth of 5,000 is still JSON-serializable — so it satisfies the documented
  contract AND every durable backend's own `JSON.stringify` — and it exhausted the call stack,
  failing a write the store had promised to accept; a cyclic value never terminated, and the
  in-memory store accepted one at `append` only to detonate later inside an unrelated `search`.
  Now an iterative walk with an explicit stack and a depth cap, indexing over-deep content as far
  as the cap rather than refusing it.

- **`MemoryStore.search` trusted its `limit`.** Three backends, three behaviours: `.slice(0, -1)`
  dropped the last hit, SQLite read `LIMIT -1` as NO LIMIT and returned the entire matching set,
  Postgres threw. The unbounded one is the quiet failure, and `recallRelevant` records what it
  retrieved through `ctx.decide` — so an unbounded search writes the whole corpus into a
  `DECISION_RECORDED` payload, permanently. `clampSearchLimit` mirrors
  `@loom/plugin-read-model`'s `MAX_QUERY_LIMIT`; four conformance cases pin it, and backends MUST
  route their limit through it.

- **`SupervisingDispatcher` never forgot a circuit.** `recordSuccess` reset one in place and
  nothing deleted it, so a `policy.circuit.key` with tenant or execution cardinality — which the
  hook invites, since it receives the whole `ExecutionPackage` — grew for the process lifetime.
  Deleting on success is observationally identical at all three read sites.

- **Two SPI-map claims that understated what ships.** The Timers row said its conformance kit was
  `— (future)` while `runTimerStoreConformance` had shipped and SQLite was running it, and the
  compute section called a dispatcher kit "a natural follow-up" with
  `runExecutionDispatcherConformance` already exported. Four seams with kits and no row at all
  (content store, carry state, read models, subject keys) are now listed, and a fitness function
  keeps the column honest in both directions.

- **Every package's `exports` map was unreachable from ESM.** Forty-nine declared
  `{ require, types }` and nothing else. Node matches export conditions in order and stops at the
  first hit, and an `import` offers `["node", "import"]` — never `"require"` — so it matched
  nothing. Invisible from inside: loom's own test config forces `conditions: ["require",
  "default"]`, TypeScript reads `types` directly, and neither turbo nor tsc resolves at runtime.
  Now `types` / `require` / `default`, with `default` last because it matches everything and
  anything after it is dead. A fitness function in `@loom/spec` holds all three properties, and the
  scaffold no longer mints the defect into new plugins.

- **Three ways a check could silently not run.** The Postgres suites (94 tests) had never executed
  in CI — gated on `LOOM_TEST_POSTGRES_URL`, skipping cleanly, and a skipped suite renders exactly
  like a passing one; CI now provisions a service container, and the requirement lives in the repo
  as a test that fails when `CI` is set and the URL is not. `LOOM_TEST_POSTGRES_URL` and
  `LOOM_TEST_SRC` were absent from turbo's `test` cache key, so a cached result from a run WITHOUT
  a database was replayed verbatim for a run that had one. And seven packages ran vitest with no
  config at all — there is no root config to inherit — so they silently opted out of the shared
  resolution, which is how a value import from `@loom/memory` first broke, and made
  `LOOM_TEST_SRC=1` inert in exactly those packages.

- **`ctx.decide` could not be passed as a value.** Every decider-taking helper takes it as an
  option and the documented spelling is `decide: ctx.decide`, which lost its receiver and died
  inside the context with a `TypeError` naming neither `decide` nor binding. `agentLoop$` carried a
  hand-written wrapper at two call sites, with a comment instructing the reader to do the same — so
  the workaround was known and the fix was not. The context now binds it.

- **A tainted value's `origin` was indexed as searchable text.** An ingested corpus taints every
  entry ([ADR 0085](docs/adr/0085-untrusted-content-integrity-axis.md)), so the label rode into
  `searchableText` as a string leaf and one term matched the whole corpus — on an FTS backend that
  widens the match *set*, not just the ranking. Provenance is metadata by exactly the rule that
  already excludes `role` and the timestamp.

- **Two tests that asserted the clock instead of the property.** A cross-node LISTEN/NOTIFY test
  fired `subscribe` and slept 100ms; `NOTIFY` is not durable, so a listener registering after the
  publish never receives it and the wait could only time out — it now awaits the subscription,
  which the store already resolves after its LISTEN registers. A content-batching test measured
  elapsed time against a 20 x 5ms serialized floor with a 2x margin; it now asserts peak in-flight
  calls, which a serialized fallback can only ever drive to 1.

- **The prompt-boundary guard runs where prompts are actually built.**
  [ADR 0085](docs/adr/0085-untrusted-content-integrity-axis.md)'s protection did not cover the
  agent: `guardRequest` ran only inside `createLlmEffect`, which had no production consumer, while
  `AgentRunner` and `ReasoningRuntime` called `provider.complete` directly. The agent path was worse
  than unguarded — `JSON.stringify` of a tool result flattened the taint envelope into ordinary
  text, so `isTainted` was false downstream and no guard added later could recover the origin.
  Evidence erased, not merely unused. Both paths now guard, and a tool result keeps its taint
  outside the serialization.

- **An agent's declared tool menu is its reachable effect set.** `resolveVerifyInput` read
  `AgentDefinition.tools` nowhere, and an `agentStep$` declares no `toolId` of its own — so a flow
  whose only step was an agent contributed NO effects, and `capability-compat`, `effect-class` and
  ADR 0084's unclassified-effects warn all passed vacuously over it. `StepDefinition.reachableTools`
  declares the menu reachable THROUGH a step; `agentStep$` populates it from the agent's tools.

- **A capability denial is terminal for the turn.** `AgentRunner` swallowed every throw into
  `{ error }` and handed it to the model, which reads "not authorized", reformulates, and probes a
  neighbouring tool — turning one denial into a search over the grant table. `EFFECT_DENIED` was
  always logged, but auditable is not the same as stopped.

- **A spawned child can be given less authority than the flow it runs.** `superviseChildren` started
  children with no principal at all, so K12.4's `DelegatedGrant` — which verifies signature, expiry,
  holder-binding and the intersection with the callee's own grants — had nothing to check.
  `awaitChild({ grants })` names the conferred subset and a supervisor wired with
  `delegation: { secret }` mints the token at start time, bound to the child's own execution id.
  The signed token is never written to the log: an append-only, archived log is the wrong place for
  a bearer credential, so the log records the subset and the mint is re-derived on recovery.

- **Envelope ids are unique too, and a re-used one is its own error**
  ([#309](https://github.com/chhetrisushil/loom/issues/309)). The sibling of #306 on the events
  table's other key: both SQL backends declare `PRIMARY KEY (id)`, `InMemoryAsyncEventStore` had no
  equivalent check, and two envelopes sharing an `id` both landed. All three backends now reject
  with `DuplicateEnvelopeIdError` — deliberately a **different type** from `DuplicateSequenceError`,
  because they are different failures: a taken sequence means another writer reached that slot (a
  lost race, retryable by re-reading and re-allocating), a taken id means the same envelope identity
  was minted twice (a bug in whatever produced it). Ids are conventionally derived from
  `${executionId}-${sequence}`, so a lost slot race trips both constraints; the sequence is
  reported, being the actionable one.

  The in-memory store keeps an id index, which has to be maintained everywhere the log changes,
  not just on append: `deleteExecution` and `truncatePrefix` free the ids of the events they drop
  (an index outliving its events makes an erased execution impossible to re-create, and leaks
  across a retention sweep), and `copyPrefix` claims the ids of the events it copies — rejecting,
  all-or-nothing, if a re-stamped id collides.

  **Uniqueness is required within an execution; cross-execution is explicitly not.**
  `ShardedEventStore` cannot provide it — separate executions live on separate backing stores and
  no shard sees another's ids — the same carve-out `appendBatch` already makes for cross-execution
  atomicity. A single-log backend gets store-wide uniqueness from its primary key and is free to be
  stricter (the in-memory store is); a caller must not depend on it.

  The new clause found one more thing: `fanout.test.ts` built its crash-residue fixture by
  renumbering sequences while keeping the original ids, so the surviving events carried ids
  belonging to sequences that were no longer theirs — a log neither SQL backend would have
  accepted. The fixture now re-stamps both.

- **`(executionId, sequence)` is unique in every backend, and the contract now says so**
  ([#306](https://github.com/chhetrisushil/loom/issues/306)). SQLite and Postgres enforce
  `UNIQUE (execution_id, sequence)`; `InMemoryAsyncEventStore` — which is not a test double but
  `defineConfig`'s `kind: "memory"` backend, the one an app gets when no store plugin is wired —
  accepted both writes and interleaved them into the log. Not covered by fencing: fencing engages
  only once a token has been *acquired*, while sequences are allocated per-process from folded
  state (`ExecutionJournal` seeds from `vm.getState().sequence` and increments locally), so two
  unfenced writers recovering the same execution allocate the same next sequence with neither one
  a zombie. `appendBatch` additionally validates the batch against **itself** — two envelopes
  claiming one slot conflict only with each other, so a check against stored rows alone admits the
  pair.

  All three backends now reject with a shared `DuplicateSequenceError`, so a caller need not know
  which store it is talking to (or match driver text) to recognise a lost sequence race. The
  mapping is narrowed by constraint, since both tables also key `id` and a re-used envelope id is
  a different bug.

  The gap was never a missing suite — `runEventStoreConformance` exists (ADR 0033) and all three
  stores already ran it. It was a missing **clause**: the portable contract said nothing about
  uniqueness, so a backend could omit the check and still conform. Three cases added there, which
  is what makes every backend (including a third-party one) agree. Two pre-existing tests named
  "rejects duplicate (executionId, sequence)" were rewritten: both built their two envelopes with
  the same derived id, so they collided on the id primary key and never reached the constraint
  they were named for — `.rejects.toThrow()` could not tell the difference.

- **The resume ingress gate: a caller-supplied `eventType` no longer writes kernel state, and a
  resume must name the gate it answers** ([#304](https://github.com/chhetrisushil/loom/issues/304),
  [#305](https://github.com/chhetrisushil/loom/issues/305)). `eventType` travels from an ingress
  adapter — A2A `provideInput` and the wire-ABI `execution.resume` both forward a network-supplied
  `ResumeEvent` — into the log verbatim, and the fold dispatches by NAME. A resume typed
  `STEP_COMPLETED` therefore forged a step outcome that the completed short-circuit served
  *without running the effect*; `EXECUTION_MIGRATED` rewrote the K11 code pin and `_input` (and
  could wedge an execution permanently); `APPROVAL_GRANTED` wrote the K12.2 evidence the
  authenticator exists to produce, while the authenticator was rejecting the honest attempt.
  Separately, `suspendedOn.on` was folded and read by nothing, so any name resumed any gate —
  which also skipped the ADR 0077 `resumeSchemas` lookup, since that keys off the caller's event
  type: a declared shape gate was evaded by renaming the event. And `resume()` refused only a
  *cancelled* execution, so a completed one was still writable.

  `resume()` now refuses, before anything is appended, an event type in the K5-governed
  `knownEventTypes()` set, an execution that is not `suspended`, and an event type that is not the
  parked gate. Refusal is **fold-identical for every legitimate log** (G2): a non-kernel event type
  already folded to a no-op. `TIMER_FIRED` remains allowed as the kernel's own wake, and a *timed*
  suspend is wakeable by it whatever its gate is called; `EXECUTION_RECOVERED` remains the
  dispatcher's re-drive of a crashed execution and is now refused on a parked one. `resumeAs`
  enforces the kernel-namespace rule only — the recorded gate belongs to the code being migrated
  away from. New `ResumeRefusedError` carries a machine-readable `reason`; `@loom/orchestration`
  retries the one transient reason (`not-suspended`, a parent whose suspend is not yet readable on
  an async store) instead of matching message text. `KERNEL_ABI`/`EVENT_SCHEMA` unchanged.

  **Behavioural tightening, not a pure fix:** an app resuming with a name that does not match its
  `suspend({ on })` was succeeding by accident and will now be refused.

### Added

- **The verify tier stops needing hand-plumbed source, and gains a front door.** The compiler
  transform now emits all three per-flow source analyses into `loom-manifest.json` —
  `loopIdentity` ([ADR 0061](docs/adr/0061-step-identity-interpreter-guardrails.md)),
  `nonDeterministic`, and `runnerReach` ([ADR 0086](docs/adr/0086-runner-body-reach-analysis.md)) —
  and `loom verify` auto-injects them from a discovered manifest, so `determinism`,
  `capability-compat`, `effect-class` and `suspension-safety` are on whenever you build with the
  Loom compiler rather than requiring a developer to feed their own runner source to a linter.
  New **`loom doctor`** runs every pre-flight check whose input it can discover and **names the
  ones it skipped and why** — "all checks passed" and "passed, but N check(s) could not run —
  coverage is partial" are deliberately different strings. Whole-module analysis skips memoized
  `handler$` bodies (`{ skipMemoized: true }`): a handler's result is served from the log on
  replay, so non-determinism inside one is safe by construction.
- **Runner-body reach analysis, and two `suspension-safety` checks it proved wrong**
  ([ADR 0086](docs/adr/0086-runner-body-reach-analysis.md)). `capability-compat`, `effect-class`
  and `suspension-safety` previously defined "what a flow reaches" as its *declared* steps, so a
  step invoked through `ctx.run` was invisible and `FlowSpec.suspends` had no producer at all.
  `analyzeRunnerReach` resolves `ctx.run` targets by shape and **reports what it could not
  resolve** as a `warn` on each rule. Populating the input showed the blanket `correlationKey`
  error was wrong (`resume` routes by `executionId`) — removed — and that the `wakeAt` check must
  be conditional on a wired `TimerStore`. `KERNEL_ABI`/`EVENT_SCHEMA` unchanged.
- **The integrity axis: untrusted content as a value, refused at the prompt boundary**
  ([ADR 0085](docs/adr/0085-untrusted-content-integrity-axis.md)). `tainted()`/`unwrapTainted()`
  in `@loom/classify` wrap third-party bytes in plain JSON that survives the log verbatim, so a
  replay hands back a value that is *still* tainted. `@loom/llm`'s `guardRequest` runs inside
  every `createLlmEffect` and throws `UntrustedContentError` if tainted content reaches a system
  message, an assistant turn, or a tool name/description; in a `user` message it is fenced as
  `<untrusted-input origin="…">`. Two opt-in producers ship: `registerMcpInvoke(…, {
  taintResults: true })` and `new A2APeerClient({ …, taintResults: true })`.
- **Effect classes — a static ceiling beside K2's runtime floor**
  ([ADR 0084](docs/adr/0084-effect-classes-static-ceiling-k2-floor.md)). An eighth `@loom/verify`
  rule: a flow may not reach an effect whose declared class exceeds its own, composed
  conservatively as the max over everything reachable. The class *vocabulary* is app-supplied
  (`checks: { verify: { effectClasses } }`) — loom checks the ordering it is given rather than
  defining one. A **granted** capability can still bust the class, and K2 will not stop it; the
  finding says so.
- **`@loom/learning` — the substrate for continuous learning, not the learner**
  (ADRs [0078](docs/adr/0078-exploration-in-the-routing-seam.md)–[0080](docs/adr/0080-learning-substrate.md)).
  `context` and `policy` (including `propensity`) now ride `DECISION_RECORDED`
  (**EVENT_SCHEMA 1.18.0**; `KERNEL_ABI` untouched), which is what makes off-policy evaluation
  possible at all — propensity cannot be reconstructed after the fact. Ships trajectory
  extraction, SNIPS evaluation with unit-level ESS and a cluster-robust estimate for pooling
  across units, a promotion gate, the third-party `Policy` SPI (the one seam consumed from flow
  code rather than `defineConfig`), and `loom learn report` / `loom learn eval`. The router's
  greedy collapse onto one lucky arm is fixed with `ucb1`/`epsilonGreedy`. Pooled reports never
  name a unit — asserted by an invariant test that injects a leak.
- **Storage scale-out as composable decorators** (ADRs
  [0074](docs/adr/0074-storage-scale-out-decorators.md)–[0075](docs/adr/0075-shard-rebalancing.md))
  — sharding, batching and rebalancing (virtual buckets, lazy drain, no coordinator) layered over
  any `EventStore` rather than built into one backend. `EVENT_STORE_SPI_VERSION` → 1.3.0.
  Measured ceilings and the method are written up in [`docs/scaling.md`](docs/scaling.md).
- **Two boundaries that looked enforced and were not.** Array crossings in classification paths
  now expand late and walk once ([ADR 0076](docs/adr/0076-wildcard-classification-paths.md)),
  and resume payloads get per-gate contracts enforced **before** the append —
  `flow$({ resumeSchemas })` plus a generic `ctx.suspend<T>`
  ([ADR 0077](docs/adr/0077-typed-resume-payloads.md), `ResumePayloadValidationError`).
- **`@loom/replay-inspector` — read-only replay** ([ADR 0071](docs/adr/0071-read-only-replay-inspector.md),
  IX series): inspect an execution's replay without a live runtime, bounded by an explicit budget
  (`InspectorBudgetError`).
- **MCP Apps (SEP-1865) placement** ([ADR 0072](docs/adr/0072-mcp-apps-ui-extension-placement.md)):
  ingress fidelity plus `createMcpServer`, and `ui://` egress as one static, content-pinned
  surface-host template in `@loom/plugin-mcp-app` (`TemplateDriftError`). The **host** role is
  where a third party belongs, not a reason for loom to build one.
- **Effect mode — `journaled` vs `ambient`** ([ADR 0073](docs/adr/0073-effect-mode-journaled-vs-ambient.md)):
  a declaration plus a boundary check (`EffectModeViolationError`) that keeps user-driven
  enrichment reads out of the durable log.
- **The second-consumer rule** ([ADR 0083](docs/adr/0083-second-consumer-rule.md)) — before a
  workload-derived requirement becomes a first-party package, verify rule, seam, or exported
  vocabulary, name a second unrelated consumer. Recorded because this repo had a strong antibody
  against kernel growth and none against first-party surface growth.
- **Two kernel promotions refused, with evidence gates recorded rather than scheduled**:
  long-lived suspensions need a benchmark, not a promotion
  ([ADR 0081](docs/adr/0081-long-lived-suspensions-no-promotion.md)), and substitutive replay is
  deferred until branch-from-prefix is eliminated
  ([ADR 0082](docs/adr/0082-substitutive-replay-deferred.md)).

- **A2UI `callFunction` (bidirectional RPC) in `@loom/plugin-a2ui`.** The A2UI adapter now covers the
  agent→client `callFunction` leg (the agent invokes a named catalog function; the client answers with a
  `functionResponse`), promoting the surface deferred in ADR 0069. Two composition grains on
  transport-agnostic primitives: **grain A** — a read via a `ctx.suspend` gate
  (`bridge.callFunction` → `ingestFunctionResponse` → `runtime.resume`); **grain B** — a side-effecting
  call via a delegated effect (`registerA2UICallFunction`, `idempotent: false` so a crash mid-call parks at
  `EFFECT_INDOUBT`). Determinism rests on **result-as-recorded-fact + a deterministic, call-site-unique
  `callId`** — no client-side effect runtime, no new event types (`EVENT_SCHEMA`/`KERNEL_ABI` unchanged).
  Inbound replies are correlation-checked (`ingestFunctionResponse(msg, expectedCallId)` and an effect-side
  `callId`/`surfaceId` match), and `registerA2UICallFunction` accepts a `requestTimeoutMs`. New
  `examples/a2ui-callfunction` demonstrates both grains + a crash→in-doubt recovery. See
  [ADR 0070](docs/adr/0070-a2ui-callfunction-bidirectional-rpc.md).
- **`loom appgen` — natural-language → Loom app.** New `@loom/cli` subcommand that turns a
  natural-language intent into a Loom app following the **folder convention** (the same shape
  `create-loom-app` / `loom new` / `loom gen` produce), wiring the pure `@loom/appgen` library
  (`parseIntent` → `generateProject` / `generateFlows`) into the CLI. Output is plain, static,
  inspectable TypeScript with `TODO` handlers; parsing and code generation are deterministic and
  offline (no model call at generate time, none in the output).
  - **Adapts to the target `dir` (the project root, default `.`):** a new/empty dir gets a full
    runnable project (`package.json`, `tsconfig.json`, `app/config.ts` with `defineConfig({
    flowModules })`, `app/main.ts`, `app/loom.gen.ts`, and one `app/flows/<id>/flow.ts` per
    capability) so `pnpm install && pnpm start` works out of the box; an existing Loom app gets
    just the `app/flows/<id>/flow.ts` files, then `app/loom.gen.ts` is regenerated from the
    filesystem (the `loom gen` step) so pre-existing flows stay wired.
  - Reuses `@loom/scaffold` (`appFiles` / `generateRegistration`) rather than hand-rolling, so
    appgen output now matches every other generator. Flows export a `RegisteredFlow` (the older
    `capability$` / `CapabilityCatalog` composition root is gone). The one value-add over
    `loom new` is the NL-derived flow body (reasoning ladder, approval suspend gate, UI surface).
  - Intent is supplied as a quoted positional string or via `--from <file>`.
  - Writes each file directly when the target path is free; on a collision it prompts
    interactively per file — `[r]ename / [s]kip / [o]verwrite` — backed by a stdin line-queue
    reader that works for both TTYs and piped input.
  - `cmdAppgen` is exported from `@loom/cli` for programmatic use, with an injectable IO seam.
  - Docs: new section in [`docs/usage-cli.md`](docs/usage-cli.md) and the CLI overview in
    [`docs/user-guide.md`](docs/user-guide.md).

- **`loom appgen` — brownfield-aware, four-stage pipeline (foundation for AI-driven appgen).**
  `appgen` now *scans the existing app* and applies a **delta** rather than only scaffolding from
  scratch. Four stages, all deterministic and offline: **scan** (`scanApp(dir) → AppModel`,
  a compact TS-AST summary of flows/steps/gates — never raw file dumps), **plan**
  (`planChangesDeterministic(intent, appModel) → ChangeSpec`, tagging each capability/step
  `create` / `extend` / `modify`), **apply** (`applyChanges` → creates via the existing templates,
  surgical formatting-preserving edits to existing flows), and **validate** (in-process `tsc`).
  The plan stage is the single seam where NL understanding lives and it emits a structured
  `ChangeSpec` — a local model can be swapped in here later without touching codegen.
  - **Plan → diff → confirm DX.** `--dry-run` renders a terraform-style plan (creates / edits /
    skips) and writes nothing; omit it to apply. `--check` typechecks the app after applying.
  - **Safety gate.** appgen only overwrites a handler body that still hashes to the generated
    `TODO` stub; any human-edited handler is **insert-only**, never clobbered (`FlowEditor`,
    content-hash gate). Brownfield edits add step consts, register them in the flow's `steps: []`
    array, and insert approval / UI gates into the runner while preserving surrounding code.
  - **Replayable spec lockfile.** Each apply records the accepted `ChangeSpec` to
    `.loom/appgen/<timestamp>.spec.json`; `loom appgen --from-spec <file>` reproduces it
    byte-for-byte with no model — the appgen equivalent of a golden log.
  - `@loom/appgen` stays zero-dependency and offline (only `typescript` promoted to a runtime
    dep for the AST scan/edit); the framework kernel is untouched. New exports: `scanApp`,
    `planChangesDeterministic`, `applyChanges`, `FlowEditor`, `typecheck`, lockfile helpers.

- **`@loom/appgen-model` — optional local-Gemma planner (truly AI-driven appgen).** A new,
  **optional** package that swaps a small on-device Gemma model into appgen's single NL stage.
  `loom appgen --model <gguf>` plans the `ChangeSpec` with the model instead of the grammar
  parser — real language understanding, no token cost, minimal footprint. Everything downstream
  is unchanged, because the model still emits only a `ChangeSpec`.
  - **Grammar-constrained JSON.** Output is constrained to the `ChangeSpec` JSON schema via
    node-llama-cpp, so a compact model reliably produces valid, on-schema plans.
  - **Reasoning-ladder-on-itself.** Planning runs through `@loom/reasoning`'s cheap-first
    elevation ladder with a *validator* confidence signal ("does it parse into a usable
    ChangeSpec?"); a weak tier that emits junk elevates to a stronger one, and each elevation is
    logged (P9) and recorded in the spec lockfile. Recommended tiers: Gemma **E4B** 4-bit QAT
    default (~5 GB), E2B floor (~4 GB), 12B ceiling (~8 GB), selectable via `--model-tier` /
    `--model-big`.
  - **Deterministic fallback / footprint discipline.** Falls back to the deterministic parser
    when the model or `node-llama-cpp` is unavailable or every tier fails (same as `--offline`);
    loads/disposes the model per invocation (transient, not resident); prompts carry only the
    compact scanned `AppModel` summary, never raw file contents.
  - `node-llama-cpp` is an `optionalDependency`, lazily imported; `@loom/cli` loads
    `@loom/appgen-model` only when `--model` is passed, so neither the framework nor default CLI
    users carry the native runtime. Kernel and existing packages untouched.
  - **Verified end-to-end against a real Gemma GGUF (node-llama-cpp 3.19, Metal), which fixed four
    bugs that previously made `--model` silently fall back every time:** (1) `tsc` under
    `module: CommonJS` down-levelled dynamic `import()` to `require()`, which cannot load the
    ESM-only, top-level-await node-llama-cpp (`ERR_REQUIRE_ASYNC_MODULE`) — now a genuine dynamic
    import is preserved via `new Function` in both `GemmaProvider` and the CLI; (2) the v3 grammar is
    built with `llama.createGrammarForJsonSchema(schema)`, not the `LlamaJsonSchemaGrammar`
    constructor; (3) the CLI now resolves the optional `@loom/appgen-model` peer **from the target
    project dir** (`pnpm add @loom/appgen-model node-llama-cpp` in your app), not from the CLI itself;
    (4) the JSON-schema `minItems` constraint crashed node-llama-cpp's native sampler and was removed
    (an empty plan is rejected by the ladder validator instead). Generation is now bounded
    (`maxTokens` 512, `contextSize` 2048) for footprint and native stability. The package README
    documents environment requirements: a Node 20/22 LTS (bleeding-edge Node majors show intermittent
    native segfaults) and enough RAM for the tier (the E4B default is ~5 GB; a 2B model that fits 8 GB
    is often too weak and degrades to the deterministic parser).

- **`loom appgen` completeness — delete/grant ops, runner wiring, self-repair, real diffs, confirm.**
  Closes the remaining gaps against the requirement (captured in
  [`docs/requirements/2026-07-12-ai-native-brownfield-appgen.md`](docs/requirements/2026-07-12-ai-native-brownfield-appgen.md)
  + evaluation, and [ADR 0042](docs/adr/0042-ai-native-brownfield-appgen.md)):
  - **`delete` op.** New grammar `delete <name>` / `delete step <s> from <flow>`; deletes generated
    flow files and removes steps (const + `steps: []` entry + runner call). Refuses to delete a flow or
    step that carries hand-written code. Tracked in `FilePlan.deletes`, honored by `--dry-run`.
  - **New steps are wired into the runner.** `FlowEditor.addStep` now inserts a `ctx.run(<step>, …)`
    call before the runner's `return`, not just a "wire it yourself" note.
  - **`wireGrants` → `app/config.ts`.** New grammar `grant <tool>[, <tool>] to <cap>` (and a model
    schema field) insert a `GrantTable` authorizer (and its import) into `defineConfig` via a
    formatting-preserving `ConfigEditor`; it declines to guess a merge if an authorizer already exists.
  - **Model self-repair loop.** `@loom/appgen-model` now runs `validateChangeSpec` (does the plan
    reference real flows/steps with the right ops?) after the ladder and re-prompts the model with the
    exact issues (bounded retries) before falling back to the deterministic parser.
  - **Real `--dry-run` diffs.** Edits render as a dependency-free unified line diff instead of a summary.
  - **Interactive confirm.** On a TTY (and without `--yes`), appgen shows the plan and asks before
    writing; the CLI surfaces the planner (deterministic vs model) and any ladder elevations.
  - Docs: `docs/usage-cli.md` rewritten for the full surface; a brownfield walkthrough at
    `examples/appgen-brownfield/README.md`. `@loom/appgen` stays offline; kernel untouched.
  - **Planner provenance surfaced + loud model fallback.** The plan header and `--dry-run` output are
    tagged `[deterministic]` / `[model]` (with any `[model, elevated e4b→12b]` ladder steps), matching
    the spec lockfile's `changeSpec.planner`. When `--model` is passed but the model can't produce a
    usable plan, `appgen` now prints a **loud warning** and falls back — so a silent, wrong-looking
    generation no longer masquerades as a model result. Also fixed `--model` failing in-repo with
    "Cannot find package '@loom/appgen-model'": the CLI now resolves the optional peer as a sibling of
    `@loom/appgen` (works in `packages/*` and `node_modules/@loom/*` alike).
