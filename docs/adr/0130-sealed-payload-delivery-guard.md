# ADR 0130 — Refuse to deliver a sealed payload to a flow that cannot open it

- Status: **Accepted** (2026-10-12) — user approved the kernel guard 2026-10-12; implemented.
- Date: 2026-10-12
- Origin: review of loom #575 (the r2-erasure flake).
- Builds on: [ADR 0110](0110-durable-inbox-and-receive-select.md) (the durable inbox, D9 erasure marker), ADR 0085 (bounded untrusted-content walks).
- Placement: **kernel** (`@loom/workflow-runtime`, the inbox delivery path). Not `@loom/plugin-crypto`.
- Version impact: none. No event kind is added or changed, so `EVENT_SCHEMA` stays 1.24.0; no SPI signature or semantics change (`EVENT_STORE_SPI`, `SNAPSHOT_STORE_SPI`), `KERNEL_ABI` and the wire vectors are unchanged. The only public additions are the error class `SealedPayloadUnreadableError` and its classification.

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

## Residuals (Proposed, 2026-10-14)

- Status: **Proposed**. Nothing below is decided or implemented; every decision is the user's (questions at the end).
- Scope: the four residuals logged after #576 merged (this ADR's own residuals 1, 2 and 4, plus a gap in the replay refusal's wake). Residuals 3 and 5 above stand as written.
- Placement bias: outward (ADR 0083, the triage rule). Each residual gets a verdict.
- Version batching: loom batches kernel bumps. Only the bumps an option NEEDS are listed; "none" means no `EVENT_SCHEMA`, `EVENT_STORE_SPI`, `SNAPSHOT_STORE_SPI`, `KERNEL_ABI` or wire-vector change.

### R-a — Other sealed event kinds on an incapable node

**Confirmed.** `assertDeliverable` is called at exactly two sites, `packages/workflow-runtime/src/WorkflowContext.ts:2114` (live consume) and `packages/workflow-runtime/src/WorkflowRuntime.ts:4933` (notify scan), plus the replay check at `WorkflowContext.ts:1936` (recorded INBOX answers only, `arm.kind === "inbox"`). Nothing else looks for an envelope. `EncryptingEventStore` seals any event type named in its `sensitive` map (`plugins/crypto/src/EncryptingEventStore.ts:86` `pathsFor`, `:162` append, `:385-415` read and subscribe), and the kernel itself registers kernel-authored kinds: `defineConfig` seals `EXECUTION_STARTED.principal.identity.*` and `OUTCOME_RECORDED.recordedBy` (`packages/app/src/principalPolicy.ts:99-101`). The other places a recorded value reaches a flow are therefore unguarded: `STEP_COMPLETED.output` served on replay (`WorkflowContext.ts:859/887/1077` write it, replay serves it), the `EXECUTION_STARTED.input` handed to the flow, effect and decision results, human-step answers.

**Minimal repro (describe only).** Node A: `EncryptingEventStore` with `sensitive: { STEP_COMPLETED: ["output"] }`; run a flow `const s = await ctx.run(tool); await ctx.receive("go"); return s` to the park. Node B: same stream through a RAW store, `resume`/`recoverAbandoned` after `send("go")`. B replays the recorded step, `s` is `{ __loomEnc: "loom/aes-256-gcm", ... }`, the flow completes, and `EXECUTION_COMPLETED.output` journals the envelope (or a downstream step is invoked with ciphertext as input). Variant with the principal: B reads `principal.identity.tenant` as an envelope object; whether authz fails closed depends on the policy comparing a string to an object (not verified here, it needs a test before anyone relies on it).

**Severity.** Correctness plus integrity of the log, not confidentiality (ciphertext is shown, never plaintext). It is the same durable-corruption class D2 closed for the inbox, so the "mixed fleet can no longer corrupt a log" claim is bounded to two event kinds today. Kernel-authored sealed kinds (principal, outcome) are the part that cannot be handled by "run such kinds only on capable nodes", because `defineConfig` opted the app in without the operator choosing the kind.

**Options.**

1. *Document only.* Keep Consequences residual 1; add the principal and outcome kinds to `docs/compliance.md` as "mixed fleets must be homogeneous in `security.crypto`". Free; leaves a footgun the kernel itself arms.
2. *Generalise the replay and fold guard to every recorded value.* One check on the fold input: when the kernel hydrates an event for a VM, any envelope in a kind that is not the inbox raises `SealedPayloadUnreadableError` (`recorded: true`) from the fold or the VM seed, refusing the whole attempt like the replay refusal. Kernel, because only the kernel sees every read. Cost: a bounded walk per event folded, which is O(total payload bytes) on every fold and replay (not per delivered message), so it needs a cheap pre-filter (substring test for `__loomEnc` on the already-serialised JSON where the store keeps it) or a per-execution "checked up to seq" watermark. False positives: an app payload with a string `__loomEnc` key (residual 3) would be refused on EVERY kind. No version bump if it only refuses; a new error context field is additive.
3. *Capability handshake instead of shape sniffing.* The store declares what it seals; the runtime refuses to start an execution (or resume one) whose stream header says "sealed under config X" unless this node has X. Needs a stream-level sealed-config marker (a new field on `EXECUTION_STARTED` or a metadata record) and a decorator capability bit. Fixes the class properly and also covers (b) partially, but is a durable-format change: `EVENT_SCHEMA` minor bump (and `EVENT_STORE_SPI` minor if the marker lives in store metadata, as the ADR 0129 incarnation anchor did). It is also the largest option and has no consumer asking.

**Placement.** Option 2 is kernel (read-path choke point; same argument as D1). Option 3 is kernel plus 1P (`@loom/plugin-crypto` writes the marker). Option 1 is docs.

**Recommendation.** Option 2, scoped to the kernel-authored sealed kinds first (`EXECUTION_STARTED` principal and `OUTCOME_RECORDED`), because those are sealed without the operator choosing them. Keep the arbitrary-kind case as documented (Option 1) until a deployment names a second kind; revisit Option 3 only if the user wants the marker for (b) too. Bumps: none for the scoped Option 2 (it adds a refusal, no event shape); `EVENT_SCHEMA` 1.25.0 (+ `EVENT_STORE_SPI` minor) only if Option 3 is chosen.

### R-b — An unencrypted shared snapshot store holds plaintext of sealed content

**Confirmed, but narrower than first logged.** An encrypting snapshot decorator already exists (`plugins/crypto/src/EncryptingSnapshotStore.ts`, `sensitive` dot-paths into the folded `ExecutionState`, same subject key as the events, so a shred erases both). The gap is that it is opt-in and the kernel does not check it on the ordinary path:

- `WorkflowRuntime.ts:6519` and `:7009` call `snapshotStore.save(...)` with the decrypted fold (checkpoint on settle, periodic) whatever the snapshot store is.
- The only cross-check is `LogLifecycle.ts:155`, which refuses COMPACTION when the event store encrypts but the snapshot store does not share its `KeyStore`. A plain checkpoint is not checked.
- `docs/compliance.md:203-206` documents that `variables._waitAnswers` is keyed by a dynamic `waitId`, "which a sensitive path cannot name", so even an `EncryptingSnapshotStore` configured with static paths does not seal a recorded inbox answer. The fix named there is "seal the whole state", which `EncryptingSnapshotStore` does not offer (it maps declared paths only).

**Minimal repro (describe only).** Node A: `EncryptingEventStore` with `INBOX_MESSAGE`/`MESSAGE_CONSUMED` payload sealed, plain `InMemorySnapshotStore`. Run a flow that receives a secret and settles. `snapshotStore.loadLatest(id)` returns state with `variables._waitAnswers.<waitId>.payload` in clear. Shred the subject: the event log is unreadable, the snapshot still serves the secret (and node B, incapable, replays from the snapshot, passes the D4 check because it is plaintext, and completes).

**Severity.** Confidentiality, and erasure-theater (K10.2/A1 is the same hole for static paths, closed by `EncryptingSnapshotStore`). Not a liveness or corruption issue. For the guard itself it is benign (an incapable node served plaintext is correct), so it is a compliance gap rather than a hole in D2.

**Options.**

1. *Document and doctor.* Keep the compliance note; add a `loom doctor` finding (structural `keys` property check already exists, `packages/event-runtime/src/installOptional.ts:28`) "event store seals X but snapshot store does not share the KeyStore". Outward, no kernel change, no bump.
2. *Whole-state sealing mode in `EncryptingSnapshotStore`.* A `sensitive: "all"` (or `sealState: true`) option that encrypts `variables._waitAnswers` and the other dynamic-key containers wholesale under the subject key. 1P plugin change; the snapshot payload stays an opaque `ExecutionState` to the store contract, so no SPI change if the decorator re-presents the same shape on load. Cost: snapshots lose partial readability (tooling that inspects `variables`), and a load needs the key (already true for static paths).
3. *Kernel refuses the plaintext checkpoint.* At `snapshotStore.save` the runtime refuses (or skips the save) when `security.crypto.events` is composed and the snapshot store lacks the shared `KeyStore`, generalising `LogLifecycle.ts:155` to every save. Kernel behaviour change: a deployment that today checkpoints plaintext starts failing or losing checkpoints (a skip is safe for correctness but regresses read cost). No bump; a behaviour change needing a CHANGELOG "Changed" entry.

**Placement.** Option 1 and 2: 1P (`@loom/plugin-crypto`, `loom doctor`). Option 3: kernel, but the kernel only enforces "same KeyStore", never the cipher.

**Recommendation.** Options 1 and 2 together, no kernel change; defer Option 3 unless the user wants fail-closed by default (it is the only option that makes the unsafe configuration impossible rather than detectable, and it changes behaviour for existing deployments). Bumps: none for 1/2/3 (`SNAPSHOT_STORE_SPI` unchanged because the shape is preserved).

### R-c — Head-of-line blocking is per execution

**Confirmed, and designed.** `WorkflowContext.ts:2116` (`return delivered`) abandons the whole scan, and `WorkflowRuntime.ts:4933` throws out of the whole notify scan; the scan loop covers every topic of the execution (`for (const w of waits)` at `:4925-4932`), so a sealed head on topic A holds topic B's deliverable messages. D4 gives the reason: skipping would let nodes with different configs pick different `select` branches.

**Repro (describe only).** Execution parks on `select([receive("a"), receive("b")])`; `send("a", sealedUnderNodeA)` then `send("b", "plain")`. Capable node A consumes `a` (lowest `inboxSeq`) and completes the select with arm `a`. Incapable node B refuses the scan and never delivers `b`: correct, since delivering `b` on B would diverge from A's branch.

**Severity.** Liveness only, on the incapable node only; capable nodes are unaffected and the log is never corrupted. The harm is a fleet whose only runner of an execution is incapable (a misconfigured deploy): the execution stalls behind a message nobody can open, with an `onError` every 16th poll and an operator escape hatch (`discardInbox`, D3; TTL expiry D10a if configured).

**Why most options are unsound.** Skipping a sealed topic is unsafe for the reason in D4. A weaker rule, "block only messages with a higher `inboxSeq` than the sealed one", is already what FIFO plus a deterministic first-answered-arm gives for a single `select`; it does not unblock any case that is not already blocked by that ordering, so it buys nothing.

**Options.**

1. *Document and accept (WONTFIX in the kernel).* Name it as designed (already Consequences residual 4); point operators at `discardInbox` and the journaled TTL. Zero change.
2. *Observability, no semantics change.* Surface a stuck-behind-sealed state: an `onError` payload carrying the blocked topics and the sealed message's age, and an analytics advisory (`@loom/analytics`, advisory per ADR 0034) "execution X blocked behind sealed message M for > T". 1P, no bump.
3. *Operator quarantine verb.* A first-class `quarantineInbox` that journals the sealed message as a dead letter (`MESSAGE_CONSUMED` with `payload: null` plus a reason) so the head clears while preserving the audit trail, an explicit, human-triggered version of the existing discard. Possibly already expressible by `discardInbox` with a reason; if a new reason value is needed it is an additive field. Kernel only if a new journaled reason is required (`EVENT_SCHEMA` minor), otherwise no bump.

**Placement.** 1: docs. 2: 1P analytics. 3: kernel if it adds a journaled reason, else a recipe over `discardInbox`.

**Recommendation.** WONTFIX the semantics (Option 1) and do Option 2 so the state is visible; do Option 3 only if `discardInbox`'s journal does not already record who discarded and why (check before proposing a schema bump). Bumps: none for 1/2; `EVENT_SCHEMA` minor only if 3 needs a new reason value.

### R-d — A replay refusal writes no wake row

**Confirmed.** `markContended` (`WorkflowRuntime.ts:4861`) is reached only from `notifyPass`'s catch (`:4847`), i.e. the notify path. The replay refusal is raised inside `run()` (`WorkflowContext.ts:1936-1945`, handled `WorkflowRuntime.ts:6874-6885`), which warns, rejects the handles and returns: no `timerStore.schedule`, no event. The execution is left `running` (an unrelated resume already appended `EXECUTION_RESUMED`) or whatever it was. The ADR already admits this (Consequences, "a PURE replay refusal in `run()` writes no row").

What recovers it today: `recoverAbandoned` on a capable node (`recoverAbandoned.ts:280`, `status` running or pending), but that needs an app to run the sweep with an `isAbandoned` predicate or a lease store (`recoverAbandoned.ts:60-75`, the predicate is REQUIRED with no default), and the staleness window must elapse. The incapable node's own sweep skips it for a back-off window (`:392`, `:491`).

**Minimal repro (describe only).** Capable node A journals `MESSAGE_CONSUMED` with a sealed `payload`, then crashes before the next step; the execution is `running`. Incapable node B resumes (`resume` of any gate, or a sweep): replay hits `WorkflowContext.ts:1936`, B refuses; no timer row exists. Node A is later redeployed capable but no `send`, no timer, no resume arrives, and the app runs no sweep: the execution sits `running` indefinitely.

**Severity.** Liveness, narrow: needs a mixed fleet AND no sweep on a capable node. Not a confidentiality or correctness issue.

**Options.**

1. *Document that a sweep is the contract.* State that a deployment with an incapable node must run `recoverAbandoned` on a capable node; no code.
2. *Write the durable wake on a replay refusal too.* In the `run()` catch at `WorkflowRuntime.ts:6874`, call `markContended(executionId)` (same best-effort `.catch(onStorageError)`). Then `TimerService`'s inbox poll (`INBOX_WAKE_AT`) re-drives it on any node. But the wake row's job today is to trigger the NOTIFY scan for a PARKED execution; for a `running` execution the notify path may find no unanswered park and retire the row, so the row alone does not re-run the flow. Either the poll must learn to `resume`-redrive a running execution carrying the row, or the row must be paired with a distinct reason. Kernel, small, no event change; needs a decision on what the poll does with a `running` execution (this is why it is not a one-liner).
3. *Park the execution on the refusal.* Instead of leaving it `running`, journal a reserved park (like `FLOW_DIVERGED_GATE`, ADR 0113) so it is `suspended` and every existing wake path (notify, timers, `recoverAbandoned`'s parked-execution notify pass) applies. Strongest liveness, but it appends an event on a refusal, which contradicts D4 "appends nothing" and the property that an incapable node never writes about an execution it cannot read; it also adds a reserved gate name (`EVENT_SCHEMA` minor if the gate is a new journaled condition kind, none if it reuses `SuspendError` with a reserved `on`). Highest risk.

**Placement.** Kernel (1: docs).

**Recommendation.** Option 2 only after the poll semantics for `running` executions are decided; until then Option 1 plus a `recoverAbandoned` recipe in `docs/` naming this case. Reject Option 3 (breaks the appends-nothing rule). Bumps: none for 1 and 2; `EVENT_SCHEMA` minor only for 3.

### Summary of verdicts

| Residual | Real? | Severity | Recommendation | Placement | Bumps |
|---|---|---|---|---|---|
| R-a other sealed kinds | yes, incl. kernel-authored principal/outcome | correctness (log corruption), not confidentiality | scoped kernel refusal for kernel-authored sealed kinds; document the rest | kernel | none (unless the capability handshake is chosen: `EVENT_SCHEMA` 1.25.0 + `EVENT_STORE_SPI` minor) |
| R-b unencrypted snapshots | yes, opt-in gap (`EncryptingSnapshotStore` exists; dynamic `_waitAnswers` keys unsealable) | confidentiality / erasure | doctor finding + whole-state sealing in the 1P decorator | 1P | none |
| R-c head-of-line | yes, by design | liveness (incapable node only) | WONTFIX semantics; add visibility | docs / 1P | none |
| R-d no wake on replay refusal | yes | liveness, narrow | document the sweep; then durable wake once poll semantics for `running` are decided | kernel | none |

### Decision questions (for the user)

1. R-a: scope the kernel refusal to the kernel-authored sealed kinds (`EXECUTION_STARTED` principal, `OUTCOME_RECORDED`), or to every event kind (Option 2 as written), or only document? Is a stream-level capability marker (Option 3, `EVENT_SCHEMA` 1.25.0) wanted at all?
2. R-a: should an incapable node that reads a sealed principal fail closed on authz? (Needs a test to establish the current behaviour first.)
3. R-b: accept 1P-only (doctor finding plus whole-state sealing), or also make the kernel refuse a plaintext checkpoint when the event store encrypts (Option 3, behaviour change)?
4. R-c: confirm head-of-line blocking is WONTFIX in the kernel and that visibility (advisory) is enough.
5. R-d: should the poll re-drive a `running` execution that carries a wake row, or should this stay a documented `recoverAbandoned` contract?
6. Batching: if any of R-a Option 3 or R-d Option 3 is chosen, fold the `EVENT_SCHEMA` bump into the next kernel batch rather than shipping alone?
