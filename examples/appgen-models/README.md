# Example — `loom appgen` with the model of your choice

A walkthrough of `loom appgen`'s **provider-agnostic** planning: point `--model` at Anthropic, OpenAI,
Gemini, or a local model — or use the deterministic parser with no model at all. This is
documentation, not a runnable package (no `package.json`), so it adds no build/test target; copy the
commands into a real Loom app to try them.

See [`docs/usage-cli.md`](../../docs/usage-cli.md#loom-appgen-intent--from-file--from-spec-file--dir--flags)
for the full flag reference, [ADR 0050](../../docs/adr/0050-appgen-model-provider-agnostic.md) for why
`--model` is provider-agnostic, and [`appgen-brownfield`](../appgen-brownfield) for surgical edits to an
existing app.

## How planning works

`loom appgen` turns a natural-language intent into a `ChangeSpec` (create/extend/modify/delete per
capability), then applies it as deterministic, offline code. **Exactly one stage reads NL** — the
planner — and it is provider-agnostic: the same `ChangeSpec` shape comes out whichever model you name.
If no model can produce a valid plan, appgen **falls back to the deterministic parser**, so it is never
left without a valid spec. The generated *code* is identical either way; provenance (`[deterministic]`
vs `[model]`) lives in the plan header and the `.loom/appgen/<ts>.spec.json` lockfile.

## 0. No model — the deterministic parser (runs anywhere, no key)

The default planner is a small **directive grammar**. It needs no model and no network:

```bash
loom appgen "Create a planner. Step summarize. Pause for approval." --dir ./planner --dry-run
```

Use `--offline` to force it even when `--model` is set. This is the path CI and reproducible builds use.

## 1. A hosted model — Anthropic / OpenAI / Gemini

Pass `--model <provider>:<model>`. The API key is read from the provider's environment variable
(checked up front — a missing key is a clear error, not a 401), and natural, compound phrasing works
because a real model interprets it:

```bash
# Anthropic (ANTHROPIC_API_KEY)
export ANTHROPIC_API_KEY=sk-ant-…
loom appgen "Add a summarize step to the planner and pause for approval." \
  --dir ./planner --model anthropic:claude-opus-4-8 --dry-run

# OpenAI (OPENAI_API_KEY)
export OPENAI_API_KEY=sk-…
loom appgen "Add a summarize step to the planner and pause for approval." \
  --dir ./planner --model openai:gpt-4o --dry-run

# Google Gemini (GEMINI_API_KEY)
export GEMINI_API_KEY=…
loom appgen "Add a summarize step to the planner and pause for approval." \
  --dir ./planner --model gemini:gemini-2.0-flash --dry-run
```

Any `@loom/llm` `LlmProvider` works; these three are wired **by name** for convenience.

## 2. A local model — fully offline (`.gguf`)

Install the optional planner in your project and point `--model` at a local model file:

```bash
pnpm add -D @loom/appgen-model node-llama-cpp
loom appgen "Add a summarize step to the planner and pause for approval." \
  --dir ./planner --model ./models/gemma-e4b.gguf --dry-run
# gemma:<path> and local:<path> are equivalent spellings.
```

Nothing leaves the machine. Only this path needs `node-llama-cpp`; the hosted providers above do not.

## 3. A cheap-first ladder (`--model-big`)

`appgen` runs planning through a confidence-gated elevation ladder. Name a **cheap** model for
`--model` and a **stronger** one for `--model-big`; a weak/low-confidence plan elevates automatically,
and each elevation is recorded (`[model, elevated …]`) in the header and lockfile:

```bash
loom appgen "Add a summarize step to the planner and pause for approval." --dir ./planner \
  --model gemini:gemini-2.0-flash --model-big anthropic:claude-opus-4-8 --dry-run
```

The tiers can mix providers — cheap Gemini → strong Claude, cheap local `.gguf` → strong OpenAI, etc.

## 4. Reproduce a run with no model (`--from-spec`)

Every apply records the accepted `ChangeSpec` to `.loom/appgen/<timestamp>.spec.json`. Replaying it is
**byte-for-byte reproducible and model-free** — so a plan produced once with any provider can be
re-applied in CI (or elsewhere) with no key and no network:

```bash
loom appgen "Add a summarize step…" --dir ./planner --model anthropic:claude-opus-4-8 --yes
# → writes ./planner/.loom/appgen/1783875332959.spec.json
loom appgen --from-spec ./planner/.loom/appgen/1783875332959.spec.json --dir ./elsewhere
```

## Choosing a provider

| Want | Use |
|---|---|
| No dependencies, deterministic, CI-safe | *(no `--model`)* / `--offline` |
| A model you already pay for | `anthropic:` / `openai:` / `gemini:` |
| Nothing leaves the machine (privacy) | a local `.gguf` (`@loom/appgen-model`) |
| Cheap-first with a strong fallback | `--model <cheap>` + `--model-big <strong>` |
| Reproduce a past plan with no model | `--from-spec <lockfile>` |
