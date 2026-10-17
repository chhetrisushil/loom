import { pascalIdent } from "./codegen";
import { commentText, templateLiteralText, tsStringLiteral } from "./emit";

// ── Non-agentic flow templates (`loom new flow <name> --template approval|timer|saga`) ──
//
// The echo flow is the default. These three are the plain-workflow on-ramp: a human gate, a
// durable timer, and compensation. Each ships a sibling test that runs on a fresh scaffold
// (`@loom/testing`'s time travel drives the timers; nothing sleeps for real).

export const FLOW_TEMPLATES = ["echo", "approval", "timer", "saga"] as const;
export type FlowTemplate = (typeof FLOW_TEMPLATES)[number];

export function isFlowTemplate(value: string): value is FlowTemplate {
  return (FLOW_TEMPLATES as readonly string[]).includes(value);
}

// ── approval ──────────────────────────────────────────────────────────────────

/** Suspend on a typed resume gate (`resumeSchemas`), with a 24h expiry. */
export function approvalFlowFile(name: string): string {
  const P = pascalIdent(name);
  return [
    'import { flow$, handler$, step$ } from "@loom/core";',
    'import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";',
    'import { z } from "zod";',
    "",
    "// The gate's contract. `resume()` parses the payload against `resumeSchemas` BEFORE it is",
    "// appended, so a wrongly-shaped approval is refused instead of becoming a permanent fact.",
    `const ${P}Decision = z.object({ approved: z.boolean(), approvedBy: z.string() });`,
    "",
    `const ${P}Apply = step$({`,
    `  id: ${tsStringLiteral(`${name}-apply`)},`,
    `  name: "${P} apply",`,
    "  inputSchema: z.object({ target: z.string() }),",
    "  outputSchema: z.object({ applied: z.boolean() }),",
    "  handler: handler$(async (_i: { target: string }) => ({ applied: true })),",
    "});",
    "",
    `type ${P}Out = { status: "applied" | "rejected" | "expired"; approvedBy?: string };`,
    "",
    `const runner: FlowRunner<{ target: string }, ${P}Out> = async (ctx, input) => {`,
    "  // Durable checkpoint: the execution parks in storage (it survives a restart) until someone",
    "  // answers the gate or the timeout passes. A timeout resumes with a TIMER_FIRED payload",
    "  // ({ wakeAt }), which is not a decision - so parse what came back.",
    "  const answer = await ctx.suspend<unknown>({",
    '    on: "ApprovalGranted",',
    "    correlationKey: input.target,",
    "    timeout: 24 * 60 * 60 * 1000, // 24h",
    "  });",
    `  const parsed = ${P}Decision.safeParse(answer);`,
    '  if (!parsed.success) return { status: "expired" };',
    "  const decision = parsed.data;",
    '  if (!decision.approved) return { status: "rejected", approvedBy: decision.approvedBy };',
    `  await ctx.run(${P}Apply, { target: input.target });`,
    '  return { status: "applied", approvedBy: decision.approvedBy };',
    "};",
    "",
    `export const ${P}Flow: RegisteredFlow = {`,
    "  definition: flow$({",
    `    id: ${tsStringLiteral(name)},`,
    `    name: "${P}",`,
    '    version: "1.0.0",',
    "    inputSchema: z.object({ target: z.string() }),",
    '    outputSchema: z.object({ status: z.enum(["applied", "rejected", "expired"]), approvedBy: z.string().optional() }),',
    `    steps: [${P}Apply],`,
    `    resumeSchemas: { ApprovalGranted: ${P}Decision },`,
    "  }),",
    "  runner: runner as FlowRunner<unknown, unknown>,",
    "};",
    "",
    "// WHO may approve is not decided here. In production wire `security.resumeAuthenticator`",
    "// (and an `executionAuthorizer`) in defineConfig - see app/security.ts in a scaffolded app -",
    "// so `resume()` only accepts a verified approver. The test below runs permissive on purpose.",
    "",
  ].join("\n");
}

export function approvalTestFile(name: string): string {
  const P = pascalIdent(name);
  return [
    'import { advanceTime, createTestApp, resumeWith } from "@loom/testing";',
    'import { describe, expect, it } from "vitest";',
    `import { ${P}Flow } from "./flow";`,
    "",
    `describe(${tsStringLiteral(name)}, () => {`,
    '  it("applies once approved", async () => {',
    `    const app = createTestApp({ flows: [${P}Flow] });`,
    "    try {",
    `      const handle = await app.runtime.start(${P}Flow, { target: "prod-db" });`,
    "      await handle.waitForSuspend();",
    "      const resumed = await resumeWith(app.runtime, handle.executionId, {",
    '        eventType: "ApprovalGranted",',
    '        payload: { approved: true, approvedBy: "ada" },',
    "      });",
    "      const state = await resumed.waitForCompletion();",
    '      expect(state.variables._output).toEqual({ status: "applied", approvedBy: "ada" });',
    "    } finally {",
    "      await app.close();",
    "    }",
    "  });",
    "",
    '  it("expires after 24h with no answer (time travel, no real waiting)", async () => {',
    `    const app = createTestApp({ clock: true, flows: [${P}Flow] });`,
    "    try {",
    `      const handle = await app.runtime.start(${P}Flow, { target: "prod-db" });`,
    "      await handle.waitForSuspend();",
    "      await advanceTime(app, 24 * 60 * 60 * 1000);",
    "      const state = await app.runtime.loadState(handle.executionId);",
    '      expect(state?.status).toBe("completed");',
    '      expect(state?.variables._output).toEqual({ status: "expired" });',
    "    } finally {",
    "      await app.close();",
    "    }",
    "  });",
    "});",
    "",
  ].join("\n");
}

// ── timer ─────────────────────────────────────────────────────────────────────

/** A durable `ctx.sleep` between two steps. */
export function timerFlowFile(name: string): string {
  const P = pascalIdent(name);
  return [
    'import { flow$, handler$, step$ } from "@loom/core";',
    'import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";',
    'import { z } from "zod";',
    "",
    `const ${P}Remind = step$({`,
    `  id: ${tsStringLiteral(`${name}-remind`)},`,
    `  name: "${P} remind",`,
    "  inputSchema: z.object({ who: z.string() }),",
    "  outputSchema: z.object({ reminded: z.string() }),",
    "  handler: handler$(async (i: { who: string }) => ({ reminded: i.who })),",
    "});",
    "",
    "const runner: FlowRunner<{ who: string }, { reminded: string }> = async (ctx, input) => {",
    "  // A DURABLE sleep: the execution parks in storage and a TimerService wakes it. It survives a",
    "  // restart and holds no process memory. For an absolute instant use `ctx.sleepUntil(epochMs)`.",
    "  await ctx.sleep(24 * 60 * 60 * 1000); // 1 day",
    `  return (await ctx.run(${P}Remind, { who: input.who })) as { reminded: string };`,
    "};",
    "",
    `export const ${P}Flow: RegisteredFlow = {`,
    "  definition: flow$({",
    `    id: ${tsStringLiteral(name)},`,
    `    name: "${P}",`,
    '    version: "1.0.0",',
    "    inputSchema: z.object({ who: z.string() }),",
    "    outputSchema: z.object({ reminded: z.string() }),",
    `    steps: [${P}Remind],`,
    "  }),",
    "  runner: runner as FlowRunner<unknown, unknown>,",
    "};",
    "",
    "// Timers only fire where a TimerService runs: in defineConfig pass",
    "// `timers: { store: new InMemoryTimerStore() }` (or the Sqlite/Postgres store beside your",
    "// event store). A scaffolded app does not wire one yet.",
    "",
  ].join("\n");
}

export function timerTestFile(name: string): string {
  const P = pascalIdent(name);
  return [
    'import { advanceTime, createTestApp } from "@loom/testing";',
    'import { describe, expect, it } from "vitest";',
    `import { ${P}Flow } from "./flow";`,
    "",
    "const DAY = 24 * 60 * 60 * 1000;",
    "",
    `describe(${tsStringLiteral(name)}, () => {`,
    '  it("waits a day, then reminds (time travel, no real waiting)", async () => {',
    "    // `clock: true` gives the app a controllable clock and a timer store; advanceTime moves the",
    "    // clock and fires what became due through the real TimerService.",
    `    const app = createTestApp({ clock: true, flows: [${P}Flow] });`,
    "    try {",
    `      const handle = await app.runtime.start(${P}Flow, { who: "ada" });`,
    "      await handle.waitForSuspend();",
    "",
    "      await advanceTime(app, DAY - 1); // not due yet",
    '      expect((await app.runtime.loadState(handle.executionId))?.status).toBe("suspended");',
    "",
    "      await advanceTime(app, 1); // due",
    "      const state = await app.runtime.loadState(handle.executionId);",
    '      expect(state?.status).toBe("completed");',
    '      expect(state?.variables._output).toEqual({ reminded: "ada" });',
    "    } finally {",
    "      await app.close();",
    "    }",
    "  });",
    "});",
    "",
  ].join("\n");
}

// ── saga ──────────────────────────────────────────────────────────────────────

/** reserve -> charge -> ship with a compensator per forward step (`@loom/saga` `withSaga`). */
export function sagaFlowFile(name: string): string {
  const P = pascalIdent(name);
  return [
    'import { flow$, step$ } from "@loom/core";',
    'import { withSaga } from "@loom/saga";',
    'import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";',
    'import { z } from "zod";',
    "",
    "// Saga steps are TOOL steps: each names a `toolId` whose effect you register on the app",
    "// (`app.effectRuntime.register(toolId, new ToolEffect(...))`). A compensator runs under a",
    "// derived step id, so it must resolve through its `toolId`, not through an inline `handler$`.",
    `export const ${P}Tools = ["reserve", "unreserve", "charge", "refund", "ship"].map((t) => \`${templateLiteralText(name)}-\${t}\`);`,
    "",
    "// Under `security.strict` (the scaffolded app) a flow may only run the tools it is granted:",
    `// in app/security.ts add \`...${P}Grants\` to the \`GrantTable({ ... })\`, e.g.`,
    `//   import { ${P}Grants } from "./flows/${commentText(name)}/flow";`,
    `//   export const authorizer = new GrantTable({ greet: ["greet-step"], ...${P}Grants });`,
    `export const ${P}Grants = { ${tsStringLiteral(name)}: ${P}Tools };`,
    "",
    "const empty = z.object({});",
    "const stepOf = (tool: string) =>",
    "  step$({",
    `    id: \`${templateLiteralText(name)}-\${tool}\`,`,
    "    name: tool,",
    `    toolId: \`${templateLiteralText(name)}-\${tool}\`,`,
    "    inputSchema: empty,",
    "    outputSchema: empty,",
    "  });",
    "",
    "// Forward steps and their compensators (undo what the forward step did).",
    'const reserve = stepOf("reserve");',
    'const unreserve = stepOf("unreserve");',
    'const charge = stepOf("charge");',
    'const refund = stepOf("refund");',
    'const ship = stepOf("ship");',
    "",
    "const runner: FlowRunner<{ orderId: string }, { ok: boolean }> = (ctx) =>",
    "  // On any failure inside the scope, the registered compensators run in REVERSE as ordinary",
    "  // replay-safe steps. A suspension is not a failure: it never rolls back.",
    "  withSaga(ctx, async (saga) => {",
    "    await saga.run(reserve, {}, unreserve);",
    "    await saga.run(charge, {}, refund);",
    "    await ctx.run(ship, {}); // if the carrier fails, refund then unreserve run",
    "    return { ok: true };",
    "  });",
    "",
    `export const ${P}Flow: RegisteredFlow = {`,
    "  definition: flow$({",
    `    id: ${tsStringLiteral(name)},`,
    `    name: "${P}",`,
    '    version: "1.0.0",',
    "    inputSchema: z.object({ orderId: z.string() }),",
    "    outputSchema: z.object({ ok: z.boolean() }),",
    "    steps: [reserve, unreserve, charge, refund, ship],",
    "  }),",
    "  runner: runner as FlowRunner<unknown, unknown>,",
    "};",
    "",
  ].join("\n");
}

export function sagaTestFile(name: string): string {
  const P = pascalIdent(name);
  return [
    'import { ToolEffect } from "@loom/effect-runtime";',
    'import { createTestApp } from "@loom/testing";',
    'import { describe, expect, it } from "vitest";',
    `import { ${P}Flow, ${P}Tools } from "./flow";`,
    "",
    "// Stand-ins for the real side effects: record each call, fail `ship` on demand.",
    "function build(failShipping: boolean) {",
    "  const ledger: string[] = [];",
    `  const app = createTestApp({ flows: [${P}Flow] });`,
    `  for (const toolId of ${P}Tools) {`,
    `    const label = toolId.slice(${tsStringLiteral(`${name}-`)}.length);`,
    "    app.effectRuntime.register(",
    "      toolId,",
    "      new ToolEffect(async () => {",
    '        if (label === "ship" && failShipping) throw new Error("carrier unavailable");',
    "        ledger.push(label);",
    "        return {};",
    "      })",
    "    );",
    "  }",
    "  return { app, ledger };",
    "}",
    "",
    `describe(${tsStringLiteral(name)}, () => {`,
    '  it("keeps the work when every step succeeds", async () => {',
    "    const { app, ledger } = build(false);",
    "    try {",
    `      const handle = await app.runtime.start(${P}Flow, { orderId: "o-1" });`,
    "      const state = await handle.waitForCompletion();",
    "      expect(state.variables._output).toEqual({ ok: true });",
    '      expect(ledger).toEqual(["reserve", "charge", "ship"]);',
    "    } finally {",
    "      await app.close();",
    "    }",
    "  });",
    "",
    '  it("undoes the work in reverse when a later step fails", async () => {',
    "    const { app, ledger } = build(true);",
    "    try {",
    `      const handle = await app.runtime.start(${P}Flow, { orderId: "o-1" });`,
    "      await handle.waitForCompletion().catch(() => undefined); // the flow itself fails",
    '      expect(ledger).toEqual(["reserve", "charge", "refund", "unreserve"]);',
    "    } finally {",
    "      await app.close();",
    "    }",
    "  });",
    "});",
    "",
  ].join("\n");
}

/**
 * What a developer must still do by hand after `loom new flow <name> --template <t>` - printed by
 * the CLI, because the templates cannot edit the app's own config.
 */
export function templateNotes(template: FlowTemplate, name: string): string[] {
  const P = pascalIdent(name);
  switch (template) {
    case "echo":
      return [];
    case "approval":
      return [
        "approval: wire `timers: { store }` in defineConfig so the 24h timeout can fire (the test provides one), and `security.resumeAuthenticator` to decide who may approve.",
      ];
    case "timer":
      return [
        "timer: wire `timers: { store }` in defineConfig so the sleep can wake (the test provides one).",
      ];
    case "saga":
      return [
        `saga: the steps are tool steps. Under \`security.strict\` add \`...${P}Grants\` (from ./flows/${commentText(name)}/flow) to the GrantTable in app/security.ts, and register an effect per tool id in \`${P}Tools\` on app.effectRuntime (the test stubs them).`,
      ];
  }
}

/** The flow + test contents for a non-echo template. */
export function templateFiles(
  template: Exclude<FlowTemplate, "echo">,
  name: string
): { flow: string; test: string } {
  switch (template) {
    case "approval":
      return { flow: approvalFlowFile(name), test: approvalTestFile(name) };
    case "timer":
      return { flow: timerFlowFile(name), test: timerTestFile(name) };
    case "saga":
      return { flow: sagaFlowFile(name), test: sagaTestFile(name) };
  }
}
