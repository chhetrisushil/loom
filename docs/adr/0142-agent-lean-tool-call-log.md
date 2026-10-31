# ADR 0142 — Agent lean tool-call log: `agentLoop$({ toolCallLog: "lean" })`

- Status: **Proposed** (2026-10-31) — implemented in the PR that carries it; accepted on merge
- Date: 2026-10-31
- Found by: GitHub issue #732 (step of the snapshot-size plan in #730). Owner ruling: default behaviour is
  unchanged; this is OPT-IN only.
- Builds on: [ADR 0121](0121-one-canonical-agent-loop.md) (D3: the loop's `{ content, toolCallLog, iterations }`
  output), [ADR 0140](0140-agent-claim-check-opt-in.md) (the claim-check, the other lever on tool-output
  bytes), [ADR 0138](0138-compaction-archives-what-it-removes.md) (the archive a removed frame stays resolvable
  from), [ADR 0061](0061-step-identity-interpreter-guardrails.md) (the frame ids), [ADR 0083](0083-second-consumer-rule.md).
- Placement: **1P, `@loom/agent`.** Kernel, KERNEL_ABI, EVENT_SCHEMA, every SPI unchanged.

## Context

`agentLoop$` returns `{ content, toolCallLog, iterations }`, and the flow's `_output` (the finished step's
value, kept in the folded state of a completed execution) carries every tool's full result AGAIN in
`toolCallLog[].toolOutput`, although each result is already journaled in its tool frame
(`<loop>#turn:<i>:tool:<j>`). Measured on a completed 200-turn run: total state 1.13 MB, of which `_output` is
508 KB, 494 KB of it that duplicate. The log was a verbatim port of `AgentRunner`'s return value, not a decision.

## Decisions

**D1 — one opt-in option, default unchanged.** `AgentLoopConfig.toolCallLog?: "full" | "lean"`. Unset or
`"full"` is today's shape, byte for byte (`{ iteration, toolName, toolInput, toolOutput }`). `"lean"` replaces
`toolOutput` with `{ status, bytes, digest, stepId }`:

```
{ iteration, toolName, toolInput, status: "ok" | "error", bytes, digest, stepId }
```

`status` is the `isError` flag the loop fed back to the model: `"error"` for a tool that failed (consumed as
feedback), and also for a refusal fed back the same way (an oversized input, a declined approval, an unknown
tool). `stepId` is the tool frame id `<loop>#turn:<i>:tool:<j>`, so the full output stays resolvable from the
frame, the log or, after compaction, the ADR 0138 archive (tested: the frame is MOVED to the archive and
`readArchived` returns an output whose digest verifies). Two cases have no output at that frame. For
`status: "error"` from a tool that FAILED, the frame completed with no output: the failure the model was
fed is recorded in the `<stepId>:outcome` decision's `choice.failed` field, and the entry's `digest` is the
digest of THAT value (tested against a flaky tool). A call settled without running (a refusal, a `search_tools`
/ skill-activation call) has no frame and no decision at that id; its `status` and digest describe the result
the model saw, which the log holds only inside the next model call's messages. An invalid value throws `AgentLoopConfigError`.

**D2 — digest canonicalization.** `digest` is the sha256 (lowercase hex, `sha256Hex` from `@loom/core`) of
`canonicalJson(JSON.parse(JSON.stringify(output)))` (`@loom/core`: sorted object keys, no whitespace, arrays in
order; the one canonicalization ADR 0063 uses for schema pins), and `bytes` is the UTF-8 length of that text.
The JSON round trip is deliberate: the live output a tool returned is not what a JSON event store records (a
`Date` is its ISO string, a class with `toJSON` is its JSON, a `Map` is `{}`) and a resumed run reads the
parsed form back, so digesting the live value could never match the recorded frame. Digesting the round trip
makes `digest` equal `sha256(canonicalJson(recorded output))` live and after a resume (tested against a store
that keeps a JSON copy, for a `Date`, a `toJSON` class and a `Map`, including after a resume). With the ADR 0140
claim-check on, the output is the envelope `{ __loomClaimCheck, ref, size, digest }`, so the entry's digest
covers the ENVELOPE (the envelope's own `digest` field is the blob hash; verify the blob through that). An output with no JSON form (`undefined`, a function or bigint, a cycle, or deeper
than the canonicalizer's cap) gets `digest: null, bytes: 0`; building the entry never throws.

**D3 — the mode is fixed for the life of a run.** An EXPLICIT `toolCallLog` is journaled once as a decision
(`<loop>#toolCallLog`, `source: "agent-tool-call-log"`) and served on replay; a resume configured with the other
value throws `AgentLoopConfigError` ("recorded ... but is configured ...") before any further append, instead of
mixing shapes. Rejected: a durable step frame as the pin (the replay-divergence guard only judges frames, so it
would refuse a flip in both directions without a decision, but a frame needs a registered effect and a K2 grant,
which the loop cannot supply). **Late pin:** a run recorded with the option UNSET (no pin) and resumed with an explicit mode journals the pin
at the resume, and the whole `toolCallLog` is rebuilt in that shape (earlier turns included; it is never a
mix); tested. **Limit:** an UNSET option journals nothing (that is what keeps the default's log
byte-identical), so a run recorded `"lean"` and resumed with the option removed is not detected; it simply
rebuilds `toolCallLog` in the full shape. Set the option explicitly (`"full"` journals the pin) where the mode
must be guarded: **users who choose `"lean"` must set it explicitly** on every deployment of that agent.

**D4 — the interrupted payload follows the mode.** The `agentInterrupted` failure's `toolCallLog`
(`InterruptedAgentRun`) is the same array, so it is lean when the option is.

**D5 — types.** `AgentStep` is UNCHANGED (`toolOutput: unknown`, required). Lean entries have their own
`LeanAgentStep` (`status`, `bytes`, `digest`, `stepId`, and `toolOutput?: undefined`), and
`AgentOutput.toolCallLog` / `InterruptedAgentRun.toolCallLog` are `AgentStep[] | LeanAgentStep[]`.
Code that READS `entry.toolOutput` (or `.map`s the log) still compiles, since the lean member declares it as
`undefined`; code that passes the whole `toolCallLog` to a parameter typed `AgentStep[]` needs a narrowing (it
cannot be proven full at compile time: the mode is runtime config) - a type-level change for that one shape,
noted in the CHANGELOG. `isLeanAgentStep(step)` narrows an entry. `AgentRunner` and `agentStep$` (deprecated, ADR 0121) are not given the
option.

**D6 — readers.** `@loom/conversation` reads tool names only (works in both modes, tested). The `evals`
agentLoop subject reads `status` on a lean entry and the output heuristic on a full one; a DECLINED approval is
`"error"` in lean mode only (the heuristic does not count a refusal), documented in its test. A reader that needs
the output itself (a diagnostics runner that parses a tool's JSON) must resolve `stepId`, or stay on `"full"`.

## Consequences

Measured (`leanToolCallLog.perf.test.ts`, completed 200-turn run, 1.5-4 kB tool outputs): folded state
1201.5 KB full -> 683.4 KB lean (-43%), `_output` 554.7 KB -> 36.6 KB. With the ADR 0140 claim-check on, `_output`
is already 101.8 KB and lean takes the state 295.6 KB -> 230.3 KB. The log (the journaled frames) is unchanged:
this shrinks what a resume reads and the final step value, not the audit record.
