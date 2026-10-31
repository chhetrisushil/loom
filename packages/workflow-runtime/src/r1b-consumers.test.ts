import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EventEnvelope } from "@loom/core";
import { InMemoryArchiveStore } from "@loom/event-runtime";
import { foldEvents } from "@loom/replay-vm";
import { describe, expect, it } from "vitest";
import { LogLifecycle } from "./LogLifecycle";
import { build, flow, settle, until } from "./__tests__/r2Harness";
import { inboxStreamId } from "./inbox";
import { classifyStrayPassthroughs } from "./strayPassthroughs";

// ADR 0109 D2 — `continued` is terminal and NOT completed in every consumer that switches on a
// status. Per-package consumers are tested beside their code (orchestration, analytics, learning,
// compliance, app, worker-runtime-local, telemetry, dst, cli); the ones owned by the kernel are here.

const ev = (
  sequence: number,
  eventType: string,
  payload: unknown = {},
  metadata?: Record<string, unknown>
): EventEnvelope => ({
  id: `x-${sequence}`,
  workflowId: "w",
  executionId: "x",
  eventType,
  sequence,
  timestamp: 1000 + sequence,
  payload,
  ...(metadata !== undefined && { metadata }),
});

describe("LogLifecycle (retention): a continued predecessor is terminal, its chain's inbox lives on", () => {
  it("reclaims the predecessor but NOT the chain's inbox stream; the head's retention deletes it", async () => {
    const h = build({ continueAsNewEnabled: true });
    const f = flow<{ gen?: number }, unknown>("ret", async (ctx, input) => {
      if (input?.gen === undefined) {
        await ctx.receive("go");
        return ctx.continueAsNew({ gen: 1 });
      }
      await ctx.receive("more");
    });
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "r" }));
    await h.rt.send("r", { topic: "go", payload: 1 });
    await until(async () => (await h.rt.loadState("r~1"))?.status === "suspended");
    // a message nobody waits for stays unconsumed, so the stream is non-empty and survives trimming
    await h.rt.send("r", { topic: "cold", payload: "unread" });
    const life = new LogLifecycle(h.eventStore, h.snapshotStore, {
      compactionArchive: new InMemoryArchiveStore(),
    });
    const far = Date.now() + 1e9;

    // a LIVE head is never reclaimable, a continued predecessor is
    expect(await life.applyRetention("r~1", { terminalTtlMs: 0 }, far)).not.toBe("reclaimed");
    expect(await life.applyRetention("r", { terminalTtlMs: 0 }, far)).toBe("reclaimed");
    expect(await h.eventStore.read("r")).toEqual([]);
    // the chain continues: its inbox stream is still there for the successor
    expect((await h.eventStore.read(inboxStreamId("r"))).length).toBeGreaterThan(0);
    expect((await h.rt.loadState("r~1"))?.status).not.toBe("continued");

    // when the head ends, its retention deletes the chain's inbox with it
    await h.rt.cancel("r~1", "done");
    expect(await life.applyRetention("r~1", { terminalTtlMs: 0 }, far)).toBe("reclaimed");
    expect(await h.eventStore.read(inboxStreamId("r"))).toEqual([]);
  });

  it("an UNSTAMPED EXECUTION_CONTINUED is an app event: the execution is not terminal and is not reclaimed", async () => {
    const h = build({ continueAsNewEnabled: true });
    const f = flow<unknown, unknown>("ret2", async (ctx) => {
      await ctx.receive("never");
    });
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "u" }));
    const tip = (await h.eventStore.read("u")).length;
    await h.eventStore.append({
      id: `u-${tip}`,
      workflowId: "ret2",
      executionId: "u",
      eventType: "EXECUTION_CONTINUED",
      sequence: tip,
      timestamp: Date.now(),
      payload: { successorId: "u~1", chainId: "u", generation: 1 },
    });
    const life = new LogLifecycle(h.eventStore, h.snapshotStore, {
      compactionArchive: new InMemoryArchiveStore(),
    });
    expect(await life.applyRetention("u", { terminalTtlMs: 0 }, Date.now() + 1e9)).not.toBe(
      "reclaimed"
    );
  });
});

describe("strayPassthroughs: a continued execution is terminal (nothing left to warn about)", () => {
  // a pre-0104 recovery shape that is still UNSPENT: the flow's next gate would pass with it
  const stray = [
    ev(0, "EXECUTION_STARTED", {}),
    ev(1, "EXECUTION_RECOVERED", {}),
    ev(2, "EXECUTION_RESUMED", {}),
  ];

  it("at-risk while running; silent once a kernel-stamped continuation ends it", () => {
    const running = foldEvents(stray, { executionId: "x", workflowId: "w", workflowVersion: "1" });
    expect(classifyStrayPassthroughs(stray, running)?.kind).toBe("at-risk");

    const log = [...stray, ev(3, "EXECUTION_CONTINUED", { successorId: "x~1" }, { kernel: true })];
    const continued = foldEvents(log, { executionId: "x", workflowId: "w", workflowVersion: "1" });
    expect(continued.status).toBe("continued");
    expect(classifyStrayPassthroughs(log, continued)).toBeUndefined();
  });

  it("an unstamped EXECUTION_CONTINUED does not end it", () => {
    const log = [...stray, ev(3, "EXECUTION_CONTINUED", { successorId: "x~1" })];
    const state = foldEvents(log, { executionId: "x", workflowId: "w", workflowVersion: "1" });
    expect(state.status).toBe("running");
    expect(classifyStrayPassthroughs(log, state)?.kind).toBe("at-risk");
  });
});

describe("ExecutionStatus exhaustiveness (a type-level check cannot run in vitest, so this pins the union)", () => {
  // Widening the status union is a source-level break for every exhaustive switch (ADR 0109 D2, the
  // CHANGELOG for 1.23.0). This fails when a value is added or removed, so the consumers named in
  // ADR 0109 D2 are re-audited on purpose rather than by luck.
  it("is exactly the seven statuses the consumers handle, `continued` among them", () => {
    const src = readFileSync(resolve(__dirname, "../../core/src/types/execution.ts"), "utf8");
    const body = src.slice(
      src.indexOf("export type ExecutionStatus"),
      src.indexOf(";", src.indexOf("export type ExecutionStatus"))
    );
    const members = [...body.matchAll(/\|\s*"([a-z]+)"/g)].map((m) => m[1]).sort();
    expect(members).toEqual(
      ["cancelled", "completed", "continued", "failed", "pending", "running", "suspended"].sort()
    );
  });
});
