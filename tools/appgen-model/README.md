# @loom/appgen-model

Local-model planner for `loom appgen`. It replaces the deterministic grammar parser
(Stage 2 of the appgen pipeline) with a small **on-device Gemma model** — so intent →
`ChangeSpec` planning gets real language understanding with **no token cost and a minimal,
transient memory footprint**. It emits only a `ChangeSpec`; codegen never sees raw NL.

This package is **optional**. `@loom/appgen` and `loom appgen` work fully without it
(deterministic parser). Install this only to enable `loom appgen --model <gguf>`.

## How it works

- **Grammar-constrained JSON.** The model is constrained to the `ChangeSpec` JSON schema
  (`changeSpecJsonSchema`) via node-llama-cpp, so a compact model reliably emits valid,
  on-schema output.
- **Reasoning-ladder-on-itself.** Planning runs through `@loom/reasoning`'s cheap-first
  elevation ladder. The confidence signal is a *validator* — "does the output parse into a
  usable `ChangeSpec`?" — so a weak tier that emits junk elevates to a stronger one, and
  each elevation is logged (P9 / `DECISION_RECORDED`) and recorded in the spec lockfile.
- **Deterministic fallback.** If the model (or node-llama-cpp) is unavailable, or every
  tier fails validation, it falls back to `planChangesDeterministic` — exactly what
  `--offline` does. The pipeline is never left without a valid `ChangeSpec`.
- **Footprint discipline.** The model is loaded and disposed **per invocation** (transient,
  not resident); context is kept small; and the prompt carries only the compact scanned
  `AppModel` summary — never raw file contents (where KV-cache memory would balloon).

## Recommended tiers

| tier | key   | ~RAM (4-bit) | use                                        |
| ---- | ----- | ------------ | ------------------------------------------ |
| 0    | `e2b` | ~4 GB        | floor — greenfield schema-fill             |
| 0    | `e4b` | ~5 GB        | **default** — brownfield planning (QAT)    |
| 1    | `12b` | ~8 GB        | ceiling — vague intent / large repo        |

Treat the *tier* as the contract and pin the exact `.gguf` at install time.

## Local bring-up

```bash
# 1. install this package + the optional native runtime
pnpm add @loom/appgen-model node-llama-cpp

# 2. fetch a 4-bit QAT Gemma .gguf into ./models (E4B recommended)

# 3. plan with the model; --model-big adds a stronger elevation tier
loom appgen "add an approval gate to the planner flow" \
  --model ./models/gemma-e4b.gguf --dry-run
```

## Programmatic use

```ts
import { scanApp } from "@loom/appgen";
import { gemmaRoute, planChangesModel } from "@loom/appgen-model";

const appModel = scanApp(".");
const changeSpec = await planChangesModel("add an approval gate to the planner flow", appModel, {
  routes: [gemmaRoute("./models/gemma-e4b.gguf", "e4b"), gemmaRoute("./models/gemma-12b.gguf", "12b")],
});
```

`planChangesModel` also accepts any `LlmProvider` route (not just Gemma), and a `decide`
sink to log elevations durably.

## Requirements & caveats (from real end-to-end testing)

- **Node LTS.** node-llama-cpp's native binding is stable on Node 20/22 LTS. On very new Node
  majors (e.g. 25) we observed intermittent native segfaults during inference. Use an LTS.
- **RAM ↔ tier.** A 2B-class model (~1.6 GB Q4) fits an 8 GB machine but is often too weak — it
  tends to emit an empty `capabilities` array under the JSON grammar, which the validator
  rejects and the planner then falls back to deterministic. Use the **E4B** default (~5 GB, needs
  ≥16 GB comfortably) or the 12B ceiling for real planning quality; 2B is fine only for the
  simplest greenfield fills.
- **Graceful by design.** Whatever the model does — junk output, a missing native dep, even a
  crash on load — `loom appgen` degrades to the deterministic parser and still produces a valid
  `ChangeSpec`. The model is a quality upgrade, never a hard dependency.
