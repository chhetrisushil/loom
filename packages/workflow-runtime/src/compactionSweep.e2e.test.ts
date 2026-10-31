import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryArchiveStore, InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  ArchiveStoresRequiredError,
  ContentResolvingEventStore,
  ContentTouchingSnapshotStore,
  InMemoryContentStore,
  sweepUnpinnedContent,
} from "@loom/plugin-content";
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
    const clock = { now: 1 };
    const content = new InMemoryContentStore({ now: () => clock.now });
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
    const archive = new InMemoryArchiveStore();
    const life = new LogLifecycle(eventStore, snapshotStore, {
      compactionArchive: archive,
      pinnedEventTypes: [FINDING, NOTE],
    });

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

    clock.now = 1_000 + 100 * DAY; // the store's clock at sweep time: cutoff = now - DAY, far past every put
    const result = await sweepUnpinnedContent({
      eventStores: [eventStore],
      snapshotStores: [snapshotStore],
      archiveStores: [archive], // ADR 0138: what compaction moved is cited only there
      contentStore: content,
      pinnedEventTypes: [FINDING], // NOTE is kept by compaction only
      olderThanMs: DAY,
      now: 1_000 + 100 * DAY,
      reclaimOrphans: { completeScan: true, snapshotsTouchContent: true },
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

  // ADR 0055 D6 amendment 2 — the SECOND citation path. A parent compacted through its tip keeps
  // its prefix refs ONLY in its snapshot; a fork copies just the post-gap events and seeds the
  // child's snapshot with the parent's folded state, so an R5 media source cited only in the
  // truncated prefix reaches the child through the seed with no `put` and no event.
  describe("fork of a compacted parent mid-sweep (the seed snapshot is a citation path)", () => {
    const media = (address: string) => ({ kind: "ref", ref: { address } });

    async function forkMidSweep(touching: boolean) {
      const clock = { now: 1 };
      const content = new InMemoryContentStore({ now: () => clock.now });
      const blob = await content.put(new TextEncoder().encode("media cited only by the prefix"));
      const effects = new EffectRuntime();
      effects.register("fetch", new ToolEffect(async () => ({ clip: media(blob.__loomContent) })));
      const definition: FlowDefinition<unknown, unknown> = {
        _tag: "FlowDefinition",
        id: "seed-fork",
        name: "seed-fork",
        version: "1.0.0",
        inputSchema: anyIo,
        outputSchema: anyIo,
        steps: [fetch],
      };
      const runner: FlowRunner<unknown, unknown> = async (ctx) => {
        await ctx.run(fetch, {});
        await ctx.suspend({ on: "go" });
        return {};
      };
      const archive = new InMemoryArchiveStore();
      const rawEvents = new InMemoryAsyncEventStore();
      const rawSnaps = new InMemoryAsyncSnapshotStore();
      const eventStore = new ContentResolvingEventStore(rawEvents, content, { externalize: {} });
      const snapshotStore = touching
        ? new ContentTouchingSnapshotStore(rawSnaps, content)
        : rawSnaps;
      const runtime = new WorkflowRuntime({
        eventStore,
        snapshotStore,
        effectRuntime: effects,
        now: () => 1_000,
        onWarn: () => {},
      });
      runtime.registerFlow(definition, runner);
      await (
        await runtime.start({ definition, runner }, {}, { executionId: "p-parent" })
      ).waitForSuspend();
      const tip = (await eventStore.head!("p-parent"))!;
      await new LogLifecycle(eventStore, snapshotStore, {
        compactionArchive: archive,
      }).compact("p-parent");
      // The prefix no longer cites the blob: only the parent's checkpoint does.
      expect(JSON.stringify(await rawEvents.read("p-parent"))).not.toContain(blob.__loomContent);
      // "a-child" sorts before the parent, so the scan has passed it when the fork lands. Two
      // events, because a one-event log reads as "compacted at its tip" and would be pinned
      // through the very snapshot the fork seeds.
      for (const [sequence, eventType] of [
        [0, "EXECUTION_STARTED"],
        [1, "STEP_COMPLETED"],
      ] as const) {
        await rawEvents.append({
          id: `a-${sequence}`,
          workflowId: "wf",
          executionId: "a-child",
          eventType,
          sequence,
          timestamp: 1,
          payload: { input: {} },
        });
      }
      const read = rawEvents.read.bind(rawEvents);
      const scanned = Object.assign(Object.create(rawEvents) as InMemoryAsyncEventStore, {
        read: async (id: string) => {
          const events = await read(id);
          if (id === "a-child") {
            clock.now += 1; // the fork happens after the sweep started
            await rawEvents.deleteExecution("a-child");
            await runtime.fork("p-parent", tip, { executionId: "a-child" });
            await rawEvents.deleteExecution("p-parent"); // retention reaps the parent
            await rawSnaps.deleteExecution("p-parent");
          }
          return events;
        },
      });
      clock.now = 100 * DAY;
      const result = await sweepUnpinnedContent({
        eventStores: [scanned],
        snapshotStores: [rawSnaps],
        // ADR 0138: `[]` ISOLATES the seed-snapshot citation path under test. Were the parent's
        // archive scanned, its archived prefix event would pin the blob and no citation race exists.
        // `[]` is accepted here because the only log scanned is the CHILD, whose checkpoint is a fork
        // seed (no archiving mark): over an archived log `[]` is refused (see the describe below).
        archiveStores: [],
        contentStore: content,
        pinnedEventTypes: [],
        olderThanMs: DAY,
        now: 100 * DAY,
        reclaimOrphans: { completeScan: true, snapshotsTouchContent: true },
      });
      return { result, content, blob, runtime };
    }

    it("a ContentTouchingSnapshotStore touches the seed's citations, so the blob survives and the child still resumes", async () => {
      const { result, content, blob, runtime } = await forkMidSweep(true);
      expect(result.orphansReclaimed).toEqual([]);
      expect(await content.get(blob)).not.toBeNull();
      const done = await (
        await runtime.resume("a-child", { eventType: "go", payload: { ok: 1 } })
      ).waitForCompletion();
      expect(done.status).toBe("completed");
    });

    it("control: without the decorator the same fork loses the blob (the gap is real)", async () => {
      const { result, content, blob } = await forkMidSweep(false);
      expect(result.orphansReclaimed).toEqual([blob.__loomContent]);
      expect(await content.get(blob)).toBeNull();
    });
  });
});

// ADR 0138 - `archiveStores: []` is CHECKED, not trusted: it is only believable over logs compacted
// before the archive existed. Over a log an archiving compaction DID move events out of, `[]` (or an
// archive that does not hold them) would let an erasing pass delete blobs the recoverable history names.
describe("ADR 0138 - archiveStores: [] over an archived log is refused", () => {
  async function archivedLog() {
    const clock = { now: 1 };
    const content = new InMemoryContentStore({ now: () => clock.now });
    const stepBlob = await content.put(new TextEncoder().encode("cited by the archived step"));
    const effects = new EffectRuntime();
    effects.register(
      "fetch",
      new ToolEffect(async () => ({ rows: { __loomClaimCheck: true, ref: stepBlob, size: 1 } }))
    );
    effects.register("later", new ToolEffect(async () => ({ rows: 0 })));
    const definition: FlowDefinition<unknown, unknown> = {
      _tag: "FlowDefinition",
      id: "sweep-empty",
      name: "sweep-empty",
      version: "1.0.0",
      inputSchema: anyIo,
      outputSchema: anyIo,
      steps: [fetch, later],
    };
    const runner: FlowRunner<unknown, unknown> = async (ctx) => {
      await ctx.run(fetch, {});
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
    const archive = new InMemoryArchiveStore();
    const life = new LogLifecycle(eventStore, snapshotStore, { compactionArchive: archive });
    await (await runtime.start({ definition, runner }, {}, { executionId: "e" })).waitForSuspend();
    await life.compact("e");
    await (await runtime.resume("e", { eventType: "go1", payload: {} })).waitForSuspend();
    await life.compact("e");
    clock.now = 100 * DAY;
    const sweep = (archiveStores: InMemoryArchiveStore[], dryRun = false) =>
      sweepUnpinnedContent({
        eventStores: [eventStore],
        snapshotStores: [snapshotStore],
        archiveStores,
        contentStore: content,
        pinnedEventTypes: [],
        olderThanMs: DAY,
        now: 100 * DAY,
        dryRun,
        reclaimOrphans: { completeScan: true, snapshotsTouchContent: true },
      });
    return { archive, content, stepBlob, sweep };
  }

  it("[] is refused (nothing erased); so is an empty or foreign archive; the real one is accepted", async () => {
    const { archive, content, stepBlob, sweep } = await archivedLog();
    await expect(sweep([])).rejects.toBeInstanceOf(ArchiveStoresRequiredError);
    await expect(sweep([])).rejects.toMatchObject({ reason: "uncovered", executionIds: ["e"] });
    await expect(sweep([new InMemoryArchiveStore()])).rejects.toBeInstanceOf(
      ArchiveStoresRequiredError
    );
    expect(await content.get(stepBlob)).not.toBeNull(); // nothing was erased by the refusals
    // a dry run reports without erasing, so `[]` is harmless there
    await expect(sweep([], true)).resolves.toBeDefined();
    const ok = await sweep([archive]);
    expect(ok.orphansReclaimed).toEqual([]);
    expect(await content.get(stepBlob)).not.toBeNull();
  });
});
