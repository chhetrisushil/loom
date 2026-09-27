import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryContentStore, sweepUnpinnedContent } from "@loom/plugin-content";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LogLifecycle } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner } from "./types";

// ADR 0106 — end to end: the content sweep runs over exactly what the REAL compact() wrote
// (not a hand-built imitation of it), with the sweep pinning FEWER kinds than compaction keeps.

const DAY = 86_400_000;
const FINDING = "FINDING_RECORDED";
const NOTE = "NOTE_RECORDED";
const anyIo = z.any();
const fetch = step$({
  id: "fetch",
  name: "fetch",
  toolId: "fetch",
  inputSchema: anyIo,
  outputSchema: anyIo,
});
const later = step$({
  id: "later",
  name: "later",
  toolId: "later",
  inputSchema: anyIo,
  outputSchema: anyIo,
});

describe("ADR 0106 — compact() then sweepUnpinnedContent, end to end", () => {
  it("keeps every blob the checkpoint or a kept finding cites, and still reclaims a true orphan", async () => {
    const content = new InMemoryContentStore({ now: () => 1 });
    const stepBlob = await content.put(new TextEncoder().encode("step output, claim-checked"));
    const evidence = await content.put(new TextEncoder().encode("the finding's evidence"));
    const orphan = await content.put(new TextEncoder().encode("cited by nothing"));

    const effects = new EffectRuntime();
    effects.register(
      "fetch",
      new ToolEffect(async () => ({
        rows: { __loomClaimCheck: true, ref: stepBlob, size: 1 },
      }))
    );
    effects.register("later", new ToolEffect(async () => ({ rows: 0 })));
    const definition: FlowDefinition<unknown, unknown> = {
      _tag: "FlowDefinition",
      id: "sweep-e2e",
      name: "sweep-e2e",
      version: "1.0.0",
      inputSchema: anyIo,
      outputSchema: anyIo,
      steps: [fetch, later],
    };
    const runner: FlowRunner<unknown, unknown> = async (ctx) => {
      await ctx.run(fetch, {});
      ctx.emit(FINDING, { evidence: [evidence] });
      ctx.emit(NOTE, { note: "kept by compaction, not pinned by the sweep" });
      await ctx.suspend({ on: "go1" });
      await ctx.run(later, {});
      await ctx.suspend({ on: "go2" });
      return {};
    };
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime: effects,
      now: () => 1_000,
    });
    runtime.registerFlow(definition, runner);
    const life = new LogLifecycle(eventStore, snapshotStore, { pinnedEventTypes: [FINDING, NOTE] });

    await (await runtime.start({ definition, runner }, {}, { executionId: "x" })).waitForSuspend();
    expect(await life.compact("x")).not.toBeNull();
    await (await runtime.resume("x", { eventType: "go1", payload: { ok: 1 } })).waitForSuspend();
    expect(await life.compact("x")).not.toBeNull();

    const log = await eventStore.read("x");
    expect(log.filter((e) => e.eventType === FINDING)).toHaveLength(1);
    expect(log.filter((e) => e.eventType === NOTE)).toHaveLength(1);
    // The step that cited stepBlob is gone from the log: only snapshots still hold it.
    expect(
      log.some(
        (e) =>
          e.eventType === "STEP_COMPLETED" &&
          JSON.stringify(e.payload).includes(stepBlob.__loomContent)
      )
    ).toBe(false);

    const result = await sweepUnpinnedContent({
      eventStores: [eventStore],
      snapshotStores: [snapshotStore],
      contentStore: content,
      pinnedEventTypes: [FINDING], // NOTE is kept by compaction only
      olderThanMs: DAY,
      now: 1_000 + 100 * DAY,
      touchedBefore: 2,
      reclaimOrphans: true,
    });
    expect(result.orphansReclaimed).toEqual([orphan.__loomContent]);
    expect(await content.get(stepBlob)).not.toBeNull();
    expect(await content.get(evidence)).not.toBeNull();
    expect(await content.get(orphan)).toBeNull();

    // And the execution still resumes to completion on what compaction left.
    const done = await (
      await runtime.resume("x", { eventType: "go2", payload: { ok: 2 } })
    ).waitForCompletion();
    expect(done.status).toBe("completed");
  });
});
