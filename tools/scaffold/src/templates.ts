import { generateRegistration, pascalIdent } from "./codegen";
import { markdownText, tsStringLiteral } from "./emit";
import { type FlowTemplate, templateFiles } from "./flowTemplates";

// ── Per-file templates (used by `loom new`, following the folder convention) ──

/** `app/flows/<name>/flow.ts` — a self-contained echo flow. */
export function flowFile(name: string): string {
  const P = pascalIdent(name);
  return [
    'import { flow$, handler$, step$ } from "@loom/core";',
    'import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";',
    'import { z } from "zod";',
    "",
    `const ${P}Step = step$({`,
    `  id: ${tsStringLiteral(`${name}-step`)},`,
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
    `    id: ${tsStringLiteral(name)},`,
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

/**
 * `app/flows/<name>/flow.test.ts` — runs the `loom new flow` echo flow through `@loom/testing`'s
 * `createTestApp` (in-memory, permissive defaults: no principal or grants to wire). It passes on a
 * fresh scaffold; replace the input/assertion as you change the flow.
 */
export function flowTestFile(name: string): string {
  const P = pascalIdent(name);
  return [
    'import { createTestApp } from "@loom/testing";',
    'import { describe, expect, it } from "vitest";',
    `import { ${P}Flow } from "./flow";`,
    "",
    `describe(${tsStringLiteral(name)}, () => {`,
    '  it("runs the flow end to end", async () => {',
    `    const app = createTestApp({ flows: [${P}Flow] });`,
    "    try {",
    `      const handle = await app.runtime.start(${P}Flow, { input: "hello" });`,
    "      const state = await handle.waitForCompletion();",
    '      expect(state.variables._output).toEqual({ output: "hello" });',
    "    } finally {",
    "      await app.close();",
    "    }",
    "  });",
    "});",
    "",
  ].join("\n");
}

/** `app/flows/<name>/flow.ts` — a schedule-driven sentinel starter (@loom/plugin-sentinel). */
export function sentinelFile(name: string): string {
  const P = pascalIdent(name);
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
    `  id: ${tsStringLiteral(name)},`,
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
    `    id: ${tsStringLiteral(`${name}-flow`)},`,
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
  const P = pascalIdent(name);
  return [
    'import { tool$ } from "@loom/core";',
    'import { z } from "zod";',
    "",
    `export const ${P}Tool = tool$({`,
    `  id: ${tsStringLiteral(name)},`,
    `  name: "${P}",`,
    `  description: ${tsStringLiteral(`TODO: describe ${name}.`)},`,
    '  kind: "tool",',
    "  inputSchema: z.object({}),",
    "  outputSchema: z.object({}),",
    "  // Typed failure channels (ADR 0060) — declare EXPECTED failure modes so the",
    '  // effect can `fail("notFound", { id })`: the failure is recorded with its',
    "  // validated payload, flows branch on it deterministically, and replay",
    "  // substitutes it without re-invoking the effect. Undeclared failures keep",
    "  // legacy retry semantics. Pass the same map to the registered effect:",
    "  //   new ToolEffect(fn, { errors: { notFound: z.object({ id: z.string() }) } })",
    "  // errors: { notFound: z.object({ id: z.string() }) },",
    "});",
    "",
  ].join("\n");
}

/** `app/agents/<name>.ts` — an agent definition stub. */
export function agentFile(name: string): string {
  const P = pascalIdent(name);
  return [
    'import { agent$ } from "@loom/core";',
    "",
    `export const ${P}Agent = agent$({`,
    `  id: ${tsStringLiteral(name)},`,
    `  name: "${P}",`,
    `  description: ${tsStringLiteral(`TODO: describe ${name}.`)},`,
    "  tools: [],",
    "});",
    "",
  ].join("\n");
}

/** `app/skills/<name>.ts` — a skill definition stub (instructions stay lazy). */
export function skillFile(name: string): string {
  const P = pascalIdent(name);
  return [
    'import { instructions$, skill$ } from "@loom/core";',
    "",
    `export const ${P}Skill = skill$({`,
    `  id: ${tsStringLiteral(name)},`,
    `  name: "${P}",`,
    `  description: ${tsStringLiteral(`TODO: describe ${name}.`)},`,
    "  tags: [],",
    `  instructions: instructions$(${tsStringLiteral(`TODO: write the ${name} instructions.`)}),`,
    "});",
    "",
  ].join("\n");
}

/** `app/schedules/<name>.ts` — a cron schedule stub (points at a flow to start). */
export function scheduleFile(name: string): string {
  const P = pascalIdent(name);
  return [
    'import { schedule$ } from "@loom/core";',
    "",
    `export const ${P}Schedule = schedule$({`,
    `  id: ${tsStringLiteral(name)},`,
    '  cron: "0 * * * *", // hourly (UTC); 5-field cron',
    `  flowId: "TODO-flow-id", // the registered flow each occurrence starts`,
    "});",
    "",
  ].join("\n");
}

/** `app/memories/<name>.ts` — a named memory definition stub. */
export function memoryFile(name: string): string {
  const P = pascalIdent(name);
  return [
    'import { memory$ } from "@loom/core";',
    "",
    `export const ${P}Memory = memory$({`,
    `  id: ${tsStringLiteral(name)},`,
    `  name: "${P}",`,
    "  // ttlMs / maxEntries bound each scope; omit for unbounded.",
    "});",
    "",
  ].join("\n");
}

/** `app/projections/<name>.ts` — a projection stub (handlers fold events; loaded on demand). */
export function projectionFile(name: string): string {
  const P = pascalIdent(name);
  return [
    'import { projection$ } from "@loom/core";',
    "",
    `export const ${P}Projection = projection$({`,
    `  id: ${tsStringLiteral(name)},`,
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
  name: string,
  template: FlowTemplate = "echo"
): { path: string; content: string } {
  switch (kind) {
    case "sentinel":
      return { path: `app/flows/${name}/flow.ts`, content: sentinelFile(name) };
    case "flow":
      return {
        path: `app/flows/${name}/flow.ts`,
        content: template === "echo" ? flowFile(name) : templateFiles(template, name).flow,
      };
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

/**
 * Every file `loom new <kind> <name>` writes: the construct itself first, then (where a test is
 * natural — a flow) a sibling `*.test.ts`. `newFile` stays the single-file router.
 */
export function newFiles(
  kind: Parameters<typeof newFile>[0],
  name: string,
  template: FlowTemplate = "echo"
): { path: string; content: string }[] {
  const files = [newFile(kind, name, template)];
  if (kind === "flow") {
    files.push({
      path: `app/flows/${name}/flow.test.ts`,
      content: template === "echo" ? flowTestFile(name) : templateFiles(template, name).test,
    });
  }
  return files;
}

/** Version spec for a non-`@loom` dependency a template imports. */
export const THIRD_PARTY_SPECS: Record<string, string> = {
  zod: "^3.23.8",
  vitest: "^2.1.8",
};

/** Package names a generated file imports (bare specifiers only; `node:` and relative excluded). */
export function importedPackages(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/^\s*import\b[^"']*?from\s+["']([^"']+)["']/gm)) {
    const spec = m[1] as string;
    if (spec.startsWith(".") || spec.startsWith("node:")) continue;
    const parts = spec.split("/");
    out.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string));
  }
  return [...out].sort();
}

// ── Whole-app scaffold (used by create-loom-app), following the convention ────

/**
 * `JSON.stringify` leaves bidi, zero-width, line-separator and tag characters raw (all legal
 * in JSON); rewrite them as `\\uXXXX` escapes (still valid JSON, same value) so the manifest
 * reads as what it parses to.
 */
function jsonText(json: string): string {
  return json.replace(
    /[\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\u{e0000}-\u{e007f}]/gu,
    (c) => {
      const cp = c.codePointAt(0) as number;
      if (cp <= 0xffff) return `\\u${cp.toString(16).padStart(4, "0")}`;
      const v = cp - 0x10000;
      return `\\u${(0xd800 + (v >> 10)).toString(16)}\\u${(0xdc00 + (v & 0x3ff)).toString(16)}`;
    }
  );
}

export function appFiles(appName: string): Record<string, string> {
  return {
    "package.json": `${jsonText(
      JSON.stringify(
        {
          name: appName,
          private: true,
          // CommonJS (no "type": "module") — @loom/* publish require-only exports, so
          // `tsx app/main.ts` must resolve them via CJS (matches the loom-starter example).
          scripts: {
            start: "tsx app/main.ts",
            test: "vitest run",
            gen: "loom gen --dir app",
          },
          dependencies: {
            // `surface(ctx)` / the typing of `ctx.ui` (ADR 0114): a flow that drives a UI surface imports it.
            "@loom/agent-surface": "workspace:*",
            "@loom/app": "workspace:*",
            "@loom/core": "workspace:*",
            "@loom/effect-runtime": "workspace:*",
            "@loom/middleware": "workspace:*",
            "@loom/workflow-runtime": "workspace:*",
            zod: "^3.23.8",
          },
          devDependencies: {
            "@loom/cli": "workspace:*",
            "@loom/testing": "workspace:*", // `loom new flow` emits a createTestApp test
            tsx: "^4.19.2",
            typescript: "^5.6.3",
            vitest: "^2.1.8",
          },
        },
        null,
        2
      )
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

    "app/security.ts": [
      'import { createHash } from "node:crypto";',
      'import { GrantTable, type PrincipalChain } from "@loom/effect-runtime";',
      "import {",
      "  type ExecutionAuthorizer,",
      "  type PrincipalCodec,",
      "  executionAccessPolicy,",
      "  signedResumeAuthenticator,",
      '} from "@loom/workflow-runtime";',
      "",
      "// The pieces `security.strict` REFUSES to start without. They are yours: they",
      "// encode who may do what, which a framework cannot guess. These are deliberately small",
      "// stubs — read them, then tighten them.",
      "",
      "// Which effects each flow may run (the K2 capability ring). An effect not listed here is",
      "// DENIED (CapabilityDeniedError) — so when you add a flow with `loom new flow <name>`,",
      "// add its tool ids here too. Step ids double as tool ids unless a step sets `toolId`.",
      "export const authorizer = new GrantTable({",
      '  greet: ["greet-step"],',
      "});",
      "",
      "// Who may start / resume / cancel / query an execution. Under `security.strict` a call with",
      "// NO principal is refused (attach an authenticated one at your API edge: `start(flow, input,",
      "// { principal })`); the kernel's own machinery (timers, recovery, child spawn) is exempt.",
      "// `executionAccessPolicy` is loom's reference policy: the actor that starts an execution owns",
      "// it, and only that actor — in the same tenant — may resume, cancel or read it. The kernel",
      "// records who started an execution (ADR 0111) and hands it to the policy, so ownership",
      "// survives restarts; a flow's effects keep running as that owner after an approval, a timer",
      "// wake or a recovery.",
      "export const executionAuthorizer: ExecutionAuthorizer = executionAccessPolicy({",
      "  requireTenant: true,",
      '  rules: { start: "any", resume: "owner", cancel: "owner", query: "owner" },',
      "});",
      "",
      "// How a principal is written into the log. Under `security.strict` the log must never carry",
      "// a principal's identity (tenant / actor) verbatim — a permanent log cannot be redacted — so",
      "// it records an OPAQUE ref and the runtime asks this codec to turn the ref back into the",
      "// principal whenever the execution resumes (after an approval, a timer, a crash). THIS STUB",
      '// keeps the table in memory, which matches `storage: { kind: "memory" }`: back it with your',
      "// user table the day you move to a durable store. (Alternatively compose crypto and pass",
      "// `security.crypto` so the identity is encrypted at rest and shredded with the subject.)",
      "const principals = new Map<string, PrincipalChain>();",
      "export const principalCodec: PrincipalCodec = {",
      "  toRef(chain) {",
      "    const { tenant, actor, onBehalfOf } = chain;",
      '    const ref = "p:" + createHash("sha256").update(JSON.stringify([tenant, actor, onBehalfOf])).digest("hex").slice(0, 32);',
      "    principals.set(ref, { ...(tenant !== undefined && { tenant }), ...(actor !== undefined && { actor }), ...(onBehalfOf !== undefined && { onBehalfOf }) });",
      "    return ref;",
      "  },",
      "  fromRef: (ref) => principals.get(ref),",
      "};",
      "",
      "// Who APPROVED a parked gate (R13). With no authenticator ANY caller of `resume()` approves,",
      "// and nobody is on record as having done so. An approver signs the resume event for ONE park:",
      "//   signResume(answerApproval(state, { approved: true }), {",
      "//     actor, secret, exp: Date.now() + 60_000,",
      "//     executionId, parkedAtSequence: await runtime.parkedAtSequence(executionId),",
      "//   })",
      "// The runtime verifies it, records APPROVAL_GRANTED { actor, verifiedBy }, refuses a stale view",
      "// (the echoed viewDigest) and a replayed signature (another execution, another park), all",
      "// before anything is appended. Keys come from YOUR secret store; this reads one env var per",
      "// approver (LOOM_APPROVER_KEY_<ACTOR>, 16+ bytes) and FAILS CLOSED: an actor with odd",
      "// characters, an unset or empty variable is simply not an approver. Add your own gate names.",
      "export const resumeAuthenticator = signedResumeAuthenticator({",
      '  gates: ["AgentToolApproval", "ApprovalGranted"],',
      "  keys: (actor) => {",
      "    if (!/^[A-Za-z0-9_]+$/.test(actor)) return undefined;",
      '    const key = process.env["LOOM_APPROVER_KEY_" + actor.toUpperCase()];',
      '    return key === undefined || key === "" ? undefined : key;',
      "  },",
      "});",
      "",
    ].join("\n"),

    "app/config.ts": [
      'import { defineConfig } from "@loom/app";',
      'import { agentModules, flowModules, projectionModules, skillModules, toolModules } from "./loom.gen";',
      'import { middleware } from "./middleware";',
      'import { authorizer, executionAuthorizer, principalCodec, resumeAuthenticator } from "./security";',
      "",
      "// The whole app, declared once. Flows/agents/tools/skills/projections are discovered",
      "// from app/{flows,agents,tools,skills,projections} via `loom gen` (app/loom.gen.ts). Set",
      "// `a2a: true` to auto-expose agents on the A2A bus. Swap storage to sqlite for durability.",
      "//",
      "// `security.strict` flips loom's permissive defaults to a safe baseline (R9): both",
      "// authorizers and the resumeAuthenticator are REQUIRED (see ./security), flows without a `deadlineMs` get a default",
      "// deadline, child spawns are depth/breadth-capped, each execution has a token budget, and",
      "// `app.killSwitch` can stop effects system-wide / per tenant / per flow. It is on here so",
      "// you start safe; set `strict: false` to opt out explicitly (no advisory is then logged).",
      "// For agents, pass `requireEffectRing: true` to `agentLoop$` so no model call bypasses it.",
      "export const app = defineConfig({",
      '  storage: { kind: "memory" },',
      "  flowModules,",
      "  agentModules, // set a2a: true / agentSurface: true to auto-wire discovered agents",
      "  toolModules, // discovered tool definitions on app.tools; register effects yourself",
      "  skillModules, // discovered skills registered into app.skills (app.skills.find(query))",
      "  projectionModules, // discovered projections folded into the projection runtime",
      "  security: { strict: true, authorizer, executionAuthorizer, resumeAuthenticator, principalCodec },",
      "  execution: { effectMiddleware: middleware },",
      "});",
      "",
    ].join("\n"),

    "app/main.ts": [
      'import { app } from "./config";',
      'import { GreetFlow } from "./flows/greet/flow";',
      "",
      "async function main() {",
      "  // Under `security.strict` every call names who is acting (see ./security).",
      '  const principal = { actor: "demo-user", tenant: "demo" };',
      '  const handle = await app.runtime.start(GreetFlow, { input: "world" }, { principal });',
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
      '    const principal = { actor: "demo-user", tenant: "demo" };',
      '    const handle = await app.runtime.start(GreetFlow, { input: "world" }, { principal });',
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
      // One line of plain heading text: line breaks, control/bidi characters and markdown/HTML
      // metacharacters in the name are neutralised, so it can never open a section or a tag.
      `# ${markdownText(appName)}`,
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
      "  security.ts            the authorizers `security.strict` requires (edit these)",
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
