# ADR 0063 — MCP dynamic dispatch: canonical schema hash, drift channel, principal handling

- Status: **Accepted** (`jsonSchemaHash` in `@loom/core`, `mcpInvoke$` in
  `@loom/plugin-mcp`, read-model dispatch index)
- Date: 2026-07-19
- Builds on: [DE-series evaluation](../requirements/2026-07-19-dynamic-execution-de-series-evaluation.md)
  (DE-8/DE-9), ADR 0060 (typed channels), ADR 0061 (dynamic step ids), ADR 0058
  (read-model), ADR 0043 (plugin litmus), K10-R1 (`@loom/classify`), K12.1
  (principal chain).
- Part of: the GenUI/DE corrected series. No kernel changes; no EVENT_SCHEMA bump.

## Context

Deterministic blueprints call MCP tools whose backends move. The safety loop —
pin the tool's schema hash at plan time, verify at execution time, fail typed on
drift so the flow repairs in-band — existed nowhere: `@loom/plugin-mcp` captured
`jsonInputSchema` but never hashed it, and its tool wrappers were `z.unknown()`
pass-throughs. Placement: MCP dispatch exists because of a specific external
system ⇒ plugin (ADR 0043), with only the hash canonicalization in core.

## Decisions

### D1 — One canonical schema hash, in `@loom/core`

`canonicalJson` (RFC 8785-style subset: lexicographically sorted keys, no
whitespace, arrays in order, throws on non-JSON values) + `jsonSchemaHash` →
`fnv1a64:<hex16>` (BigInt FNV-1a-64; dependency-free — core is platform-neutral,
no `node:crypto`; 64 bits is drift-detection grade where the compiler's 32-bit
`shortHash` is not). In core so a registry change-detector imports the SAME
implementation without pulling the MCP plugin — two canonicalizations that
mostly agree is how registry-driven repair becomes unreliable.

### D2 — ONE registered effect, dynamically-minted step ids

`mcp.invoke` is a single registered `ToolEffect`; `mcpInvoke$(id, { toolName,
expectedSchemaHash })` mints steps against it (ADR 0061 ids — `hydrate#3`), never
an effect per tool. Runtime data stays data (the interpreter pattern); the
static registry stays static (P5). Declared channels (ADR 0060, registry-level
so every minted step inherits them): `toolNotFound { toolName }` and
`schemaDrift { toolName, expectedSchemaHash, observedHash }` — recorded typed,
replay-substituted, branchable into repair without re-invoking the backend.

### D3 — Principals never touch the log

Primary: the opaque K12.1 `ctx.principal` chain, mapped to transport headers
inside the effect body — never part of the logged input. Fallback (per-call
tokens): the input field is classified `secret()` (`@loom/classify`) so
`redactionMiddleware` substitutes a SecretRef before STEP_STARTED persists.
This is DE-9 applied — the classification vocabulary already shipped (K10-R1);
this ADR makes it the normative pattern for principal-carrying tool contracts.
An immutable log cannot be retroactively redacted; the annotation is cheap now
and impossible later.

### D4 — Dispatch-target indexing rides userspace events + read-model

The effect emits `MCP_DISPATCHED { toolName, server, schemaHash }` — a domain
event the fold skips (unknown types advance only the sequence), so no
EVENT_SCHEMA change. "Which executions called tool X at schema H" — the
proactive-repair query — is a `@loom/plugin-read-model` projection (ADR 0058),
not log parsing and not a governed event type.

## Consequences

- Deterministic manifests are safe against moving backends: pinned at plan time,
  verified per call, healed in-band via the ADR 0060 channel.
- The registry reverse index (schema-hash → pinning blueprints) remains plain
  registry schema work, per the submission's own non-requirements.
- Spec capability `mcp-dynamic-dispatch` (L2); evidence
  `plugins/mcp/src/mcpInvoke.test.ts`.
