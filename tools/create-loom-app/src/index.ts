#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Return the file map for a new Loom app — the ~10 files a developer writes,
 * wired via `defineConfig`: config, two tools, two steps, one flow, middleware,
 * a UI catalog stub, and an eval. Pure (no I/O) so it can be unit-tested.
 */
export function scaffoldFiles(appName: string): Record<string, string> {
  return {
    "package.json": `${JSON.stringify(
      {
        name: appName,
        private: true,
        type: "module",
        scripts: { start: "tsx src/main.ts", test: "vitest run" },
        dependencies: {
          "@loom/app": "workspace:*",
          "@loom/core": "workspace:*",
          "@loom/middleware": "workspace:*",
          zod: "^3.23.8",
        },
        devDependencies: { tsx: "^4.19.2", typescript: "^5.6.3", vitest: "^2.1.8" },
      },
      null,
      2
    )}\n`,

    "src/tools.ts": [
      'import { tool$ } from "@loom/core";',
      'import { z } from "zod";',
      "",
      "// Two tools the agent can call. Tools are declarative; their runtime effect",
      "// is provided when you register them (see src/config.ts).",
      "export const LookupTool = tool$({",
      '  id: "lookup-customer",',
      '  name: "Lookup Customer",',
      '  description: "Fetch a customer record by id.",',
      '  kind: "tool",',
      "  inputSchema: z.object({ customerId: z.string() }),",
      "  outputSchema: z.object({ name: z.string(), tier: z.string() }),",
      "});",
      "",
      "export const NotifyTool = tool$({",
      '  id: "notify",',
      '  name: "Notify",',
      '  description: "Send a notification to the customer.",',
      '  kind: "tool",',
      "  inputSchema: z.object({ to: z.string(), body: z.string() }),",
      "  outputSchema: z.object({ delivered: z.boolean() }),",
      "});",
      "",
    ].join("\n"),

    "src/steps.ts": [
      'import { handler$, step$ } from "@loom/core";',
      'import { z } from "zod";',
      "",
      "// Two steps with inline handlers. Handlers run inside the durable runtime;",
      "// their outputs are recorded in the event log and replayed, never re-run.",
      "export const LookupStep = step$({",
      '  id: "lookup",',
      '  name: "Lookup",',
      '  toolId: "lookup-customer",',
      "  inputSchema: z.object({ customerId: z.string() }),",
      "  outputSchema: z.object({ name: z.string(), tier: z.string() }),",
      "  handler: handler$(async (input: { customerId: string }) => ({",
      '    name: "Ada Lovelace",',
      '    tier: "gold",',
      "  })),",
      "});",
      "",
      "export const GreetStep = step$({",
      '  id: "greet",',
      '  name: "Greet",',
      '  toolId: "notify",',
      "  inputSchema: z.object({ name: z.string() }),",
      "  outputSchema: z.object({ greeting: z.string() }),",
      "  handler: handler$(async (input: { name: string }) => ({",
      '    greeting: "Hello, " + input.name + "!",',
      "  })),",
      "});",
      "",
    ].join("\n"),

    "src/flow.ts": [
      'import { flow$ } from "@loom/core";',
      'import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";',
      'import { z } from "zod";',
      'import { GreetStep, LookupStep } from "./steps";',
      "",
      "const runner: FlowRunner<{ customerId: string }, { greeting: string }> = async (ctx, input) => {",
      "  const customer = (await ctx.run(LookupStep, { customerId: input.customerId })) as {",
      "    name: string;",
      "  };",
      "  return (await ctx.run(GreetStep, { name: customer.name })) as { greeting: string };",
      "};",
      "",
      "export const GreetFlow: RegisteredFlow = {",
      "  definition: flow$({",
      '    id: "greet-customer",',
      '    name: "Greet Customer",',
      '    version: "1.0.0",',
      "    inputSchema: z.object({ customerId: z.string() }),",
      "    outputSchema: z.object({ greeting: z.string() }),",
      "    steps: [LookupStep, GreetStep],",
      "  }),",
      "  runner: runner as FlowRunner<unknown, unknown>,",
      "};",
      "",
    ].join("\n"),

    "src/middleware.ts": [
      'import { retryMiddleware } from "@loom/middleware";',
      "",
      "// Cross-cutting effect middleware, applied in order (middleware[0] outermost).",
      "// Retries are replay-safe: never applied to already-completed steps, and never",
      "// to a suspend or a cancellation.",
      "export const middleware = [retryMiddleware({ maxRetries: 2 })];",
      "",
    ].join("\n"),

    "src/config.ts": [
      'import { defineConfig } from "@loom/app";',
      'import { ToolEffect } from "@loom/effect-runtime";',
      'import { GreetFlow } from "./flow";',
      'import { middleware } from "./middleware";',
      "",
      "// The whole app, declared once. Swap storage to sqlite + a real LLM provider",
      "// to go to production — nothing else changes.",
      "export const app = defineConfig({",
      '  storage: { kind: "memory" },',
      "  flows: [GreetFlow],",
      "  effectMiddleware: middleware,",
      "});",
      "",
      "// Provide the runtime effects for the two tools.",
      'app.effectRuntime.register("lookup-customer", new ToolEffect(async () => ({ name: "Ada Lovelace", tier: "gold" })));',
      'app.effectRuntime.register("notify", new ToolEffect(async () => ({ delivered: true })));',
      "",
    ].join("\n"),

    "src/ui.ts": [
      "// UI catalog stub — map your A2UI surfaces to renderers here. See",
      "// @loom/renderer-react or @loom/renderer-terminal for the real thing.",
      "export const surfaces = [] as const;",
      "",
    ].join("\n"),

    "src/main.ts": [
      'import { app } from "./config";',
      'import { GreetFlow } from "./flow";',
      "",
      "async function main() {",
      '  const handle = await app.runtime.start(GreetFlow, { customerId: "c-1" });',
      "  const state = await handle.waitForCompletion();",
      "  console.log(state.variables._output);",
      "  await app.close();",
      "}",
      "",
      "void main();",
      "",
    ].join("\n"),

    "src/greet.test.ts": [
      'import { describe, expect, it } from "vitest";',
      'import { app } from "./config";',
      'import { GreetFlow } from "./flow";',
      "",
      "// A minimal eval: run the flow and assert its output. For richer",
      "// log-as-fixture / scoring evals, see @loom/eval.",
      'describe("greet-customer", () => {',
      '  it("greets the looked-up customer", async () => {',
      '    const handle = await app.runtime.start(GreetFlow, { customerId: "c-1" });',
      "    const state = await handle.waitForCompletion();",
      '    expect((state.variables._output as { greeting: string }).greeting).toContain("Hello");',
      "  });",
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
        include: ["src/**/*"],
      },
      null,
      2
    )}\n`,

    "README.md": [
      `# ${appName}`,
      "",
      "A Loom app scaffolded with `create-loom-app`. Everything is wired in",
      "`src/config.ts` via `defineConfig`.",
      "",
      "```sh",
      "pnpm install",
      "pnpm start   # run the flow once",
      "pnpm test    # run the eval",
      "```",
      "",
      "Files: `tools.ts` + `steps.ts` + `flow.ts` (your logic), `middleware.ts`",
      "(cross-cutting), `config.ts` (the app), `main.ts` (entry), `greet.test.ts`",
      "(eval).",
      "",
    ].join("\n"),
  };
}

function main(argv: string[]): void {
  const target = argv[2];
  if (!target) {
    console.error("usage: create-loom-app <directory>");
    process.exitCode = 1;
    return;
  }
  const root = path.resolve(process.cwd(), target);
  const appName = path.basename(root);
  const files = scaffoldFiles(appName);
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  console.log(`Scaffolded ${Object.keys(files).length} files into ${target}/`);
  console.log(`Next: cd ${target} && pnpm install && pnpm test`);
}

// Run only when invoked as a CLI (not when imported by tests).
if (process.argv[1]?.endsWith("index.js")) {
  main(process.argv);
}
