# Example — brownfield `loom appgen`

A walkthrough of using `loom appgen` on an app that **already exists** — describing a delta and
letting appgen apply it surgically. This is documentation, not a runnable package (no `package.json`),
so it adds no build/test target; copy the commands into a real Loom app to try them.

See [`docs/usage-cli.md`](../../docs/usage-cli.md#loom-appgen-intent--from-file--from-spec-file--dir--flags)
for the full flag reference and [ADR 0042](../../docs/adr/0042-ai-native-brownfield-appgen.md) for the design.

## 0. Start from a generated app

```bash
loom appgen "Create a planner." --dir ./planner --yes
```

`./planner/app/flows/planner/flow.ts` now has a single `run` step with a `TODO` handler.

## 1. Preview a change as a diff (writes nothing)

The offline planner is a small **directive grammar** — name the flow (`Create a planner`) so the change
maps onto the existing one, then add `Step …` / `Pause for approval` / etc. (Natural, compound phrasing
like *"add a summarize step to the planner and pause for approval"* is what the `--model` planner in
step 5 is for.)

```bash
loom appgen "Create a planner. Step summarize. Pause for approval." --dir ./planner --dry-run
```

```
plan: update app → ./planner
  ~ edit   app/flows/planner/flow.ts
      • added step "summarize" (registered and wired into the runner)
      • added approval gate (ctx.suspend)
       const runStep = step$({ … });
      +
      +const summarizeStep = step$({
      +  id: "summarize",
      +  …
      +});
       const plannerRunner = async (ctx, input) => {
         const out = await ctx.run(runStep, { prompt: input.prompt });
      +  await ctx.run(summarizeStep, { prompt: input.prompt });
      +  await ctx.suspend({ on: "Approved" });
         return out;
       };

  ~ edit   app/loom.gen.ts (re-wire flow registration)

1 change, 0 skipped — run with --apply to write
```

Your hand-written code is never touched: appgen overwrites a handler body **only** if it still hashes
to the generated `TODO` stub. Edit `run`'s handler and re-run — appgen leaves it alone.

## 2. Apply it (with a typecheck)

On a TTY, appgen shows the plan and asks before writing; `--yes` skips the prompt.

```bash
loom appgen "Create a planner. Step summarize. Pause for approval." --dir ./planner --yes --check
```

It writes the edit, re-wires `app/loom.gen.ts`, records a spec lockfile under `.loom/appgen/`, and
typechecks the result.

## 3. Grant a tool, then delete a flow

```bash
loom appgen "Grant metrics-tool to planner." --dir ./planner --yes    # adds a GrantTable to app/config.ts
loom appgen "Create a reporter." --dir ./planner --yes                # a second flow
loom appgen "Delete the reporter." --dir ./planner --yes              # removes it (generated flows only)
```

`delete` refuses to remove a flow that carries hand-written code — remove those yourself.

## 4. Replay a generation with no model

Every apply writes `.loom/appgen/<timestamp>.spec.json`. Reproduce it byte-for-byte, anywhere, with no
NL and no model:

```bash
loom appgen --from-spec ./planner/.loom/appgen/<timestamp>.spec.json --dir ./planner-copy
```

## 5. (Optional) Plan with a local model

Install the optional planner and point `--model` at a local `.gguf`:

```bash
pnpm add @loom/appgen-model node-llama-cpp
loom appgen "Add a summarize step to the planner." --dir ./planner --model ./models/gemma-e4b.gguf --dry-run
```

If the model is missing, too weak, or produces an invalid plan, appgen falls back to the deterministic
parser — you always get a valid plan. See the
[`@loom/appgen-model` README](../../packages/appgen-model/README.md).
