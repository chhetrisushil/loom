# ADR 0011 — Folder convention + `loom gen`/`loom new` (build-time codegen)

- Status: Accepted (DX tooling — Phase 3)
- Date: 2026-07-07
- Builds on: [ADR 0010](0010-loom-cli.md)

## Context

The evaluation's top pick was a Next.js-style convention — but *reframed*: Loom
has no URL routing, so the value that transfers is **discovery + colocation +
zero-config registration, done at build time** (Next.js generates a route
manifest; it does not scan the filesystem at runtime). Runtime globbing would be
the env-dependent wiring that breaks deterministic replay (rejected in Tier 2A).

## Decision

**The convention:**
```
app/ flows/<name>/flow.ts   tools/<name>.ts   agents/<name>.ts   skills/<name>.ts
     schedules/<name>.ts    memories/<name>.ts   projections/<name>.ts
     middleware.ts  config.ts  loom.gen.ts (generated)
```

**Build-time codegen (`@loom/scaffold` + `loom gen`).**
`generateRegistration(flowPaths, agentPaths, toolPaths, skillPaths, schedulePaths, memoryPaths, projectionPaths)`
emits `loom.gen.ts` — a **static** module that imports each discovered module and
re-exports `flowModules` / `agentModules` / `toolModules` / `skillModules` /
`scheduleModules` / `memoryModules` / `projectionModules`, consumed by
`defineConfig({ ...all seven })` (the Tier-2A value-shape scan: `registerFlowsFrom` +
`agentDefinitionsFrom` / `toolDefinitionsFrom` / `skillDefinitionsFrom` /
`scheduleDefinitionsFrom` / `memoryDefinitionsFrom` / `projectionDefinitionsFrom`).
The imports are fixed at build time, so the set is identical on every resume /
remote worker — replay-safe by construction. `loom gen` is a lightweight fs walk
(`discoverFlows` / `discoverAgents` / `discoverTools` / `discoverSkills` /
`discoverSchedules` / `discoverMemories` / `discoverProjections`) deliberately
**decoupled** from the heavy handler-extraction compiler — the convention must not
drag it in.

> **Amendment (later PRs).** The original convention discovered only flows; agent,
> tool, skill, schedule, memory, and projection discovery were added incrementally.
> The rule for each: `loom gen` discovers a construct **iff a runtime consumes its
> definition** — agents feed the A2A/A2UI auto-wiring (behind opt-in flags), tools
> land on `app.tools`, skills register into `app.skills` (`SkillRegistry`), schedules
> merge into `app.schedules` + the `TimerService`, memories into `app.memory`
> (`MemoryRuntime`), projections fold into the projection runtime (their handler code
> loaded on demand — the compiler extracts each projection's fold map into its own
> `import()` chunk, event-type-gated). Discovery is by value shape (`_tag`), not AST
> parsing, so it is robust to how each construct is declared/exported. `policy$` is the
> one builder **not** discovered: it is enforced (a `PolicyAuthorizer` reads each flow's
> `policies` + `defineConfig({ policies })`) but is carried *inline on the flow
> definition*, not in an `app/policies/*` folder — nothing to generate. The gate is "a
> runtime consumes a discovered file."

**Sub-generators (`loom new [flow|agent|tool|skill|schedule|memory|projection] <name>`).**
Emit one file into the convention location; won't overwrite an existing file.

**Shared templating (`@loom/scaffold`).** Per-file templates (`flowFile`,
`toolFile`, `agentFile`, `skillFile`, `scheduleFile`, `memoryFile`, `projectionFile`,
`newFile`) + the
whole-app `appFiles` (now convention-following, with a pre-generated `loom.gen.ts`
so a scaffolded app runs out of the box). `create-loom-app` and `loom new` both
consume it — no duplicated templates.

Per ADR 0010, there is deliberately **no `loom create-app`** — whole-app
bootstrapping stays the idiomatic `create-loom-app` (`npm create loom-app`), and
in-project growth is `loom new`.

## Consequences

- Registration boilerplate disappears: add `app/flows/x/flow.ts`, run `loom gen`,
  done — no editing a central list. Replay-safe because it's static codegen.
- `create-loom-app`'s starter now follows the convention and demonstrates the full
  `loom new` → `loom gen` loop.
- New package `@loom/scaffold`; `@loom/cli` gains `gen`/`new`; `create-loom-app`
  slimmed to consume `@loom/scaffold`.

## Verification

- `@loom/scaffold` (7): `pascal`; `generateRegistration` (imports + array, empty);
  per-file templates export PascalCase constructs with no unresolved `${`;
  `newFile` routing; `appFiles` convention layout + pre-generated gen.
- `@loom/cli` (+4): `cmdNew` scaffolds / doesn't overwrite / rejects unknown kind;
  `discoverFlows` sorted; `cmdGen` writes a static module (and an empty array for
  an empty app). End-to-end binary smoke: `loom new flow ×2` → `loom gen` → a
  2-flow `loom.gen.ts`.
- Full repo: build + typecheck clean, 79/79 test tasks green, biome clean (546).
