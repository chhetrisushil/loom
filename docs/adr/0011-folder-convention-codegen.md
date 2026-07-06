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
app/ flows/<name>/flow.ts   tools/<name>.ts   agents/<name>.ts
     middleware.ts  config.ts  loom.gen.ts (generated)
```

**Build-time codegen (`@loom/scaffold` + `loom gen`).**
`generateRegistration(importPaths)` emits `loom.gen.ts` — a **static** module that
imports each flow module and re-exports `flowModules`, consumed by
`defineConfig({ flowModules })` (the Tier-2A `registerFlowsFrom` shape-scan). The
imports are fixed at build time, so the flow set is identical on every resume /
remote worker — replay-safe by construction. `loom gen` is a lightweight fs walk
(`discoverFlows`) deliberately **decoupled** from the heavy handler-extraction
compiler (1/9 adoption — the convention must not drag it in).

**Sub-generators (`loom new [flow|agent|tool] <name>`).** Emit one file into the
convention location; won't overwrite an existing file.

**Shared templating (`@loom/scaffold`).** Per-file templates (`flowFile`,
`toolFile`, `agentFile`, `newFile`) + the whole-app `appFiles` (now convention-
following, with a pre-generated `loom.gen.ts` so a scaffolded app runs out of the
box). `create-loom-app` and `loom new` both consume it — no duplicated templates.

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
