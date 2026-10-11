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
