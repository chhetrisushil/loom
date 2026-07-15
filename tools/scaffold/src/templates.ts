import { generateRegistration, pascal } from "./codegen";

// ── Per-file templates (used by `loom new`, following the folder convention) ──

/** `app/flows/<name>/flow.ts` — a self-contained echo flow. */
export function flowFile(name: string): string {
  const P = pascal(name);
  return [
    'import { flow$, handler$, step$ } from "@loom/core";',
    'import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";',
    'import { z } from "zod";',
    "",
    `const ${P}Step = step$({`,
    `  id: "${name}-step",`,
    `  name: "${P}",`,
    "  inputSchema: z.object({ input: z.string() }),",
    "  outputSchema: z.object({ output: z.string() }),",
    "  handler: handler$(async (i: { input: string }) => ({ output: i.input })),",
    "});",
    "",
    "const runner: FlowRunner<{ input: string }, { output: string }> = (ctx, input) =>",
    `  ctx.run(${P}Step, input) as Promise<{ output: string }>;`,
    "",
    `export const ${P}Flow: RegisteredFlow = {`,
    "  definition: flow$({",
    `    id: "${name}",`,
    `    name: "${P}",`,
    '    version: "1.0.0",',
    "    inputSchema: z.object({ input: z.string() }),",
    "    outputSchema: z.object({ output: z.string() }),",
    `    steps: [${P}Step],`,
    "  }),",
    "  runner: runner as FlowRunner<unknown, unknown>,",
    "};",
    "",
  ].join("\n");
}

/** `app/flows/<name>/flow.ts` — a schedule-driven sentinel starter (@loom/plugin-sentinel). */
export function sentinelFile(name: string): string {
  const P = pascal(name);
  return [
    "// The perpetual-agent pattern (ADRs 0051-0057): a schedule over bounded runs.",
    "// Wire preset.schedule into defineConfig({ timers }), preset.middleware into",
    "// effectMiddleware, call preset.register(app.effectRuntime), and feed",
    "// preset.pinnedEventTypes to `loom sweep content --pin`.",
    'import { flow$ } from "@loom/core";',
    'import { isClaimCheck } from "@loom/middleware";',
    'import { sentinelPreset } from "@loom/plugin-sentinel";',
    'import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";',
    'import { z } from "zod";',
    "",
    "const stateSchema = z.object({ wakes: z.number() }); // TODO: your carry-state contract",
    "",
    `export const ${P}Preset = sentinelPreset<z.infer<typeof stateSchema>>({`,
    `  id: "${name}",`,
    '  cron: "0 */6 * * *", // TODO: cadence',
    "  state: { schema: stateSchema },",
    "  stateStore: undefined as never, // TODO: durable-state backend (sqlite/postgres)",
    "  contentStore: undefined as never, // TODO: content backend (SqliteContentStore)",
    "});",
    "",
    "const io = z.object({}).passthrough();",
    "",
    "const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {",
    `  const carried = await ${P}Preset.state.load(ctx);`,
    "  // TODO: observe via your tool$ (recorded; over-cap results go by reference):",
    "  // const read = await ctx.execute(readTask, { at: Preset.occurrenceOf(ctx.executionId) });",
    "  // if (isClaimCheck(read) && (read.digest as YourDigest).metric > threshold) {",
    '  //   ctx.emit("FINDING_RECORDED", { evidence: [read.ref] /* + your schema */ });',
    "  // }",
    "  void isClaimCheck;",
    `  await ${P}Preset.state.save(ctx, { wakes: (carried.value?.wakes ?? 0) + 1 }, carried.revision);`,
    "  return { ok: true };",
    "};",
    "",
    `export const ${P}Flow: RegisteredFlow = {`,
    "  definition: flow$({",
    `    id: "${name}-flow",`,
    `    name: "${P} sentinel",`,
    '    version: "1.0.0",',
    "    inputSchema: io,",
    "    outputSchema: io,",
    "    steps: [],",
    "  }),",
    "  runner: runner as FlowRunner<unknown, unknown>,",
    "};",
    "",
  ].join("\n");
}

/** `app/tools/<name>.ts` — a tool definition stub. */
export function toolFile(name: string): string {
  const P = pascal(name);
  return [
    'import { tool$ } from "@loom/core";',
    'import { z } from "zod";',
    "",
    `export const ${P}Tool = tool$({`,
    `  id: "${name}",`,
    `  name: "${P}",`,
    `  description: "TODO: describe ${name}.",`,
    '  kind: "tool",',
    "  inputSchema: z.object({}),",
    "  outputSchema: z.object({}),",
    "});",
    "",
  ].join("\n");
}

/** `app/agents/<name>.ts` — an agent definition stub. */
export function agentFile(name: string): string {
  const P = pascal(name);
  return [
    'import { agent$ } from "@loom/core";',
    "",
    `export const ${P}Agent = agent$({`,
    `  id: "${name}",`,
    `  name: "${P}",`,
    `  description: "TODO: describe ${name}.",`,
    "  tools: [],",
    "});",
    "",
  ].join("\n");
}

/** `app/skills/<name>.ts` — a skill definition stub (instructions stay lazy). */
export function skillFile(name: string): string {
  const P = pascal(name);
  return [
    'import { instructions$, skill$ } from "@loom/core";',
    "",
    `export const ${P}Skill = skill$({`,
    `  id: "${name}",`,
    `  name: "${P}",`,
    `  description: "TODO: describe ${name}.",`,
    "  tags: [],",
    `  instructions: instructions$("TODO: write the ${name} instructions."),`,
    "});",
    "",
  ].join("\n");
}

/** `app/schedules/<name>.ts` — a cron schedule stub (points at a flow to start). */
export function scheduleFile(name: string): string {
  const P = pascal(name);
  return [
    'import { schedule$ } from "@loom/core";',
    "",
    `export const ${P}Schedule = schedule$({`,
    `  id: "${name}",`,
    '  cron: "0 * * * *", // hourly (UTC); 5-field cron',
    `  flowId: "TODO-flow-id", // the registered flow each occurrence starts`,
    "});",
    "",
  ].join("\n");
}

/** `app/memories/<name>.ts` — a named memory definition stub. */
export function memoryFile(name: string): string {
  const P = pascal(name);
  return [
    'import { memory$ } from "@loom/core";',
    "",
    `export const ${P}Memory = memory$({`,
    `  id: "${name}",`,
    `  name: "${P}",`,
    "  // ttlMs / maxEntries bound each scope; omit for unbounded.",
    "});",
    "",
  ].join("\n");
}

/** `app/projections/<name>.ts` — a projection stub (handlers fold events; loaded on demand). */
export function projectionFile(name: string): string {
  const P = pascal(name);
  return [
    'import { projection$ } from "@loom/core";',
    "",
    `export const ${P}Projection = projection$({`,
    `  id: "${name}",`,
    `  name: "${P}",`,
    "  initialState: { count: 0 },",
    "  // The fold map: one reducer per event type. The @loom/compiler plugin extracts this",
    "  // into its own chunk, loaded on demand the first time a handled event fires.",
    "  handlers: {",
    "    STEP_COMPLETED: (state, _event) => ({ count: state.count + 1 }),",
    "  },",
    "});",
    "",
  ].join("\n");
}

/** Route `loom new <kind> <name>` to the file it generates (path + contents). */
export function newFile(
  kind: "flow" | "agent" | "tool" | "skill" | "schedule" | "memory" | "projection" | "sentinel",
  name: string
): { path: string; content: string } {
  switch (kind) {
    case "sentinel":
      return { path: `app/flows/${name}/flow.ts`, content: sentinelFile(name) };
    case "flow":
      return { path: `app/flows/${name}/flow.ts`, content: flowFile(name) };
    case "agent":
      return { path: `app/agents/${name}.ts`, content: agentFile(name) };
    case "tool":
      return { path: `app/tools/${name}.ts`, content: toolFile(name) };
    case "skill":
      return { path: `app/skills/${name}.ts`, content: skillFile(name) };
    case "schedule":
      return { path: `app/schedules/${name}.ts`, content: scheduleFile(name) };
    case "memory":
      return { path: `app/memories/${name}.ts`, content: memoryFile(name) };
    case "projection":
      return { path: `app/projections/${name}.ts`, content: projectionFile(name) };
  }
}

// ── Whole-app scaffold (used by create-loom-app), following the convention ────

export function appFiles(appName: string): Record<string, string> {
  return {
    "package.json": `${JSON.stringify(
      {
        name: appName,
        private: true,
        // CommonJS (no "type": "module") — @loom/* publish require-only exports, so
        // `tsx app/main.ts` must resolve them via CJS (matches examples/loom-starter).
        scripts: {
          start: "tsx app/main.ts",
          test: "vitest run",
          gen: "loom gen --dir app",
        },
        dependencies: {
          "@loom/app": "workspace:*",
          "@loom/core": "workspace:*",
          "@loom/middleware": "workspace:*",
          zod: "^3.23.8",
        },
        devDependencies: {
          "@loom/cli": "workspace:*",
          tsx: "^4.19.2",
          typescript: "^5.6.3",
          vitest: "^2.1.8",
        },
      },
      null,
      2
    )}\n`,

    "loom.config.ts": ['export { app as default } from "./app/config";', ""].join("\n"),

    "app/flows/greet/flow.ts": flowFile("greet"),

    // Pre-generated so the app runs out of the box; re-run `pnpm gen` after
    // adding flows with `loom new flow <name>`.
    "app/loom.gen.ts": generateRegistration(["./flows/greet/flow"]),

    "app/middleware.ts": [
      'import { retryMiddleware } from "@loom/middleware";',
      "",
      "// Cross-cutting effect middleware, applied in order (middleware[0] outermost).",
      "export const middleware = [retryMiddleware({ maxRetries: 2 })];",
      "",
    ].join("\n"),

    "app/config.ts": [
      'import { defineConfig } from "@loom/app";',
      'import { agentModules, flowModules, projectionModules, skillModules, toolModules } from "./loom.gen";',
      'import { middleware } from "./middleware";',
      "",
      "// The whole app, declared once. Flows/agents/tools/skills/projections are discovered",
      "// from app/{flows,agents,tools,skills,projections} via `loom gen` (app/loom.gen.ts). Set",
      "// `a2a: true` to auto-expose agents on the A2A bus. Swap storage to sqlite for durability.",
      "export const app = defineConfig({",
      '  storage: { kind: "memory" },',
      "  flowModules,",
      "  agentModules, // set a2a: true / a2ui: true to auto-wire discovered agents",
      "  toolModules, // discovered tool definitions on app.tools; register effects yourself",
      "  skillModules, // discovered skills registered into app.skills (app.skills.find(query))",
      "  projectionModules, // discovered projections folded into the projection runtime",
      "  effectMiddleware: middleware,",
      "});",
      "",
    ].join("\n"),

    "app/main.ts": [
      'import { app } from "./config";',
      'import { GreetFlow } from "./flows/greet/flow";',
      "",
      "async function main() {",
      '  const handle = await app.runtime.start(GreetFlow, { input: "world" });',
      "  const state = await handle.waitForCompletion();",
      "  console.log(state.variables._output);",
      "  await app.close();",
      "}",
      "",
      "void main();",
      "",
    ].join("\n"),

    "app/greet.test.ts": [
      'import { describe, expect, it } from "vitest";',
      'import { app } from "./config";',
      'import { GreetFlow } from "./flows/greet/flow";',
      "",
      "// A minimal eval. For log-as-fixture / scoring evals, see @loom/eval and",
      "// `loom eval`.",
      'describe("greet", () => {',
      '  it("runs the flow end to end", async () => {',
      '    const handle = await app.runtime.start(GreetFlow, { input: "world" });',
      "    const state = await handle.waitForCompletion();",
      '    expect((state.variables._output as { output: string }).output).toBe("world");',
      "    await app.close();",
      "  });",
      "});",
      "",
    ].join("\n"),

    "vitest.config.ts": [
      'import { defineConfig } from "vitest/config";',
      "",
      "export default defineConfig({",
      "  // @loom/* publish require-only exports — resolve them the same way under Vite.",
      '  resolve: { conditions: ["require", "default"] },',
      '  test: { environment: "node" },',
      "});",
      "",
    ].join("\n"),

    "tsconfig.json": `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "CommonJS",
          moduleResolution: "Node",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
        include: ["app/**/*"],
      },
      null,
      2
    )}\n`,

    "README.md": [
      `# ${appName}`,
      "",
      "A Loom app scaffolded with `create-loom-app`, following the folder convention:",
      "",
      "```",
      "app/",
      "  flows/<name>/flow.ts   your flows (add with: loom new flow <name>)",
      "  tools/<name>.ts        tools     (loom new tool <name>)",
      "  agents/<name>.ts       agents    (loom new agent <name>)",
      "  skills/<name>.ts       skills    (loom new skill <name>)",
      "  schedules/<name>.ts    schedules (loom new schedule <name>)",
      "  memories/<name>.ts     memories  (loom new memory <name>)",
      "  projections/<name>.ts  projections (loom new projection <name>)",
      "  middleware.ts          cross-cutting effect middleware",
      "  config.ts              the app (defineConfig)",
      "  loom.gen.ts            generated flow registration (pnpm gen)",
      "```",
      "",
      "```sh",
      "pnpm install",
      "pnpm start   # run the flow once",
      "pnpm test    # run the eval",
      "pnpm gen     # regenerate app/loom.gen.ts after adding flows",
      "```",
      "",
    ].join("\n"),
  };
}
