# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

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
