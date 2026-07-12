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

/** Route `loom new <kind> <name>` to the file it generates (path + contents). */
export function newFile(
  kind: "flow" | "agent" | "tool",
  name: string
): { path: string; content: string } {
  switch (kind) {
    case "flow":
      return { path: `app/flows/${name}/flow.ts`, content: flowFile(name) };
    case "agent":
      return { path: `app/agents/${name}.ts`, content: agentFile(name) };
    case "tool":
      return { path: `app/tools/${name}.ts`, content: toolFile(name) };
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
      'import { flowModules } from "./loom.gen";',
      'import { middleware } from "./middleware";',
      "",
      "// The whole app, declared once. Flows are discovered from app/flows via",
      "// `loom gen` (app/loom.gen.ts). Swap storage to sqlite to add durability.",
      "export const app = defineConfig({",
      '  storage: { kind: "memory" },',
      "  flowModules,",
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
