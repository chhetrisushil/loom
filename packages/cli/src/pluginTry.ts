import { resolve } from "node:path";
import { defineConfig } from "@loom/app";
import { flow$, handler$, step$ } from "@loom/core";
import type { CustomStorage } from "@loom/plugin-kit";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

export interface TryResult {
  preset: string;
  completed: boolean;
  eventsPersisted: number;
  replayOk: boolean;
  ok: boolean;
}

/** Find the storage preset to try: a named export, else the first `*Storage` function. */
function resolvePresetName(mod: Record<string, unknown>, requested?: string): string {
  if (requested !== undefined) return requested;
  const named = Object.keys(mod).find((k) => typeof mod[k] === "function" && /Storage$/.test(k));
  const anyFn = Object.keys(mod).find((k) => typeof mod[k] === "function");
  const found = named ?? anyFn;
  if (found === undefined) throw new Error("no exported function found — pass --preset <name>");
  return found;
}

const SMOKE = "loom-plugin-try-smoke";

/**
 * Wire a `custom` storage descriptor into a real Loom app, run a durable one-step
 * flow, and confirm it persisted and replays. Pure over the descriptor (no disk /
 * module loading), so it is unit-testable with any store.
 */
export async function trySmoke(storage: CustomStorage, presetLabel: string): Promise<TryResult> {
  const io = z.object({ n: z.number() });
  const smokeStep = step$({
    id: "smoke-step",
    inputSchema: io,
    outputSchema: io,
    handler: handler$(async (i: { n: number }) => ({ n: i.n + 1 })),
  });
  const smokeFlow: RegisteredFlow = {
    definition: flow$({
      id: SMOKE,
      name: "PluginTry",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: io,
      steps: [smokeStep as never],
    }),
    runner: ((ctx, input) => ctx.run(smokeStep as never, input)) as FlowRunner<unknown, unknown>,
  };

  const app = defineConfig({ storage, flows: [smokeFlow] });
  try {
    const handle = await app.runtime.start(smokeFlow, { n: 1 });
    const state = await handle.waitForCompletion();
    const completed = state.status === "completed";
    const events = await app.stores.eventStore.read(handle.executionId);
    // Reload purely from the durable store — proves the plugin persisted a replayable log.
    const reloaded = await app.runtime.loadState(handle.executionId);
    const replayOk = reloaded?.status === "completed" && reloaded.sequence === state.sequence;
    return {
      preset: presetLabel,
      completed,
      eventsPersisted: events.length,
      replayOk: replayOk === true,
      ok: completed && events.length > 0 && replayOk === true,
    };
  } finally {
    await app.close();
  }
}

/**
 * `loom plugin try --module <path> [--preset <name>] [--options <json>]` — import a
 * store plugin's built module, call its preset, and run {@link trySmoke}. The
 * end-to-end check that `check` (static) and conformance (per-SPI) can't give: does
 * the plugin actually work wired into an app?
 */
export async function cmdPluginTry(opts: {
  module: string;
  preset?: string;
  options?: string;
}): Promise<TryResult> {
  // A path is resolved to an absolute path; a bare specifier is left for Node. (In this
  // CJS CLI, `import()` downlevels to `require()`, which takes a path, not a file:// URL.)
  const isPath = opts.module.startsWith(".") || opts.module.startsWith("/");
  const spec = isPath ? resolve(opts.module) : opts.module;
  const mod = (await import(spec)) as Record<string, unknown>;

  const presetName = resolvePresetName(mod, opts.preset);
  const preset = mod[presetName] as (options?: unknown) => CustomStorage;
  if (typeof preset !== "function") throw new Error(`export "${presetName}" is not a function`);

  const storage = preset(opts.options !== undefined ? JSON.parse(opts.options) : undefined);
  return trySmoke(storage, presetName);
}
