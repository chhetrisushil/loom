# ADR 0130 — Refuse to deliver a sealed payload to a flow that cannot open it

- Status: **Accepted** (2026-10-12) — user approved the kernel guard 2026-10-12; implemented.
- Date: 2026-10-12
- Origin: review of loom #575 (the r2-erasure flake).
- Builds on: [ADR 0110](0110-durable-inbox-and-receive-select.md) (the durable inbox, D9 erasure marker), ADR 0085 (bounded untrusted-content walks).
- Placement: **kernel** (`@loom/workflow-runtime`, the inbox delivery path). Not `@loom/plugin-crypto`.
- Version impact: none. No event kind is added or changed, so `EVENT_SCHEMA` stays 1.24.0; no SPI signature or semantics change (`EVENT_STORE_SPI`, `SNAPSHOT_STORE_SPI`), `KERNEL_ABI` and the wire vectors are unchanged. The only public additions are the error class `SealedPayloadUnreadableError` and its classification. (The 2026-10-14 residuals below add one coordinated bump, `EVENT_SCHEMA` 1.25.0 and `EVENT_STORE_SPI` 2.5.0.)

## Context

`@loom/plugin-crypto` seals fields of an inbox message (`INBOX_MESSAGE.payload`, and the copy in `MESSAGE_CONSUMED.payload`) inside `EncryptingEventStore`, at the store boundary: `{ __loomEnc: "loom/aes-256-gcm", ... }` replaces the plaintext on append and is opened again on read. A node whose store is NOT configured to open that path (a different `sensitive` map, or no crypto plugin at all) reads the same stream through its raw store. Before this ADR it then:

1. handed the flow the envelope as if it were the user's payload, and
2. journaled the envelope as the `MESSAGE_CONSUMED` payload,

so the corruption was durable and replayed deterministically. Nothing refused it. (`__loomEnc` appeared in the kernel only in `blankStream.ts`, a diagnostic.)

## Decision

### D1 — Placement: the kernel, not a 1P crypto check

The failing case is a node that does not have the crypto plugin, or has it configured differently. A check shipped in the plugin cannot run on a node that does not load the plugin, so it cannot protect exactly the node that needs protecting. The inbox delivery path is kernel code that every node runs. The guard is fail-closed, adds no dependency (it recognises the envelope by SHAPE, an own `__loomEnc` key, and knows nothing about keys or ciphers), and the kernel already walks untrusted payloads elsewhere. Kernel placement is the one that holds when the plugin is absent.

### D2 — The invariant

> A message whose payload contains a sealed envelope after the store has had its chance to open it is never delivered to a flow and never journaled as `MESSAGE_CONSUMED`.

At delivery time every envelope the node's store recognised has already been opened on read, so an envelope that survives is by construction "sealed and not openable here".

**What "contains" means.** The sealed paths are configuration (`pathsFor` / `mapPaths` in `EncryptingEventStore` accept nested paths such as `payload.secret`, and the default inbox registration is the whole `payload`). The kernel cannot know a given deployment's paths, so the guard looks for a plain object with an OWN `__loomEnc` key whose value is a STRING (the algorithm id) at the top level or at any depth, in objects and arrays. Inherited keys do not count, and neither does a non-string value (`{ __loomEnc: 1 }` is an ordinary payload): the predicate stays algorithm-independent (it never reads WHICH algorithm) and has fewer false positives. A caller that must relay FOREIGN ciphertext (a `__loomEnc` string key it did not produce) wraps it as a string, for example `JSON.stringify(envelope)`.

**Bounded walk.** Iterative and breadth-first (a shallow envelope is found before any budget matters, and depth cannot blow the stack), capped at `SEALED_WALK_BUDGET` = 100 000 visited nodes, the same budget as `blankStream`'s `carriesKey`. Exhausting the budget (a huge, very deep, or cyclic in-process payload) is NOT "clean": the guard fails closed and treats it as unverifiable (`SealedPayloadUnreadableError.unverifiable`).

### D3 — One shared check, every delivery site

`assertDeliverable(executionId, message)` in `inbox.ts` runs BEFORE any `MESSAGE_CONSUMED` is built, at both sites that consume an inbox message into a flow:

- `WorkflowContext.satisfyFromInbox` (the live run; closure 1 of the lost-wakeup protocol), and
- `WorkflowRuntime.notifyAttempt`'s scan (the notify path: the post-park re-read `afterInboxPark`, `TimerService`, `recoverAbandoned`, the send wake).

Every `MESSAGE_CONSUMED` append was audited. The others write no user payload: the operator discard (`discardInbox`, D8) and the TTL expiry (D10a) journal `payload: null`, and a duplicate delivers nothing (its payload is not copied), so they need no check. An operator discard is deliberately still allowed on a sealed message: it is the escape hatch for a message nobody can open.

### D4 — Park, do not fail; refuse the attempt, not the execution

Every site leaves the message (or the execution) as it was and appends nothing. What the flow sees differs by site, and in none of them does the execution fail:

- **Live run:** the flow stays parked on its receive. Failing the execution would make the refusal permanent (`EXECUTION_FAILED` is terminal), destroying exactly the "stay available for a correctly configured node" property. The run parks normally; the post-park notify pass raises the typed error.
- **Notify path:** `SealedPayloadUnreadableError` is thrown to the caller, which already routes errors to `onStorageError` / `TimerService.onError` / `recoverAbandoned`'s `onError`. The park and the inbox are untouched. The notify pass also writes the durable `INBOX_WAKE_AT` row (whichever caller got there: the post-park read, a send's wake, a timer poll), so a node configured to open the payload picks the message up on its next poll without waiting for a new `send`.
- **Replay:** `ctx.select` / `ctx.receive` serves a RECORDED inbox answer from the folded `_waitAnswers`. If that recorded payload is still a sealed envelope on this node (a capable node journaled it sealed in `MESSAGE_CONSUMED`; this node reads the raw log), the flow is NOT handed the ciphertext. The attempt is refused: the context latches the refusal and seals its journal, so even a flow that swallows the rejection cannot append, complete or park on it, and the context is also frozen like a park: no NEW tool call, effect, decision or child start is dispatched after the refusal (a swallowing flow's later `ctx.run` simply never starts); the runtime rejects the handle with the typed error (`recorded: true`) and writes nothing, in particular no `EXECUTION_FAILED`. The execution stays where it was (a resume of an unrelated gate on that node already appended its own `EXECUTION_RESUMED`, so it reads `running`) for a capable node, which sees plaintext after decryption, passes the check and completes it via `recoverAbandoned` or the next resume. Old logs are unaffected: a plaintext answer is `clean`, so replay on any node is identical to before.

**Head-of-line blocking is per EXECUTION, not per topic.** The live `return delivered` and the notify path's throw both abort the whole scan for that execution, not just the sealed message's topic. A sealed head message therefore holds every topic of that execution for this node until a capable node consumes it or an operator discards it. This is deliberate: skipping the sealed topic and delivering another would let two nodes with different crypto configuration pick different `select` branches (and so different journaled histories) for the same execution. Delivery is FIFO per topic and a cursor cannot skip, so skipping would also silently reorder or lose the sealed message.

**Back-off on an incapable node.** `TimerService.fireInbox` catches `SealedPayloadUnreadableError` and applies an exponential back-off (the re-drive schedule, no attempt cap) that NEVER retires the row, because capable nodes still need it. `onError` is reported on the first refusal and then every 16th, not on every poll. The per-execution back-off map is bounded (1024 entries, oldest evicted); beyond that cap it degrades to periodic polling rather than growing. `recoverAbandoned` treats a refused re-drive like a diverged one: it counts it as `failed` (never `recovered`, no `onRecovered`), reports it through `onError` on the first refusal and then every 16th, and skips that execution on this node for an exponential back-off window (same bounded map, same degradation).

### D5 — The error

`SealedPayloadUnreadableError(executionId, messageId, topic, unverifiable = false)`. Ids only; the message text and fields never carry the ciphertext. It is classified **TERMINAL** in `packages/agent/src/toolFailure.ts` (and its fitness test): retrying on the same node cannot help, and a model must not be told to "try again" by an `isError` result.

### D6 — The ingest rule (`send`)

`send` refuses a payload that contains an `__loomEnc` envelope, with `InboxMessageRefusedError`, before anything is appended, like the forged `$shredded` marker. The walk runs over `JSON.parse(json)`, the same JSON the store persists and the `$shredded` check reads (a `toJSON` can mint an envelope the live object does not show), and AFTER the byte-size check so the parse is bounded. Why this layer and why it is unconditional: sealing happens inside the event-store wrapper at append, AFTER `send` has run, so at `send` time a raw user payload carrying `__loomEnc` is always forged (or relayed ciphertext read through a raw store). A genuine seal can only be produced by the configured store, below `send`. Without the rule a sender could plant an envelope that is indistinguishable from a real seal at delivery, and the guard would be a denial-of-service lever (park any execution's topic) instead of a safety net. A payload too large or deep to check inside the budget is refused as well (fail closed); the default `inboxMaxPayloadBytes` (64 KiB) is far below the budget, so this only bites a raised limit.

Residual: a writer that bypasses `send` and appends to the reserved inbox stream directly is below the kernel's authority (the stream is kernel-owned; only `send` writes it).

## Consequences

What is guaranteed, and what is not:

- **Guaranteed.** A node that cannot open a sealed inbox payload never delivers the ciphertext to a flow and never journals it, on any of three paths: a live consume, a notify-path consume, and a replay of an answer a capable node already journaled. In each case it appends nothing, never fails the execution, and leaves it consumable by a capable node (a durable `INBOX_WAKE_AT` row exists for the notify-path and live refusals, written by `notifyPass`/`markContended`; a PURE replay refusal in `run()` writes no row, the execution is `running`, and it relies on `recoverAbandoned` or the next resume on a capable node). A forged envelope cannot be planted through `send`.
- **Mixed fleet.** "A mixed fleet can no longer corrupt a log" holds for the `INBOX_MESSAGE` and `MESSAGE_CONSUMED` payloads this ADR guards. It is NOT a claim about every sealed field.
- Cost: one bounded walk per delivered (non-duplicate) message, per replayed inbox answer, and per `send`.

Residuals, named:

1. **Other sealed event kinds on an incapable node.** Any other kind a deployment seals through `sensitive` (a step input or output, `EXECUTION_STARTED.input`, an effect result, and so on) is read raw by an incapable node and is not checked by this guard; the kernel cannot tell an app's own field from a sealed one except by this shape, and only the inbox delivery path is a choke point. Run such kinds only on capable nodes.
2. **The snapshot store.** A snapshot holds the folded state, including `_waitAnswers`. A capable node checkpoints PLAINTEXT there, so a snapshot store shared with an incapable node hands that node the plaintext (it passes the replay check, correctly, but the plaintext is at rest unencrypted: already documented in `docs/compliance.md`). Conversely a snapshot that holds a SEALED answer is caught by the replay check like any other. Give snapshots the same encryption as the log, or do not share a snapshot store across differently configured nodes.
3. **A pre-existing plaintext payload carrying a string `__loomEnc` key.** `send` now refuses it, but one journaled before this ADR would be refused on replay forever. No such payload is expected (the key is the crypto plugin's envelope marker).
4. **Head-of-line blocking is per execution** (D4), until a capable node consumes the message or an operator discards it.
5. **A writer that bypasses `send`** (D6).

## Residuals (Accepted 2026-10-14 (user))

- Status: **Accepted 2026-10-14 (user)**. The user chose the stronger option for each residual (marked **Chosen** below); the other options stay as considered-and-rejected with the reason "user chose the stronger option". The analysis is kept as written when the residuals were Proposed. Nothing here is implemented yet: the design is under "Accepted design" and the slices are in `.superpowers/plans/2026-10-14-adr-0130-residuals.md` (local, not committed).
- Version impact (ONE coordinated bump, reserved first): `EVENT_SCHEMA` 1.24.0 -> **1.25.0**, `EVENT_STORE_SPI` 2.4.0 -> **2.5.0**. `SNAPSHOT_STORE_SPI` (1.1.0) and the wire vectors are unchanged; `KERNEL_ABI`: unchanged (no syscall; to be confirmed by the reservation slice).
- Scope: the four residuals logged after #576 merged (this ADR's own residuals 1, 2 and 4, plus a gap in the replay refusal's wake). Residuals 3 and 5 above stand as written.
- Placement bias: outward (ADR 0083, the triage rule). Each residual gets a verdict.
- Version batching: loom batches kernel bumps. Only the bumps an option NEEDS are listed; "none" means no `EVENT_SCHEMA`, `EVENT_STORE_SPI`, `SNAPSHOT_STORE_SPI`, `KERNEL_ABI` or wire-vector change.

### R-a — Other sealed event kinds on an incapable node

**Confirmed.** `assertDeliverable` is called at exactly two sites, `packages/workflow-runtime/src/WorkflowContext.ts:2114` (live consume) and `packages/workflow-runtime/src/WorkflowRuntime.ts:4933` (notify scan), plus the replay check at `WorkflowContext.ts:1936` (recorded INBOX answers only, `arm.kind === "inbox"`). Nothing else looks for an envelope. `EncryptingEventStore` seals any event type named in its `sensitive` map (`plugins/crypto/src/EncryptingEventStore.ts:86` `pathsFor`, `:162` append, `:385-415` read and subscribe), and the kernel itself registers kernel-authored kinds: `defineConfig` seals `EXECUTION_STARTED.principal.identity.*` and `OUTCOME_RECORDED.recordedBy` (`packages/app/src/principalPolicy.ts:99-101`). The other places a recorded value reaches a flow are therefore unguarded: `STEP_COMPLETED.output` served on replay (`WorkflowContext.ts:859/887/1077` write it, replay serves it), the `EXECUTION_STARTED.input` handed to the flow, effect and decision results, human-step answers.

**Minimal repro (describe only).** Node A: `EncryptingEventStore` with `sensitive: { STEP_COMPLETED: ["output"] }`; run a flow `const s = await ctx.run(tool); await ctx.receive("go"); return s` to the park. Node B: same stream through a RAW store, `resume`/`recoverAbandoned` after `send("go")`. B replays the recorded step, `s` is `{ __loomEnc: "loom/aes-256-gcm", ... }`, the flow completes, and `EXECUTION_COMPLETED.output` journals the envelope (or a downstream step is invoked with ciphertext as input). Variant with the principal: B reads `principal.identity.tenant` as an envelope object; whether authz fails closed depends on the policy comparing a string to an object (not verified here, it needs a test before anyone relies on it).

**Severity.** Correctness plus integrity of the log, not confidentiality (ciphertext is shown, never plaintext). It is the same durable-corruption class D2 closed for the inbox, so the "mixed fleet can no longer corrupt a log" claim is bounded to two event kinds today. Kernel-authored sealed kinds (principal, outcome) are the part that cannot be handled by "run such kinds only on capable nodes", because `defineConfig` opted the app in without the operator choosing the kind.

**Options.**

1. *Document only.* **Rejected: user chose the stronger option.** Keep Consequences residual 1; add the principal and outcome kinds to `docs/compliance.md` as "mixed fleets must be homogeneous in `security.crypto`". Free; leaves a footgun the kernel itself arms.
2. *Generalise the replay and fold guard to every recorded value.* **Rejected: user chose the stronger option** (its shape sniffing is superseded by the marker; the D2 shape guard stays as the fallback for unmarked streams). One check on the fold input: when the kernel hydrates an event for a VM, any envelope in a kind that is not the inbox raises `SealedPayloadUnreadableError` (`recorded: true`) from the fold or the VM seed, refusing the whole attempt like the replay refusal. Kernel, because only the kernel sees every read. Cost: a bounded walk per event folded, which is O(total payload bytes) on every fold and replay (not per delivered message), so it needs a cheap pre-filter (substring test for `__loomEnc` on the already-serialised JSON where the store keeps it) or a per-execution "checked up to seq" watermark. False positives: an app payload with a string `__loomEnc` key (residual 3) would be refused on EVERY kind. No version bump if it only refuses; a new error context field is additive.
3. *Capability handshake instead of shape sniffing.* **Chosen (user, 2026-10-14).** The store declares what it seals; the runtime refuses to start an execution (or resume one) whose stream header says "sealed under config X" unless this node has X. Needs a stream-level sealed-config marker (a new field on `EXECUTION_STARTED` or a metadata record) and a decorator capability bit. Fixes the class properly and also covers (b) partially, but is a durable-format change: `EVENT_SCHEMA` minor bump (and `EVENT_STORE_SPI` minor if the marker lives in store metadata, as the ADR 0129 incarnation anchor did). It is also the largest option and has no consumer asking.

**Placement.** Option 2 is kernel (read-path choke point; same argument as D1). Option 3 is kernel plus 1P (`@loom/plugin-crypto` writes the marker). Option 1 is docs.

**Recommendation (superseded by the user's decision: Option 3).** Option 2, scoped to the kernel-authored sealed kinds first (`EXECUTION_STARTED` principal and `OUTCOME_RECORDED`), because those are sealed without the operator choosing them. Keep the arbitrary-kind case as documented (Option 1) until a deployment names a second kind; revisit Option 3 only if the user wants the marker for (b) too. Bumps: none for the scoped Option 2 (it adds a refusal, no event shape); `EVENT_SCHEMA` 1.25.0 (+ `EVENT_STORE_SPI` minor) only if Option 3 is chosen.

### R-b — An unencrypted shared snapshot store holds plaintext of sealed content

**Confirmed, but narrower than first logged.** An encrypting snapshot decorator already exists (`plugins/crypto/src/EncryptingSnapshotStore.ts`, `sensitive` dot-paths into the folded `ExecutionState`, same subject key as the events, so a shred erases both). The gap is that it is opt-in and the kernel does not check it on the ordinary path:

- `WorkflowRuntime.ts:6519` and `:7009` call `snapshotStore.save(...)` with the decrypted fold (checkpoint on settle, periodic) whatever the snapshot store is.
- The only cross-check is `LogLifecycle.ts:155`, which refuses COMPACTION when the event store encrypts but the snapshot store does not share its `KeyStore`. A plain checkpoint is not checked.
- `docs/compliance.md:203-206` documents that `variables._waitAnswers` is keyed by a dynamic `waitId`, "which a sensitive path cannot name", so even an `EncryptingSnapshotStore` configured with static paths does not seal a recorded inbox answer. The fix named there is "seal the whole state", which `EncryptingSnapshotStore` does not offer (it maps declared paths only).

**Minimal repro (describe only).** Node A: `EncryptingEventStore` with `INBOX_MESSAGE`/`MESSAGE_CONSUMED` payload sealed, plain `InMemorySnapshotStore`. Run a flow that receives a secret and settles. `snapshotStore.loadLatest(id)` returns state with `variables._waitAnswers.<waitId>.payload` in clear. Shred the subject: the event log is unreadable, the snapshot still serves the secret (and node B, incapable, replays from the snapshot, passes the D4 check because it is plaintext, and completes).

**Severity.** Confidentiality, and erasure-theater (K10.2/A1 is the same hole for static paths, closed by `EncryptingSnapshotStore`). Not a liveness or corruption issue. For the guard itself it is benign (an incapable node served plaintext is correct), so it is a compliance gap rather than a hole in D2.

**Options.**

1. *Document and doctor.* **Chosen, together with 2 and 3 (user, 2026-10-14: BOTH 1P and kernel).** Keep the compliance note; add a `loom doctor` finding (structural `keys` property check already exists, `packages/event-runtime/src/installOptional.ts:28`) "event store seals X but snapshot store does not share the KeyStore". Outward, no kernel change, no bump.
2. *Whole-state sealing mode in `EncryptingSnapshotStore`.* **Chosen (user, 2026-10-14).** A `sensitive: "all"` (or `sealState: true`) option that encrypts `variables._waitAnswers` and the other dynamic-key containers wholesale under the subject key. 1P plugin change; the snapshot payload stays an opaque `ExecutionState` to the store contract, so no SPI change if the decorator re-presents the same shape on load. Cost: snapshots lose partial readability (tooling that inspects `variables`), and a load needs the key (already true for static paths).
3. *Kernel refuses the plaintext checkpoint.* **Chosen (user, 2026-10-14); it is a behaviour change.** At `snapshotStore.save` the runtime refuses (or skips the save) when `security.crypto.events` is composed and the snapshot store lacks the shared `KeyStore`, generalising `LogLifecycle.ts:155` to every save. Kernel behaviour change: a deployment that today checkpoints plaintext starts failing or losing checkpoints (a skip is safe for correctness but regresses read cost). No bump; a behaviour change needing a CHANGELOG "Changed" entry.

**Placement.** Option 1 and 2: 1P (`@loom/plugin-crypto`, `loom doctor`). Option 3: kernel, but the kernel only enforces "same KeyStore", never the cipher.

**Recommendation (superseded: the user chose 1, 2 AND 3).** Options 1 and 2 together, no kernel change; defer Option 3 unless the user wants fail-closed by default (it is the only option that makes the unsafe configuration impossible rather than detectable, and it changes behaviour for existing deployments). Bumps: none for 1/2/3 (`SNAPSHOT_STORE_SPI` unchanged because the shape is preserved).

### R-c — Head-of-line blocking is per execution

**Confirmed, and designed.** `WorkflowContext.ts:2116` (`return delivered`) abandons the whole scan, and `WorkflowRuntime.ts:4933` throws out of the whole notify scan; the scan loop covers every topic of the execution (`for (const w of waits)` at `:4925-4932`), so a sealed head on topic A holds topic B's deliverable messages. D4 gives the reason: skipping would let nodes with different configs pick different `select` branches.

**Repro (describe only).** Execution parks on `select([receive("a"), receive("b")])`; `send("a", sealedUnderNodeA)` then `send("b", "plain")`. Capable node A consumes `a` (lowest `inboxSeq`) and completes the select with arm `a`. Incapable node B refuses the scan and never delivers `b`: correct, since delivering `b` on B would diverge from A's branch.

**Severity.** Liveness only, on the incapable node only; capable nodes are unaffected and the log is never corrupted. The harm is a fleet whose only runner of an execution is incapable (a misconfigured deploy): the execution stalls behind a message nobody can open, with an `onError` every 16th poll and an operator escape hatch (`discardInbox`, D3; TTL expiry D10a if configured).

**Why most options are unsound.** Skipping a sealed topic is unsafe for the reason in D4. A weaker rule, "block only messages with a higher `inboxSeq` than the sealed one", is already what FIFO plus a deterministic first-answered-arm gives for a single `select`; it does not unblock any case that is not already blocked by that ordering, so it buys nothing.

**Options.**

1. *Document and accept (WONTFIX in the kernel).* Head-of-line semantics are KEPT (user, 2026-10-14); the document-only stance is **rejected as the whole answer: user chose the stronger option** (keep + quarantine). Name it as designed (already Consequences residual 4); point operators at `discardInbox` and the journaled TTL. Zero change.
2. *Observability, no semantics change.* Kept as a by-product (the quarantine slice emits the blocked-state data); a standalone analytics advisory is not part of this decision. Surface a stuck-behind-sealed state: an `onError` payload carrying the blocked topics and the sealed message's age, and an analytics advisory (`@loom/analytics`, advisory per ADR 0034) "execution X blocked behind sealed message M for > T". 1P, no bump.
3. *Operator quarantine verb.* **Chosen (user, 2026-10-14).** A first-class `quarantineInbox` that journals the sealed message as a dead letter (`MESSAGE_CONSUMED` with `payload: null` plus a reason) so the head clears while preserving the audit trail, an explicit, human-triggered version of the existing discard. Possibly already expressible by `discardInbox` with a reason; if a new reason value is needed it is an additive field. Kernel only if a new journaled reason is required (`EVENT_SCHEMA` minor), otherwise no bump.

**Placement.** 1: docs. 2: 1P analytics. 3: kernel if it adds a journaled reason, else a recipe over `discardInbox`.

**Recommendation (superseded: keep the semantics AND add the quarantine verb).** WONTFIX the semantics (Option 1) and do Option 2 so the state is visible; do Option 3 only if `discardInbox`'s journal does not already record who discarded and why (check before proposing a schema bump). Bumps: none for 1/2; `EVENT_SCHEMA` minor only if 3 needs a new reason value.

### R-d — A replay refusal writes no wake row

**Confirmed.** `markContended` (`WorkflowRuntime.ts:4861`) is reached only from `notifyPass`'s catch (`:4847`), i.e. the notify path. The replay refusal is raised inside `run()` (`WorkflowContext.ts:1936-1945`, handled `WorkflowRuntime.ts:6874-6885`), which warns, rejects the handles and returns: no `timerStore.schedule`, no event. The execution is left `running` (an unrelated resume already appended `EXECUTION_RESUMED`) or whatever it was. The ADR already admits this (Consequences, "a PURE replay refusal in `run()` writes no row").

What recovers it today: `recoverAbandoned` on a capable node (`recoverAbandoned.ts:280`, `status` running or pending), but that needs an app to run the sweep with an `isAbandoned` predicate or a lease store (`recoverAbandoned.ts:60-75`, the predicate is REQUIRED with no default), and the staleness window must elapse. The incapable node's own sweep skips it for a back-off window (`:392`, `:491`).

**Minimal repro (describe only).** Capable node A journals `MESSAGE_CONSUMED` with a sealed `payload`, then crashes before the next step; the execution is `running`. Incapable node B resumes (`resume` of any gate, or a sweep): replay hits `WorkflowContext.ts:1936`, B refuses; no timer row exists. Node A is later redeployed capable but no `send`, no timer, no resume arrives, and the app runs no sweep: the execution sits `running` indefinitely.

**Severity.** Liveness, narrow: needs a mixed fleet AND no sweep on a capable node. Not a confidentiality or correctness issue.

**Options.**

1. *Document that a sweep is the contract.* **Rejected: user chose the stronger option.** State that a deployment with an incapable node must run `recoverAbandoned` on a capable node; no code.
2. *Write the durable wake on a replay refusal too.* **Chosen NOW (user, 2026-10-14).** In the `run()` catch at `WorkflowRuntime.ts:6874`, call `markContended(executionId)` (same best-effort `.catch(onStorageError)`). Then `TimerService`'s inbox poll (`INBOX_WAKE_AT`) re-drives it on any node. But the wake row's job today is to trigger the NOTIFY scan for a PARKED execution; for a `running` execution the notify path may find no unanswered park and retire the row, so the row alone does not re-run the flow. Either the poll must learn to `resume`-redrive a running execution carrying the row, or the row must be paired with a distinct reason. Kernel, small, no event change; needs a decision on what the poll does with a `running` execution (this is why it is not a one-liner).
3. *Park the execution on the refusal.* **Rejected** (breaks "appends nothing"; also user chose Option 2). Instead of leaving it `running`, journal a reserved park (like `FLOW_DIVERGED_GATE`, ADR 0113) so it is `suspended` and every existing wake path (notify, timers, `recoverAbandoned`'s parked-execution notify pass) applies. Strongest liveness, but it appends an event on a refusal, which contradicts D4 "appends nothing" and the property that an incapable node never writes about an execution it cannot read; it also adds a reserved gate name (`EVENT_SCHEMA` minor if the gate is a new journaled condition kind, none if it reuses `SuspendError` with a reserved `on`). Highest risk.

**Placement.** Kernel (1: docs).

**Recommendation (superseded: Option 2 now).** Option 2 only after the poll semantics for `running` executions are decided; until then Option 1 plus a `recoverAbandoned` recipe in `docs/` naming this case. Reject Option 3 (breaks the appends-nothing rule). Bumps: none for 1 and 2; `EVENT_SCHEMA` minor only for 3.

### Summary of decisions (user, 2026-10-14)

| Residual | Real? | Decision | Placement | Bumps |
|---|---|---|---|---|
| R-a other sealed kinds | yes, incl. kernel-authored principal/outcome | stream-level capability marker written by the crypto plugin, checked before fold/replay | kernel + `@loom/plugin-crypto` | `EVENT_SCHEMA` 1.25.0 + `EVENT_STORE_SPI` 2.5.0 (shared) |
| R-b plaintext checkpoints | yes | BOTH: `loom doctor` + whole-state `EncryptingSnapshotStore`, AND the kernel refuses a plaintext checkpoint when the event store seals | 1P + kernel | none beyond the shared bump |
| R-c head-of-line | yes, by design | keep the semantics; add an operator quarantine / release pair | kernel | `EVENT_SCHEMA` 1.25.0 (shared) |
| R-d no wake on replay refusal | yes | write the wake row now; the timer poll re-drives a `running` execution that carries one | kernel | none |

## Accepted design (2026-10-14)

Everything below is design; no code exists yet. One coordinated version bump carries all schema and SPI changes, reserved FIRST (slice S1, the W2-0 pattern: freeze the shapes, ship the constants, the reserved fold handlers and the optional SPI method with no behaviour, then the behaviour slices fill them in). `docs/` registries (compatibility matrix, spec section, cheatsheet, usage strings) are updated in slice S1, not in this ADR PR.

### D7 (R-a) — The capability marker: per-envelope `metadata.seal`, no new event

**Where it lives.** The kernel assigns sequence numbers, so the crypto plugin cannot insert a marker EVENT into a stream, and a store-side side table would not commit atomically with the sealed row (a crash between them leaves sealed data unmarked, the worst failure). The marker therefore rides ON the sealed envelope, in `EventEnvelope.metadata` (an existing open `Record<string, unknown>`), written by `EncryptingEventStore` in the SAME append that seals the fields:

```ts
// EventEnvelope.metadata.seal  (EVENT_SCHEMA 1.25.0, reserved key)
interface SealMarker {
  v: 1;
  cipher: string;            // e.g. "loom/aes-256-gcm" (the algorithm id the envelopes carry)
  covers: readonly string[]; // sorted, deduped "EVENT_TYPE.dot.path" entries actually sealed in THIS envelope
}
```

It is stamped on exactly the envelopes in which at least one field was sealed (not on every envelope of an encrypting node), so `covers` is exact, never stale after a config change, and carries no key material, key id or subject. "Stream-level" is the aggregate: a stream is sealed iff any of its envelopes carries `metadata.seal`. This covers every kind the node seals through `sensitive`, including the ones `defineConfig` registers itself (`EXECUTION_STARTED.principal.identity.*`, `OUTCOME_RECORDED.recordedBy`) and `STEP_COMPLETED.output`, with no per-kind kernel code: the marker is derived from what was actually sealed.

**The SPI (EVENT_STORE_SPI 2.5.0, optional, additive).**

```ts
interface SealingCapability {
  readonly cipher: string;
  /** Every "EVENT_TYPE.path" this node's store seals AND therefore opens. */
  readonly covers: readonly string[];
  /** True iff this node can open an envelope stamped with `marker` (same cipher, every entry of marker.covers is opened here). */
  opens(marker: SealMarker): boolean;
}
interface EventStore {
  /** 2.5.0. Absent, or returning undefined: this store seals nothing and opens nothing. */
  sealingCapability?(): SealingCapability | undefined;
}
```

Listed in `OPTIONAL_EVENT_STORE_METHODS`, so every decorator must forward, override or refuse it (compile error otherwise): plain decorators forward; `EncryptingEventStore` overrides it from its `sensitive` map (live, so `registerSensitive` is reflected); `ShardedEventStore` returns the capability only if every shard agrees (the intersection of `covers`), else undefined. A store that does not claim 2.5.0 simply lacks the method: that IS the fallback, and it means "incapable", which is the correct reading for a store that cannot open sealed data. Conformance: `runEventStoreConformance(..., { eventStoreSpi: "2.4.0" })` skips the new cases (the ADR 0129 option).

**The check (kernel, before fold and replay).** `assertStreamReadable(executionId, events, store)` is called at every funnel through which stored envelopes reach the fold or the VM seed (the implementer enumerates them; a fitness test pins the list, in the style of `testTimeoutGuard`): for each envelope with `metadata.seal`, if `store.sealingCapability?.()?.opens(marker)` is not true it throws `SealedStreamUnreadableError(executionId, sequence, covers)` before anything is folded, handed to a flow, journaled or authorised against. Cost is O(1) per envelope (a property read), not a payload walk, so it also replaces the pre-filter worry of the rejected shape-sniffing option. It runs BEFORE authz reads the principal (`ownerForAuthz` reads `first`), so a sealed principal on an incapable node can never be judged: the S0 test first establishes what happens today; the marker makes the answer "refused" by construction, and S0's test then pins it as a regression.

**The error.** `SealedStreamUnreadableError` and the existing `SealedPayloadUnreadableError` extend a common base `SealedUnreadableError` (ids and the marker's `covers` only, never ciphertext). Every existing handler (`TimerService.fireInbox`, `recoverAbandoned`, the replay refusal) catches the BASE class, so the ADR 0130 back-off and "first then every 16th" reporting apply unchanged. TERMINAL in `toolFailure.ts` and its fitness test. Like the existing refusals it appends nothing and never fails the execution.

**What an unmarked stream means (exactly).** An envelope without `metadata.seal` makes NO claim. It is either truly plaintext, or it was sealed by a writer that did not stamp (a pre-1.25.0 node, a third-party sealing decorator, a store whose decorator stack dropped metadata). The kernel therefore does not read absence as "safe to open": it behaves EXACTLY as it does today on that envelope, with the D2/D4 shape guard still guarding inbox payloads. Nothing is refused because a marker is missing, and nothing existing is bricked: a pre-1.25.0 stream with no markers folds and replays byte-identically on every node. The marker only ADDS refusals, and only where a writer said "sealed" and this node cannot open it. Documented limit: a stream sealed by an unstamping writer keeps the pre-0130 mixed-fleet exposure for its non-inbox kinds; upgrading the writer fixes new envelopes, and old ones are not back-filled (no rewrite of a log).

**Rolling upgrade.** A pre-1.25.0 node ignores unknown `metadata` keys (the fold reads only the keys it knows; to be verified by a test in S1), so it keeps today's behaviour on marked streams; it is a node that does not yet have the protection, not one that corrupts differently. Deploy order: upgrade every node, then rely on the marker. The envelope grows by `~60-200` bytes per sealed envelope (the `covers` list); hash chains (`plugins/audit-chain`) hash the envelope the wrapper appended, so the marker is inside the chain, deterministically.

**Replay byte-identity.** Logs written with no crypto plugin are byte-identical to before. For an encrypting node the envelope already differs run to run (a random IV in every ciphertext), so DST seeds that compare logs run with a deterministic cipher/IV seam or without crypto, and the marker (a pure function of the config and the event type) adds no new nondeterminism.

**False positives.** None from content: the marker is written by the sealer, never inferred from a payload, so an app payload with a string `__loomEnc` key (residual 3) is not affected by D7. (An app can still forge a `metadata.seal`? No: `metadata` is set by the runtime and the store; a flow cannot set envelope metadata. The `send` rule D6 is unchanged.)

### D8 (R-b) — Whole-state snapshot sealing (1P) and the kernel refusal of a plaintext checkpoint

**1P.**
- `EncryptingSnapshotStore` gains `sealState: true` (mutually exclusive with `sensitive`, which stays for compatibility): the folded `ExecutionState` is serialised and sealed as ONE envelope under the same subject key as the events (so a shred erases both), and stored as `{ executionId, workflowId, <the snapshot's index fields the store contract needs in the clear>, state: { __loomEnc: ... } }`. The exact plaintext index fields are whatever `SnapshotStore.loadLatest`/`list` must filter or order by (the implementer reads the contract; none of them are payload). This is what covers the dynamic `variables._waitAnswers.<waitId>` keys that no static path can name. A load with a destroyed key throws `PayloadShreddedError`, as today. The store exposes the structural marker `sealsWholeState: true` (a plain property, like `keys`, so neither `loom doctor` nor the kernel depends on `@loom/plugin-crypto`).
- `loom doctor` finding (`snapshot-plaintext-under-encrypting-events`, severity error): event store seals (`sealingCapability` has covers, or the structural `keys` probe) while the snapshot store neither shares the `KeyStore` nor reports `sealsWholeState`; also warns when `sensitive` (static paths) is used, naming `_waitAnswers`. Names the fix and the `allowPlaintextCheckpoints` escape.
- `docs/compliance.md` is updated in the same slice (the `_waitAnswers` caveat becomes "use `sealState`").

**Kernel (behaviour change).** The kernel knows the event store seals from the D7 capability: `eventStore.sealingCapability?.()` with non-empty `covers`. No new SPI is needed: the snapshot store is judged structurally, as `LogLifecycle` already does for compaction (`keysOf`), extended with `sealsWholeState`.

- **Rule.** When the event store seals, a checkpoint (`snapshotStore.save`, the on-settle and periodic sites in `WorkflowRuntime`, and `LogLifecycle` which already has its own stricter check) is permitted iff the snapshot store `sealsWholeState === true` and shares the event store's `KeyStore`. A static-path `EncryptingSnapshotStore` is NOT sufficient (it leaves `_waitAnswers` plaintext).
- **When it fires.** At runtime CONSTRUCTION (fail fast, the primary form): `new WorkflowRuntime`/`defineConfig` throws `PlaintextCheckpointError` (a config error, listing the two ways out) when both stores are known and the rule fails. Defensively again at each `save` (stores can be swapped or composed late): there it throws the same class, which the existing best-effort checkpoint `try/catch` surfaces through `onStorageError` WITHOUT failing the run (a checkpoint is an optimisation; the log is the source of truth). A runtime with no snapshot store is unaffected.
- **Error type.** `PlaintextCheckpointError extends Error` in `@loom/workflow-runtime` (fields `executionId?`, `reason: "not-sealed" | "keys-not-shared"`), not retryable.
- **Escape hatch.** `security.crypto.allowPlaintextCheckpoints: true` (explicit, off by default; for a snapshot store on an encrypted volume) skips the rule and makes `loom doctor` downgrade to info. It is the migration path for a deployment that cannot move yet.
- **Migration.** An existing deployment with an encrypting event store and a plaintext snapshot store stops booting with a message naming the fix, which is the intended behaviour change; CHANGELOG "Changed" (breaking-by-design) entry, and the `loom doctor` finding ships in the PREVIOUS slice so it can be run first. Snapshots already written in plaintext are not rewritten or deleted (no pruning, user ruling); they stay readable. A sealed snapshot loaded by a node that cannot open it (top-level `__loomEnc` in the loaded state) raises `SealedStreamUnreadableError` from the load path, never a half-state.

### D9 (R-c) — Keep head-of-line; add `quarantineInbox` / `releaseInbox`

Head-of-line stays per EXECUTION (D4). The new verb clears a sealed head deliberately, as a journaled fact, without destroying the message.

**Why not `discardInbox` with a reason.** A discard journals `payload: null` and the message is gone for everyone; the user wants the payload retained for a capable node, and a later release needs a distinct, auditable fact that a re-delivery is not a plain `send`. Both need new journaled shapes, so this is a new event pair (EVENT_SCHEMA 1.25.0, reserved in S1), not a reason string.

**Events (owner's log, kernel-stamped envelopes, folded only from a kernel-stamped envelope like the discard facts).**

```ts
// INBOX_QUARANTINED: advances the topic cursor like a discard (same dedupe-window rules), and records a held entry.
{ topic: string; inboxSeq: number; messageId: string; heldAt: { stream: string; seq: number }; operator: Owner; reason?: string /* <=256 */ }
// folds: _inbox cursor advance; _quarantined[messageId] = { topic, inboxSeq, heldAt, operator, reason, state: "held" }
// INBOX_RELEASED: marks an entry released and names the re-delivery.
{ messageId: string; redeliveredAs: string /* new messageId */; operator: Owner }
// folds: _quarantined[messageId].state = "released"
```

A quarantine covers ONE message (the sealed head), not a range: precision over a bulk verb, because each held message needs its own retained copy.

**Retention of the payload.** `quarantineInbox` first copies the head message verbatim (still sealed; appended through the node's own store, which on an incapable node is raw, so the envelope bytes are preserved, never double-sealed, never opened) as an `INBOX_MESSAGE` into the reserved stream `__loom_quarantine__:<chainId>` (prefix added to the reserved-stream registry in S1; trimming/retention of the inbox never touches it; deleted with the chain), then journals `INBOX_QUARANTINED` pointing at it. Copy first, fact second: a crash between them leaves an orphan copy (harmless, idempotent by messageId on retry) and never a cleared head without a retained payload. The head clears for EVERY node deterministically because the cursor advance is a journaled fact, which is what keeps D4's no-divergence property: no node picks a different `select` branch, since the quarantined message is skipped on all nodes.

**Never delivered on the incapable node.** The incapable node only copies and journals; nothing reads the payload. The held copy is never fed to the delivery path (`assertDeliverable` still guards `INBOX_MESSAGE` anywhere it is consumed).

**Authorization.** Same as `discardInbox`: a `principal` is REQUIRED (no system-grant stand-in), refused with `ExecutionDeniedError` before anything is read (no existence oracle); judged as new `ExecutionOp`s `"quarantine"` and `"release"` against the chain head's owner (the op names extend the existing union in `types.ts`; `defineConfig`'s grant tables treat them like `"discard"`). Same refusal reasons as `InboxDiscardRefusedError` (`not-parked`, `contended`, `invalid`; plus `not-sealed`: quarantining a message that is NOT sealed on this node is refused, so the verb cannot be a general message-skipper, `discardInbox` already is that), with a sibling `InboxQuarantineRefusedError`. Same preconditions: the owner must be parked, bounded to existing sequences, `reason` <= 256, idempotent (re-quarantining an already-held message appends nothing).

**Release by a capable node.** `releaseInbox(executionId, { messageId }, { principal })` on a node whose store opens the held copy: reads the copy (the store opens it), runs `assertDeliverable` (an incapable node gets the typed refusal, not a release), then in one operation appends a NEW `INBOX_MESSAGE` (fresh deterministic id `q:<messageId>`, so a retry is a duplicate not a second delivery; same topic; tail of the topic's stream) and journals `INBOX_RELEASED`. It is delivered by the ordinary path, in tail order: a released message does NOT regain its original position (FIFO cannot rewind a cursor); this is documented and journaled, so every node agrees. The result reports `redeliveredAs`. Releasing an entry that is not `held` is `invalid`.

**Failure modes.** Quarantine on a running owner: `not-parked`, retry. A sealed head that becomes openable meanwhile: `not-sealed`, nothing appended. Held copies count toward no inbox cap but are bounded by a per-chain `quarantineMax` (default 256, refusal `invalid` at the cap) so the stream cannot grow without bound. Visibility (the R-c Option 2 by-product): `InboxQuarantineRefusedError`/the `SealedUnreadableError` `onError` payload carry the blocked topic and the sealed message's `inboxSeq`/age.

### D10 (R-d) — A replay refusal leaves a wake row; the poll re-drives a `running` execution that carries one

**Write.** In `WorkflowRuntime.run()`'s catch for the replay refusal (the `WorkflowContext` latch, handled today by warning and rejecting the handles), call `markContended(executionId)` (same best-effort `.catch(onStorageError)`), now for BOTH `SealedPayloadUnreadableError` (replay) and the new `SealedStreamUnreadableError`. It appends no event (D4 holds). No timer store: no-op, documented (the recoverAbandoned contract is then the only recovery).

**Poll.** Today `TimerService.fireInbox` runs the notify path, which finds no unanswered park for a `running` execution and retires the row. New rule in `fireInbox`, before the notify path: if `state.status === "running"` and the row is the inbox wake (`INBOX_WAKE_AT`), do NOT retire; classify:

1. **Another node is live on it.** A lease/liveness probe says a live holder exists (the same `LeaseStore` the poll already claims under, ADR 0118 D4): leave the row, short back-off (the existing `wakeBackoff`, with its attempt cap so a row on a genuinely long-running execution does not live forever without bound reporting). The poll never supersedes a live holder.
2. **Abandoned or unowned.** Call the SAME routine `recoverAbandoned` uses for one execution (extracted as `WorkflowRuntime.redriveAbandoned(executionId, { source: "wake" })`), so fencing, the diverged-run policy and the failed/recovered accounting are shared, not re-implemented. On success the execution moves on (suspends, completes, or keeps running under the new driver) and the row is retired when the state is no longer `running`-and-stuck (the next poll sees a parked or terminal state and the ordinary rules apply; a terminal execution retires the row).

**Fencing; capable vs incapable do not fight.** The re-drive acquires the execution fence like any resume. To keep an incapable node from taking the fence just to refuse: (i) D7's `assertStreamReadable` runs BEFORE the fence acquire, from a read of the log, so a marked stream is refused with no write at all; (ii) for an UNMARKED sealed stream (the legacy case) the incapable node cannot know, so it may acquire and then refuse at replay; the acquire only bumps the fence token (a store row, not a log event), the refusal appends nothing, and the incapable node's per-execution `sealedBackoff` (the ADR 0130 map, shared, exponential, no attempt cap, bounded 1024) keeps it from retrying soon, while the row stays for a capable node. A capable node that acquires the fence after it wins, replays, passes, and proceeds; the incapable node's stale token is fenced out on its next write attempt (it has none to make). Two incapable nodes polling the same row serialize on the same lease claim. The fence bump is the only cross-node effect of a refusal and is already tolerated by every resume path (ADR 0118).

**Back-off and reporting.** Refusals reuse `sealedBackoff` and the first-then-every-16th `onError`. A re-drive that fails for another reason uses the existing `wakeBackoff` with its attempt cap and `RedriveExhaustedError`. The row is never retired by an incapable node.

**Interaction with `recoverAbandoned`.** The sweep and the poll converge on the same routine and the same backoff maps, so a refusal in one suppresses the other for the window (the sweep already skips a refused execution on this node, ADR 0130 D4). The sweep stays the safety net where no timer store exists; the wake row makes recovery timely without requiring an app to run a sweep with an `isAbandoned` predicate.

### Residual risks after this design

- A stream sealed by a writer that does not stamp `metadata.seal` keeps the pre-0130 non-inbox exposure (D7, unmarked).
- Pre-1.25.0 nodes in a mixed rollout have no marker check.
- A released quarantined message is re-delivered at the tail, not its original position.
- A plaintext snapshot already at rest is not rewritten.
