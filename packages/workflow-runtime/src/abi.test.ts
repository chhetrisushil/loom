import { readFileSync } from "node:fs";
import { join } from "node:path";
import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { KERNEL_ABI, KERNEL_ABI_VERSION, KERNEL_SYSCALLS } from "./abi";
import { testSurface } from "./testSurface";
import type { ExecutionContext, FlowRunner, RegisteredFlow } from "./types";

// K1 conformance: the live ExecutionContext must expose exactly the declared syscall
// surface. Removing/renaming a syscall (a MAJOR ABI break) fails this test, so the
// contract cannot drift silently.

const noop = step$({
  id: "noop",
  name: "Noop",
  toolId: "noop-tool",
  inputSchema: z.object({}),
  outputSchema: z.object({ ok: z.boolean() }),
});

function makeFlow(runner: FlowRunner<Record<string, never>, unknown>): RegisteredFlow {
  return {
    definition: {
      _tag: "FlowDefinition",
      id: "abi-flow",
      name: "ABI Flow",
      version: "1.0.0",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      steps: [noop],
    },
    runner: runner as FlowRunner<unknown, unknown>,
  };
}

async function captureContext(): Promise<ExecutionContext> {
  const effectRuntime = new EffectRuntime();
  effectRuntime.register("noop-tool", new ToolEffect(vi.fn().mockResolvedValue({ ok: true })));
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime,
    // ADR 0114: `ui` is an injected accessor; the kernel's own tests inject the stub.
    surface: testSurface,
  });
  let captured: ExecutionContext | undefined;
  const runner: FlowRunner<Record<string, never>, unknown> = async (ctx) => {
    captured = ctx;
    return {};
  };
  const handle = await runtime.start(makeFlow(runner), {});
  await handle.waitForCompletion();
  if (captured === undefined) throw new Error("context not captured");
  return captured;
}

describe("Kernel ABI (K1)", () => {
  it("declares a semver version", () => {
    expect(KERNEL_ABI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(KERNEL_ABI.version).toBe(KERNEL_ABI_VERSION);
    expect(KERNEL_ABI.syscalls).toBe(KERNEL_SYSCALLS);
  });

  it("1.2.0 (L30): decide's decider receives a scope, so a flow using it can require >= 1.2.0", async () => {
    const [maj, min] = KERNEL_ABI_VERSION.split(".").map(Number);
    expect(maj === 1 && (min ?? 0) >= 2).toBe(true);
    const ctx = await captureContext();
    let arg: unknown;
    await ctx.decide("abi-probe", (scope) => {
      arg = scope;
      return 1;
    });
    expect(typeof (arg as { invokeTransient?: unknown }).invokeTransient).toBe("function");
  });

  it("the live ExecutionContext exposes every declared syscall with the right kind", async () => {
    const ctx = await captureContext();
    for (const sc of KERNEL_SYSCALLS) {
      const value = (ctx as unknown as Record<string, unknown>)[sc.name];
      if (sc.kind === "call") {
        expect(typeof value, `syscall ${sc.name} must be a function`).toBe("function");
      } else {
        expect(value, `accessor ${sc.name} must be present`).toBeDefined();
      }
    }
  });

  it("pins the syscall set (guards against silent MAJOR breaks)", () => {
    expect([...KERNEL_SYSCALLS].map((s) => s.name).sort()).toEqual([
      "decide",
      "emit",
      "execute",
      "negotiateBudget",
      "parallel",
      "run",
      "sleep",
      "sleepUntil",
      "stream",
      "suspend",
      "ui",
    ]);
  });

  it("ADR 0114: `ui` is deprecated (not removed) and negotiateBudget is in the table at 1.3.0", () => {
    const ui = KERNEL_SYSCALLS.find((s) => s.name === "ui");
    expect(ui?.kind).toBe("accessor");
    expect(ui?.deprecated).toBe(true);
    const nb = KERNEL_SYSCALLS.find((s) => s.name === "negotiateBudget");
    expect(nb).toMatchObject({ kind: "call", since: "1.3.0" });
    // Only `ui` is deprecated; nothing else was quietly marked.
    expect(KERNEL_SYSCALLS.filter((s) => s.deprecated === true).map((s) => s.name)).toEqual(["ui"]);
  });

  it("ADR 0114 D3: the ExecutionContext interface and the syscall table agree", () => {
    // Members of `interface ExecutionContext` in the source, minus the two identity fields; the
    // `ui` accessor is merged in by @loom/agent-surface and so is not in the kernel's interface.
    const src = readFileSync(join(__dirname, "types.ts"), "utf8");
    const body = /export interface ExecutionContext extends [A-Za-z]+ \{([\s\S]*?)\n\}\n/.exec(src);
    expect(body, "ExecutionContext interface not found").not.toBeNull();
    const members = new Set(
      [...(body?.[1] ?? "").matchAll(/^ {2}(?:readonly )?([a-zA-Z]+)\s*[(<:?]/gm)].map((m) => m[1])
    );
    members.delete("executionId");
    members.delete("workflowId");
    const table = new Set(KERNEL_SYSCALLS.map((s) => s.name));
    table.delete("ui");
    expect([...members].sort()).toEqual([...table].sort());
    expect(members.has("ui"), "the kernel interface must not declare ui").toBe(false);
  });
});
