# ADR 0050 — appgen `--model` is provider-agnostic (any model, not just local Gemma)

- Status: **Accepted (implemented 2026-07-13)** — `@loom/llm` gains a `GeminiProvider`; the CLI
  `--model` flag takes a provider spec (PR).
- Date: 2026-07-13
- Amends: [ADR 0042](0042-ai-native-brownfield-appgen.md) (AI-native brownfield appgen) — specifically
  its "optional **local Gemma** model" framing.
- Builds on: the existing `@loom/llm` `LlmProvider` SPI + `@loom/reasoning` `ModelRoute` ladder.

## Context

ADR 0042 shipped the appgen NL→plan stage with an optional model behind `@loom/appgen-model`, framed
as a **local Gemma** planner (`--model <gguf>` + `node-llama-cpp`). In review that default looked
**premature**: it pinned users to a local model with a multi-GB download and a native dependency, when
most would rather point appgen at a model they already use (Anthropic, OpenAI, Gemini, …).

Crucially, the *architecture* was already right: `planChangesModel(intent, appModel, { routes })`
takes `@loom/reasoning` `ModelRoute`s, each carrying **any `LlmProvider`**. Only two things pinned it
to Gemma: the CLI `--model <gguf>` flag (which only built a `gemmaRoute`) and the framing/docs. So
this is not a rewrite — it's exposing the pluggability that was already there.

## Decision

**`--model` takes a provider spec; the planner reasons over whichever model is named.**

- `--model anthropic:<model>` / `openai:<model>` / `gemini:<model>` → the matching `@loom/llm`
  provider, API key from the provider's env var (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
  `GEMINI_API_KEY`), checked upfront with a clear error.
- `--model <path>.gguf` / `gemma:<path>` / `local:<path>` → the local Gemma provider (the optional
  `@loom/appgen-model` + `node-llama-cpp`), exactly as before — now one option among several, not the
  only one.
- `--model-big <spec>` names a stronger tier for the cheap-first elevation ladder; any spec form.

To make the three named API providers concrete, `@loom/llm` gains a **`GeminiProvider`** (a thin
`fetch` client, same shape as `OpenAiProvider`/`AnthropicProvider`). Any `LlmProvider` works
programmatically; these are wired **by name** in the CLI for convenience.

The fallback contract is unchanged: a missing key/provider, a too-weak model, or an unparseable plan
falls back to the deterministic parser — appgen is never left without a valid `ChangeSpec`.

## Consequences

- Local Gemma is no longer privileged — it's the **offline** option, chosen deliberately, not by
  default. Users bring the model they already pay for. `@loom/appgen-model` stays optional and lazily
  loaded (its `node-llama-cpp` native dep is only needed for the local `.gguf` path).
- The spec-resolution seam lives in the CLI (`routeFromSpec`), keeping `@loom/appgen`/`@loom/appgen-model`
  free of provider-selection policy. New providers drop in by adding an `LlmProvider` to `@loom/llm`
  and one `case` to the resolver.
- No change to determinism/provenance: the plan header + lockfile still record which planner ran; the
  generated code is identical regardless of model.
- Cost/privacy is now the user's explicit choice (local vs. a hosted API), rather than an implicit
  local-only default — which is what made the original framing feel wrong.
