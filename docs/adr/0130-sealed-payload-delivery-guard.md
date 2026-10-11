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

**What "contains" means.** The sealed paths are configuration (`pathsFor` / `mapPaths` in `EncryptingEventStore` accept nested paths such as `payload.secret`, and the default inbox registration is the whole `payload`). The kernel cannot know a given deployment's paths, so the guard looks for a plain object with an OWN `__loomEnc` key at the top level or at any depth, in objects and arrays. Inherited keys do not count.

**Bounded walk.** Iterative and breadth-first (a shallow envelope is found before any budget matters, and depth cannot blow the stack), capped at `SEALED_WALK_BUDGET` = 100 000 visited nodes, the same budget as `blankStream`'s `carriesKey`. Exhausting the budget (a huge, very deep, or cyclic in-process payload) is NOT "clean": the guard fails closed and treats it as unverifiable (`SealedPayloadUnreadableError.unverifiable`).

### D3 — One shared check, every delivery site

`assertDeliverable(executionId, message)` in `inbox.ts` runs BEFORE any `MESSAGE_CONSUMED` is built, at both sites that consume an inbox message into a flow:

- `WorkflowContext.satisfyFromInbox` (the live run; closure 1 of the lost-wakeup protocol), and
- `WorkflowRuntime.notifyAttempt`'s scan (the notify path: the post-park re-read `afterInboxPark`, `TimerService`, `recoverAbandoned`, the send wake).

Every `MESSAGE_CONSUMED` append was audited. The others write no user payload: the operator discard (`discardInbox`, D8) and the TTL expiry (D10a) journal `payload: null`, and a duplicate delivers nothing (its payload is not copied), so they need no check. An operator discard is deliberately still allowed on a sealed message: it is the escape hatch for a message nobody can open.

### D4 — Park, do not fail

Both sites leave the message in the inbox and append nothing. What the flow sees differs by site, and in neither case does the execution fail:

- **Live run:** the flow stays parked on its receive. Failing the execution would make the refusal permanent (`EXECUTION_FAILED` is terminal), destroying exactly the "stay available for a correctly configured node" property. The run parks normally; the post-park notify pass raises the typed error.
- **Notify path:** `SealedPayloadUnreadableError` is thrown to the caller, which already routes errors to `onStorageError` / `TimerService.onError` / `recoverAbandoned`'s `onError`. The park and the inbox are untouched, so a node configured to open the payload consumes the message on its next notify, resume or re-drive.

Delivery is FIFO per topic and a cursor cannot skip, so a sealed head-of-line message holds its topic for this node until a capable node consumes it or an operator discards it. That is correct: skipping would silently reorder or lose it.

### D5 — The error

`SealedPayloadUnreadableError(executionId, messageId, topic, unverifiable = false)`. Ids only; the message text and fields never carry the ciphertext. It is classified **TERMINAL** in `packages/agent/src/toolFailure.ts` (and its fitness test): retrying on the same node cannot help, and a model must not be told to "try again" by an `isError` result.

### D6 — The ingest rule (`send`)

`send` refuses a payload that contains an `__loomEnc` envelope, with `InboxMessageRefusedError`, before anything is appended, like the forged `$shredded` marker. Why this layer and why it is unconditional: sealing happens inside the event-store wrapper at append, AFTER `send` has run, so at `send` time a raw user payload carrying `__loomEnc` is always forged (or relayed ciphertext read through a raw store). A genuine seal can only be produced by the configured store, below `send`. Without the rule a sender could plant an envelope that is indistinguishable from a real seal at delivery, and the guard would be a denial-of-service lever (park any execution's topic) instead of a safety net. A payload too large or deep to check inside the budget is refused as well (fail closed); the default `inboxMaxPayloadBytes` (64 KiB) is far below the budget, so this only bites a raised limit.

Residual: a writer that bypasses `send` and appends to the reserved inbox stream directly is below the kernel's authority (the stream is kernel-owned; only `send` writes it).

## Consequences

- A mixed fleet (some nodes with crypto, some without) can no longer corrupt a log; an unconfigured node reports the typed error and leaves the work for a capable one.
- Cost: one bounded walk per delivered (non-duplicate) message and per `send`.
- Not covered: a snapshot's `_waitAnswers` payload (already documented in `docs/compliance.md`).
