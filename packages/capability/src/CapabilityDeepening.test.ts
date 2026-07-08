import { flow$, handler$, step$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { capability$ } from "./capability$";
import { CapabilityCatalog } from "./CapabilityCatalog";
import { CapabilityInvokeDeniedError } from "./types";

function noopFlow(id: string): RegisteredFlow<Record<string, never>, { ok: boolean }> {
  const s = step$({
    id: `${id}-step`,
    name: id,
    inputSchema: z.object({}),
    outputSchema: z.object({ ok: z.boolean() }),
    handler: handler$(async () => ({ ok: true })),
  });
  const runner: FlowRunner<Record<string, never>, { ok: boolean }> = (ctx) => ctx.run(s, {});
  return {
    definition: flow$({
      id,
      name: id,
      version: "1.0.0",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      steps: [s],
    }),
    runner,
  };
}

function cap(id: string, opts: { deps?: string[]; version?: string } = {}) {
  return capability$({
    id,
    intent: `do ${id}`,
    inputSchema: z.object({}),
    flow: noopFlow(id),
    ...(opts.deps !== undefined && { dependencies: opts.deps }),
    ...(opts.version !== undefined && { version: opts.version }),
  });
}

describe("Capability deepening (M7) — version & dependencies", () => {
  it("carries version and dependencies through capability$", () => {
    const c = cap("a", { deps: ["b"], version: "2.1.0" });
    expect(c.version).toBe("2.1.0");
    expect(c.dependencies).toEqual(["b"]);
  });

  it("resolves transitive dependencies in dependency-first order", () => {
    const catalog = new CapabilityCatalog()
      .register(cap("a", { deps: ["b", "c"] }))
      .register(cap("b", { deps: ["c"] }))
      .register(cap("c"));

    const order = catalog.resolve("a").map((c) => c.id);
    expect(order).toEqual(["c", "b", "a"]); // deps before dependents, self last
  });

  it("throws on a missing dependency", () => {
    const catalog = new CapabilityCatalog().register(cap("a", { deps: ["ghost"] }));
    expect(() => catalog.resolve("a")).toThrow(/Missing capability dependency: "ghost"/);
  });

  it("throws on a dependency cycle", () => {
    const catalog = new CapabilityCatalog()
      .register(cap("a", { deps: ["b"] }))
      .register(cap("b", { deps: ["a"] }));
    expect(() => catalog.resolve("a")).toThrow(/cycle/);
  });
});

describe("Capability deepening (M7) — invoke authorization", () => {
  function makeRuntime(catalog: CapabilityCatalog) {
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
    });
    catalog.registerInto(runtime);
    return runtime;
  }

  it("allows an invoke with no authorizer (unchanged)", async () => {
    const catalog = new CapabilityCatalog().register(cap("open"));
    const runtime = makeRuntime(catalog);
    const handle = await catalog.invoke(runtime, "open", {});
    expect((await handle.waitForCompletion()).status).toBe("completed");
  });

  it("denies an unauthorized invoke when an authorizer is configured", async () => {
    const catalog = new CapabilityCatalog({
      authorizer: {
        authorize: (req) =>
          req.capabilityId === "secret" && req.principal !== "admin"
            ? { allowed: false, reason: "requires admin" }
            : { allowed: true },
      },
    })
      .register(cap("secret"))
      .register(cap("open"));
    const runtime = makeRuntime(catalog);

    await expect(catalog.invoke(runtime, "secret", {}, { principal: "guest" })).rejects.toBeInstanceOf(
      CapabilityInvokeDeniedError
    );
    // Authorized principal and unrestricted capability both pass.
    await expect(catalog.invoke(runtime, "secret", {}, { principal: "admin" })).resolves.toBeDefined();
    await expect(catalog.invoke(runtime, "open", {})).resolves.toBeDefined();
  });
});
