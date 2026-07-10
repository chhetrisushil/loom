import { step$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { KERNEL_ABI, KERNEL_ABI_VERSION, KERNEL_SYSCALLS } from "./abi";
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
      "parallel",
      "run",
      "sleep",
      "sleepUntil",
      "stream",
      "suspend",
      "ui",
    ]);
  });
});
