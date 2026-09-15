# Live Multimodal Streaming: What Is Actually Stopping Us

**Status:** Evaluation — no work scheduled
**Date:** 2026-09-15
**Kernel baseline:** EVENT_SCHEMA 1.18.0, KERNEL_ABI 1.1.0, ADRs 0001–0095
**Prompted by:** the competitive decks, which score live bidirectional audio/video as
`ADK ✅ / Loom ➖ (roadmap)` — and never say why.

---

## 0. Verdict

**Nothing in the kernel forbids live multimodal, and it needs no new syscall.** The tempting
proposal — a `ctx.receive` that feeds inbound frames to a running execution — is wrong, because an
effect is already arbitrary async code and can hold a duplex socket for the length of a turn.

| Layer | What lands there |
| --- | --- |
| **Kernel** | nothing. `KERNEL_SYSCALLS` and `EVENT_SCHEMA` unchanged |
| **1P / SPI** | a binary transient sink seam (today's only sink is text and in-process) |
| **Plugin** | a duplex transport (WS/WebRTC) and a realtime provider adapter |
| **Application** | the turn-level durable vocabulary, proven in one example before any of it is 1P |
| **Out of scope** | codecs, resampling, VAD/endpointing, jitter buffer, echo cancellation |

The boundary that decides all of it is already recorded: **ST-R** rejected durable kernel
streams/pipes — chunks-as-events breaks the fold economics — leaving "streaming as transport on the
transient side, with only the outcome durable" (ADR 0059). Live media is that rule at 50 frames per
second. This evaluation does not reopen it.

---

## 1. What already exists, verified

| Capability | Evidence |
| --- | --- |
| `stream` is a **syscall** | `workflow-runtime/src/abi.ts:74` — `stream(eventType, delta, done?)`, since ABI 1.0.0 |
| Provider streaming is a pinned contract | `LlmProvider.stream?(): AsyncIterable<LlmStreamChunk>` (`llm/src/types.ts:93`), with `assembleStream` enforcing **streamed ≡ completed** and conformance pinning it |
| The per-chunk economics are already understood | `agent/src/chunkDeltas.ts` — "a 4,000-token generation streamed per token is 4,000 permanently load-bearing events", with the semantic-boundary batcher that makes the advice followable |
| Barge-in has a foundation | `EffectContext.signal` is a real `AbortSignal` (`effect-runtime/src/types.ts:71`), and ADR 0060's typed `InterruptedGeneration` failure **preserves the text produced before the abort** rather than discarding it |
| Media artifacts have a durable home | ADR 0059 `ContentStore.putStream` — streamed address ≡ whole-buffer address, idempotent, conformance-pinned |
| Live read-side already works | `@loom/live-query` re-folds and pushes state on every event, with no syscall and no new event type |

Text streaming is solved end to end. Voice and video are a different problem, and the difference is
not "more of the same bytes".

---

## 2. What actually blocks it

**B1 — no duplex transport exists anywhere in the repo.** Zero WebSocket or WebRTC; the only mention
is a comment in `plugins/a2ui/src/callFunction.ts:25`. Everything is `fetch` + SSE: one-way
server→client plus request/response.

**B2 — the sandbox's network path cannot carry a session, by construction.** The K7.3 egress broker
is `node:http`/`node:https` only, returns `BrokeredResponse { body: string }`, and caps bodies at
10MB (`isolate/src/broker.ts`). There is no socket upgrade, no streaming response, no binary. So a
**sandboxed** tool (ADR 0089) can never host a live session; only an unsandboxed effect can. That is
a security-posture statement, not a detail: the live path would sit outside the isolation ring that
every other egress crosses.

**B3 — the only transient out-channel is text and in-process.** `progressHub.report(executionId,
line: string)` is an app-level module singleton (`app/src/progressHub.ts`). `live-query` doesn't
write at all — it re-folds the durable log, so anything it shows had to be an event first. There is
therefore **no binary transient sink**, and no cross-process one either: a remote or Cloud Run worker
has no path to push frames to a client.

**B4 — nothing can send *into* a running execution.** `resume` refuses unless the execution is
`suspended` — `WorkflowRuntime.ts:506`, refusal reason `not-suspended`. The only inbound channel
parks the execution first: correct for an approval, impossible for continuous audio.

*This is where the design decision is.* The answer is **not** a new inbound syscall. An effect is
arbitrary async code, so the session lives inside **one journaled effect** that owns the socket,
consumes inbound frames, emits outbound audio, honours `signal` for barge-in, and returns the turn
outcome as its recorded result. Structurally this is the same move the ADK+Temporal integration
makes by pushing each model call into its own Activity — the difference is that loom does not have
to patch anything to make it deterministic, because the durable fact is the turn, not the frames.

**B5 — there is no turn-level durable vocabulary.** With the session inside one effect, the log gets
a single opaque step result. A live agent needs: turn started, user utterance (transcript), model
utterance, interruption, tool call within a turn, session ended and why. Designing that is the real
work, and ADR 0083 applies before any of it becomes 1P vocabulary.

---

## 3. What you would be signing up for

**A live session is not resumable, and should not be.** Crash mid-utterance and the socket is gone;
recovery restarts the *turn*, not the audio. The honest claim is "the conversation survives, the
utterance does not" — strictly more than a stateless agent gives you, and materially less than the
claim loom makes everywhere else. Any deck line must say so.

**Per-effect ceilings were not designed for a twenty-minute call.** K3 meters `wallMs` per effect and
ADR 0084 effect classes set a static ceiling per effect class; one long session is one enormous
effect against both. Check the class ceiling before promising a duration.

**Replay of a session returns its transcript, not its audio.** That is the correct behaviour and it
follows from the streamed-≡-completed discipline already pinned for text — but it means a replayed
voice execution is not a re-playable *recording*, and someone will assume it is.

---

## 4. Smallest credible path

1. **A binary, cross-process transient sink seam** — what `progressHub` would be if it were neither
   text-typed nor an in-process singleton. This is the only SPI-shaped item.
2. **A duplex transport plugin** (WS first, WebRTC only if a browser mic path is required), routed so
   the allowlist decision still happens kernel-side — otherwise B2 becomes a hole rather than a
   limitation.
3. **A `liveSession` journaled effect** whose input is the session parameters and whose result is the
   turn outcome, with the turn events emitted as **application** vocabulary first.
4. **One example: voice approval of an already-suspended flow.** It reuses the HITL gate that exists,
   needs no kernel surface, makes the "conversation durable / utterance transient" split visible, and
   is the second consumer that would justify promoting any of step 3's vocabulary to 1P.

---

## 5. What not to build

- **`ctx.receive` / an inbound stream syscall.** B4 is answered by an effect that owns the socket.
- **Widening `ctx.stream` to bytes.** The syscall is text for a reason; frames must not become events.
- **Reopening ST-R.** Durable kernel streams/pipes were rejected on fold economics, and audio is the
  strongest possible case *for* that rejection, not against it.
- **A media pipeline.** Gemini Live and OpenAI Realtime do endpointing, VAD and codecs server-side;
  anything loom writes here is a worse version of a provider concern.

---

## 6. Open questions

- What is the effect-class ceiling for a session-length effect, and does K3 metering need a
  session-aware dimension (or is per-turn accounting enough)?
- Does the transient sink need ordering/backpressure guarantees, or is latest-wins sufficient the way
  it is for `live-query`?
- Interruption is a *decision* (barge-in detected ⇒ stop generating). Should it be recorded with
  `ctx.decide` so it carries policy and propensity, like every other learned choice?
- Does a voice approval satisfy the K12.2 `ResumeAuthenticator` contract, or is "who approved" simply
  unverifiable over audio without an out-of-band identity step?
