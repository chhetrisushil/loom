# DE-Series Audit — security · performance · memory (post-merge)

- Status: **Complete — all confirmed findings fixed** (commit series after PR #199;
  build 82/82, test 135/135, lint clean).
- Scope: the GenUI/DE corrected series (69c9eae..PR #199) — typed failure channels,
  step-identity guardrails, batched content resolution, `mcpInvoke$`, `@loom/plugin-sandbox`,
  `fanout$`, `schemaHash` — audited by three independent passes (security, performance,
  memory/unbounded-growth), findings adversarially verified against source and, for the
  sandbox, against quickjs-emscripten 0.31 internals. A fourth pass audited DX reachability.
- Companion: [DE-series evaluation](2026-07-19-dynamic-execution-de-series-evaluation.md),
  ADRs 0060–0065.

## 1. Findings fixed

### Security

| # | Sev | Finding | Fix |
|---|---|---|---|
| SEC-1 | **HIGH** | `mcpInvoke` accepted a raw string `authToken` — a caller passing a credential had it persisted verbatim in `STEP_STARTED` (immutable log) *before* any middleware ran; the secretRef convention was documentation, not enforcement | String tokens rejected unless `acceptResolvedTokens: true` asserts redactionMiddleware is wired (a string is then a resolved ref, never logged raw); unresolved secretRefs reaching the effect fail loudly ("middleware not wired"). Silent permanent leak → immediate loud error |
| SEC-2 | MED | `CachingContentStore` cached (and served) fetched bytes without verifying the content address — a lying inner store could poison the cache forever, defeating the sandbox's pin-by-hash provenance | Fetched bytes verified (`contentAddress(bytes) === address`, sha256-scheme refs) before serving OR caching; mismatch throws |
| SEC-3 | MED/LOW | `canonicalJson` and `shapeOf` recursed unbounded over attacker-influenced input (hostile `listTools` schema / sandbox output) — stack-overflow DoS | Depth caps (1024) in both; degrade to catchable errors |
| SEC-5 | LOW | MCP server response text and sandbox script error messages flowed unbounded into thrown errors → `STEP_FAILED` (log injection/bloat) | Truncated to 2 KiB at both sources |

**Verified clean** (attack vectors audited, no defect): sandbox escape via input
marshalling (JSON.stringify escaping is sufficient; `__proto__` stays inside the VM),
host prototype pollution via `vm.dump` (JSON.parse own-property semantics), resource-limit
bypass via promise jobs (the host never drains the VM job queue — queued callbacks never
run), typed-failure payload validation ordering, `childIdFor` separator forgery guard,
header injection (blocked by undici), fnv1a64 fitness for drift detection (not an authz
boundary).

### Memory / unbounded growth

| # | Sev | Finding | Fix |
|---|---|---|---|
| MEM-1 | **HIGH** | Typed-failure payloads bypassed claim-check economics — `claimCheckMiddleware` inspects only *returned* results, never thrown errors, so an unbounded domain payload landed verbatim in the immutable log + every folded frame + every snapshot: the exact problem ADR 0054 solved, reintroduced via the error channel | 16 KiB cap at the record seam (`WorkflowContext`); over-cap degrades **loudly** to the untyped path (no channel/payload recorded; message says to carry a content ref instead). Spec §4.1 updated |
| MEM-2 | MED | Sandbox: `vm.dump` of a Promise-valued completion **disposes the handle itself** (verified in 0.31 internals) — the unconditional `result.value.dispose()` then threw `QuickJSUseAfterFree` (crash, output masked); and an unnested `finally` meant a throwing `vm.dispose()` would skip `runtime.dispose()`, leaking the WASM heap permanently per call | `alive`-guard before dispose; nested `try/finally` so the runtime is always reclaimed |
| MEM-3 | LOW (pre-existing) | `superviseChildren` retained `specs` entries for children that never start (missing flow) | Reclaimed in the missing-flow branch |

**Verified clean**: all other sandbox handle paths (the evalCode error variant frees the
result pointer library-side — no handle to leak), `CachingContentStore` byte accounting
(cannot drift; nulls never cached; hard-bounded), the mcpInvoke snapshot closure, compiler
lint stack push/pop balance, per-batch resolution maps.

### Performance

| # | Path | Finding | Fix |
|---|---|---|---|
| PERF-A2 | hot under fan-out | `listTools` refresh had no in-flight dedup — K concurrent invokes at TTL expiry (exactly the `fanout$` case) fired K RPCs + K× re-hashing, K−1 discarded | Single-flight refresh (shared pending promise) |
| PERF-A3 | fold/read-model rebuild | `mcpDispatchIndex` used `Array.includes` scans + full spread per event — O(E²) per hot tool | O(1) membership `seen` record + O(1) no-op early return on repeat dispatches |
| PERF-A1 | live tail | `subscribe` allocated a Map per delivered event even for ref-free events (the common case) | Zero-allocation `hasContentRef` fast path restored; Map only for ref-bearing events |
| PERF-B1/B2 | warm | `fnv1a64` allocated a BigInt per byte + per-call TextEncoder; `canonicalJson` built per-node path strings for error messages that almost never throw | 256-entry BigInt table + module-level encoder + indexed loop; path strings replaced by the depth counter |
| PERF-B4 | per sandbox call | Input was evalCode'd as a JS object literal (engine parses input as source, charged against the caller's interrupt budget) | Seeded as a string global parsed in-VM via `JSON.parse`; guards installed *after* seeding so the script alone pays the budget |
| nits | — | `fetchBytes` double map iteration; per-call TextEncoder/Decoder in `encodeValue`/`decodeValue` | Single pass; hoisted singletons |

**Verified already optimal**: the fold's STEP_FAILED additions (no per-event regression for
untyped logs), the execute seam's typed-failure lookup (one property read on the happy
path — G2 holds), the two-phase batched resolution design itself, `CachingContentStore`
LRU O(1) claims, sandbox WASM-module caching.

## 2. Deferred, with rationale (not fixed by design)

- **Externalize-gated read walk** (skip `collectContentRefs` for event types absent from the
  `externalize` map): correct only if the map never narrows across deploys of the same log —
  a config-drift hazard the perf win doesn't justify today (pre-existing cost, not a DE
  regression). Revisit with the read-model plugin's retention story.
- **Two-lane `Math.imul` fnv1a64** (~20–50× over BigInt): no hot-path caller exists; the
  ADR 0065 discipline (measured need, not speculation) applies. The table/loop fixes took
  the cheap 2–3×.
- **`fanout$` `#`-separator guard** (the `childIdFor` asymmetry): rejecting `#` in base ids
  would break nested fanout, whose composed ids (`leaf#0#1`) are the documented idiom.
  Author-controlled ids; documented instead (ADR 0061 identity rule).
- **`mcpDispatchIndex` retention**: growth is one entry per distinct (tool, execution) pair
  by design — a repair *index*. Lifecycle belongs to the read-model store (ADR 0058), not
  the fold. Distinct-insert copies remain O(n) per event (immutable-fold idiom, same as the
  kernel's frames map).
- **Per-principal `listTools` cache / session isolation** (SEC-4 LOW): metadata-bleed only —
  the server enforces authz on `callTool`. Documented as one-client-per-trust-boundary;
  revisit if tool *visibility* becomes auth-scoped in a real deployment.

## 3. DX reachability outcome (fourth audit pass)

The P0 finding: **`analyzeLoopIdentity` — and the pre-existing `nonDeterministicByFlow`
verify input — were structurally unreachable** (lint, rule, and field all existed;
nothing invoked or populated them). Wired end-to-end:

- Compiler: `collectFlows` lints each flow-bearing module; findings surface as manifest
  warnings (ADR 0061 text) **and** the structured `ManifestFlow.loopIdentity` field —
  visible through `loomPlugin()` builds and `loom check`.
- `defineConfig({ verify: { lint: { nonDeterministicByFlow, loopIdentityByFlow } } })` —
  both determinism-lint paths now reach `@loom/verify` at boot (`error` mode fails boot).
- `@loom/sdk` barrel: `@loom/orchestration` (`fanout$`, `depthOf`, `awaitChild`) re-exported
  (previously unreachable — nothing depended on the package); `@loom/sdk/sandbox` subpath
  keeps the WASM dep out of the bare import.
- `registerEffects` seam on `defineConfig` — `registerMcpInvoke`/`registerSandboxEval`
  compose declaratively at boot (discovery supplies metadata; the seam supplies runnable
  effects).
- `loom new tool` scaffold now demonstrates the `errors:`/`fail` typed-channel contract.

Follow-ups: `examples/db-observability` has since been extended into the full
blueprint-interpreter demo (`fanout$` → `mcpInvoke$` → `sandboxEval$` over an in-process
MCP server, with a narrated schema-drift → typed-failure → in-band-repair pass — see its
README). Still open: wiring `loom verify` to auto-read the manifest's `loopIdentity` field.

## 4. Docs & diagrams synced

- `docs/spec/loom-kernel-specification.md` — event schema **1.17.0** + new §4.1 typed-failure
  semantics (record, cap, substitution, no-syscall); `docs/spec/compatibility-matrix.md` bumped.
- `docs/loom-2.0/10-event-schema-reference.md` — `STEP_FAILED` payload/fold updated (channel,
  payload, `errorChannel`/`errorPayload`, substitution) + version history line.
- `docs/user-guide.md` — new sections: typed failure channels (§3), dynamic MCP dispatch &
  sandboxed reshaping (§7), the step-identity rule under determinism pitfalls (§14).
- `docs/architecture.md` — §4.3.1 gains the typed-failure substitution sequence diagram
  (record → fold → substitute-on-replay).
- This document is the audit record; the fix commits reference finding ids (SEC-*/MEM-*/PERF-*).
