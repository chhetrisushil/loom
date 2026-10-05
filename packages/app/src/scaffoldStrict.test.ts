import { createRequire } from "node:module";
import { appFiles } from "@loom/scaffold";
import type { RegisteredFlow } from "@loom/workflow-runtime";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { defineConfig } from "./defineConfig";

// ── The scaffold teaches the strict profile (R9) ──────────────────────────────
//
// A template that emits the permissive config outlives every sweep of the repo (the
// home repo's tests cannot see generated output). So this does not read the template as
// text: it EVALUATES the generated `app/security.ts` and `app/flows/greet/flow.ts`, composes
// them into `defineConfig` exactly as the generated `app/config.ts` does, and runs the flow.

const nodeRequire = createRequire(__filename);

/** Transpile one generated file and evaluate it, resolving `@loom/*`/`zod` for real. */
function load(source: string, local: Record<string, unknown> = {}): Record<string, unknown> {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", js)(
    (id: string) => (id in local ? local[id] : nodeRequire(id)),
    mod,
    mod.exports
  );
  return mod.exports;
}

describe("scaffolded app", () => {
  const files = appFiles("acme");

  it("config.ts requests strict mode and passes both authorizers from security.ts", () => {
    expect(files["app/config.ts"]).toMatch(
      /security: \{ strict: true, authorizer, executionAuthorizer, resumeAuthenticator \}/
    );
    expect(files["app/security.ts"]).toContain("GrantTable");
    expect(files["README.md"]).toContain("security.ts");
  });

  it("composes under strict, runs the greet flow, and denies an ungranted effect", async () => {
    const security = load(files["app/security.ts"] as string) as {
      authorizer: import("@loom/effect-runtime").CapabilityAuthorizer;
      executionAuthorizer: import("@loom/workflow-runtime").ExecutionAuthorizer;
      resumeAuthenticator: import("@loom/workflow-runtime").ResumeAuthenticator;
    };
    const greet = load(files["app/flows/greet/flow.ts"] as string).GreetFlow as RegisteredFlow;

    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [greet],
      security: { strict: true, ...security },
      observability: { onWarn: () => {} },
    });
    try {
      expect(app.strict).toBe(true);
      // A principal-less call is refused by the generated policy (R3, fail-closed)...
      await expect(app.runtime.start(greet, { input: "world" })).rejects.toMatchObject({
        name: "ExecutionDeniedError",
      });
      // ...so the generated main/test attach one, exactly as app/main.ts does.
      const principal = { actor: "demo-user", tenant: "demo" };
      const handle = await app.runtime.start(greet, { input: "world" }, { principal });
      const state = await handle.waitForCompletion();
      expect((state.variables._output as { output: string }).output).toBe("world");

      // Ownership: the starter reads its own execution; another actor / tenant is refused.
      expect((await app.runtime.loadState(handle.executionId, { principal }))?.status).toBe(
        "completed"
      );
      for (const intruder of [
        { actor: "mallory", tenant: "demo" },
        { actor: "demo-user", tenant: "elsewhere" },
      ]) {
        await expect(
          app.runtime.loadState(handle.executionId, { principal: intruder })
        ).rejects.toMatchObject({ name: "ExecutionDeniedError" });
      }

      // The stub authorizer is real policy, not a wildcard: an unlisted effect is refused...
      expect(
        security.authorizer.authorize({
          toolId: "rm-rf",
          executionId: "e",
          workflowId: "greet",
          stepId: "s",
        }).allowed
      ).toBe(false);
      // ...and a principal with no actor may not start an execution.
      expect(
        security.executionAuthorizer.authorize({
          op: "start",
          executionId: "e",
          workflowId: "greet",
          principal: {},
        })
      ).toMatchObject({ allowed: false });
    } finally {
      await app.close();
    }
  });
});
