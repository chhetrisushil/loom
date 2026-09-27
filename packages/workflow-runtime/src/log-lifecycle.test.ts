import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import {
  CoalescingEventStore,
  InMemoryAsyncEventStore,
  InMemoryBranchRegistry,
} from "@loom/event-runtime";
import {
  EncryptingEventStore,
  EncryptingSnapshotStore,
  InMemoryKeyStore,
  PayloadShreddedError,
  shredSubject,
} from "@loom/plugin-crypto";
import { SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
import { foldEvents } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LIFECYCLE_STREAM, LogLifecycle, UnsafeCompactionError } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ n: z.number() });

const s1 = step$({ id: "s1", name: "s1", toolId: "t1", inputSchema, outputSchema });
const s2 = step$({ id: "s2", name: "s2", toolId: "t2", inputSchema, outputSchema });
const s3 = step$({ id: "s3", name: "s3", toolId: "t3", inputSchema, outputSchema });

const FLOW = "lifecycle-flow";

function completingFlow(): RegisteredFlow<{ n: number }, { n: number }> {
  const runner: FlowRunner<{ n: number }, { n: number }> = async (ctx, input) => {
    await ctx.run(s1, input);
    await ctx.run(s2, input);
    await ctx.run(s3, input);
    return { n: input.n };
  };
  const definition: FlowDefinition<{ n: number }, { n: number }> = {
    _tag: "FlowDefinition",
    id: FLOW,
    name: FLOW,
    version: "1.0.0",
    inputSchema,
    outputSchema,
    steps: [s1, s2, s3],
  };
  return { definition, runner };
}

function boot(shared?: {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
}) {
  const effects = new EffectRuntime();
  for (const id of ["t1", "t2", "t3"]) effects.register(id, new ToolEffect(async () => ({ n: 0 })));
  const stores = shared ?? {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
  };
  const runtime = new WorkflowRuntime({ ...stores, effectRuntime: effects });
  const flow = completingFlow();
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, flow, ...stores };
}

describe("K10.1 — retention", () => {
  it("reclaims a terminal execution older than the TTL; keeps a fresh one", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 1 }, { executionId: "ret-1" });
    await handle.waitForCompletion();

    const life = new LogLifecycle(app.eventStore, app.snapshotStore);
    const endedAt = (await app.eventStore.read("ret-1")).at(-1)!.timestamp;

    // Within the window → kept.
    expect(await life.applyRetention("ret-1", { terminalTtlMs: 1_000 }, endedAt + 500)).toBe(
      "kept"
    );
    expect((await app.eventStore.read("ret-1")).length).toBeGreaterThan(0);

    // Past the window → reclaimed (events + snapshots gone).
    expect(await life.applyRetention("ret-1", { terminalTtlMs: 1_000 }, endedAt + 2_000)).toBe(
      "reclaimed"
    );
    expect(await app.eventStore.read("ret-1")).toEqual([]);
    expect(await app.snapshotStore.loadLatest("ret-1")).toBeNull();
    // Idempotent: a second sweep sees nothing.
    expect(await life.applyRetention("ret-1", { terminalTtlMs: 1_000 }, endedAt + 3_000)).toBe(
      "unknown"
    );
  });

  it("never reclaims a non-terminal (suspended) execution", async () => {
    const effects = new EffectRuntime();
    const eventStore = new InMemoryAsyncEventStore();
    const snapshotStore = new InMemoryAsyncSnapshotStore();
    const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime: effects });
    const runner: FlowRunner<{ n: number }, { n: number }> = async (ctx) => {
      await ctx.suspend({ on: "Approval" });
      return { n: 0 };
    };
    const definition = {
      _tag: "FlowDefinition",
      id: "susp",
      name: "susp",
      version: "1.0.0",
      inputSchema,
      outputSchema,
      steps: [],
    } as FlowDefinition<{ n: number }, { n: number }>;
    runtime.registerFlow(definition, runner);
    const handle = await runtime.start({ definition, runner }, { n: 1 }, { executionId: "susp-1" });
    await handle.waitForSuspend();

    const life = new LogLifecycle(eventStore, snapshotStore);
    expect(await life.applyRetention("susp-1", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "not-terminal"
    );
    expect((await eventStore.read("susp-1")).length).toBeGreaterThan(0);
  });

  it("A6 — archives before deleting", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 7 }, { executionId: "arc-1" });
    await handle.waitForCompletion();
    const original = await app.eventStore.read("arc-1");

    const archiveEvents = new InMemoryAsyncEventStore();
    const archiveSnaps = new InMemoryAsyncSnapshotStore();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      archive: { eventStore: archiveEvents, snapshotStore: archiveSnaps },
    });

    expect(await life.applyRetention("arc-1", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "reclaimed"
    );
    // Primary emptied; archive holds the full log → replay from archive is byte-identical.
    expect(await app.eventStore.read("arc-1")).toEqual([]);
    expect(await archiveEvents.read("arc-1")).toEqual(original);
    expect(foldEvents(await archiveEvents.read("arc-1")).status).toBe("completed");
  });

  it("reports 'unsupported' on a store without deleteExecution", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 1 }, { executionId: "u-1" });
    await handle.waitForCompletion();
    const noDelete = new Proxy(app.eventStore, {
      get(t, p, r) {
        if (p === "deleteExecution") return undefined;
        const v = Reflect.get(t, p, r);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as InMemoryAsyncEventStore;
    const life = new LogLifecycle(noDelete, app.snapshotStore);
    expect(await life.applyRetention("u-1", { terminalTtlMs: 0 }, Date.now())).toBe("unsupported");
  });
});

describe("K10.4 — compaction (fold(snapshot, suffix) === fold(events))", () => {
  it("bounds the log and preserves the fold + resume", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 5 }, { executionId: "comp-1" });
    await handle.waitForCompletion();

    const before = await app.eventStore.read("comp-1");
    const foldBefore = foldEvents(before);
    expect(before.length).toBeGreaterThan(3);

    const life = new LogLifecycle(app.eventStore, app.snapshotStore);
    const through = await life.compact("comp-1");
    expect(through).toBe(before.at(-1)!.sequence);

    // The log is bounded (only the bootstrap anchor + nothing after the tip)…
    const after = await app.eventStore.read("comp-1");
    expect(after.length).toBeLessThan(before.length);
    expect(after[0]?.sequence).toBe(0); // sequence 0 preserved

    // …and the snapshot + surviving suffix fold to the SAME state (the invariant).
    const snap = await app.snapshotStore.loadLatest("comp-1");
    const suffix = await app.eventStore.readFrom("comp-1", snap!.sequence + 1);
    const foldAfter = foldEvents(suffix, snap!.state);
    expect(foldAfter).toEqual(foldBefore);

    // loadState (the resume path) reconstructs the completed terminal state.
    expect((await app.runtime.loadState("comp-1"))?.status).toBe("completed");
  });

  it("is a no-op on an execution with nothing beyond the bootstrap", async () => {
    const app = boot();
    const eventStore = app.eventStore;
    await eventStore.append({
      id: "tiny-0",
      workflowId: FLOW,
      executionId: "tiny",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { input: { n: 1 } },
    });
    const life = new LogLifecycle(eventStore, app.snapshotStore);
    expect(await life.compact("tiny")).toBeNull();
  });
});

describe("K10.1 R5 — branch guard + control facts", () => {
  it("refuses to delete a parent with a live descendant branch (blocked-by-branch)", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 1 }, { executionId: "parent-1" });
    await handle.waitForCompletion();

    const branchRegistry = new InMemoryBranchRegistry();
    await branchRegistry.recordLineage({
      executionId: "child-1",
      parentExecutionId: "parent-1",
      forkSequence: 1,
    });
    // The child is "live" — it has events.
    await app.eventStore.append({
      id: "c0",
      workflowId: FLOW,
      executionId: "child-1",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { input: { n: 1 } },
    });

    const life = new LogLifecycle(app.eventStore, app.snapshotStore, { branchRegistry });
    expect(await life.applyRetention("parent-1", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "blocked-by-branch"
    );
    // The parent's events are untouched.
    expect((await app.eventStore.read("parent-1")).length).toBeGreaterThan(0);
  });

  it("K10.6 — the pin predicate exempts an otherwise-reclaimable execution", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 1 }, { executionId: "pin-1" });
    await handle.waitForCompletion();

    const consulted: string[] = [];
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      pinned: async (executionId) => {
        consulted.push(executionId);
        return executionId === "pin-1";
      },
    });

    // Pinned → exempt; nothing archived, nothing deleted.
    expect(await life.applyRetention("pin-1", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "pinned"
    );
    expect(consulted).toEqual(["pin-1"]);
    expect((await app.eventStore.read("pin-1")).length).toBeGreaterThan(0);
    expect(await app.eventStore.read(LIFECYCLE_STREAM)).toEqual([]); // no archive/delete facts

    // A second execution the predicate does NOT pin reclaims normally.
    const handle2 = await app.runtime.start(app.flow, { n: 2 }, { executionId: "pin-2" });
    await handle2.waitForCompletion();
    expect(await life.applyRetention("pin-2", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "reclaimed"
    );
    expect(await app.eventStore.read("pin-2")).toEqual([]);
  });

  it("K10.6 — the pin gate runs before TTL-eligible archive copies (archive untouched)", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 1 }, { executionId: "pin-arc" });
    await handle.waitForCompletion();

    const archiveEvents = new InMemoryAsyncEventStore();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      archive: { eventStore: archiveEvents },
      pinned: () => true,
    });
    expect(await life.applyRetention("pin-arc", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "pinned"
    );
    expect(await archiveEvents.read("pin-arc")).toEqual([]); // pin means NO copy either
  });

  it("journals EXECUTION_DELETED to the lifecycle stream on reclaim", async () => {
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 1 }, { executionId: "del-1" });
    await handle.waitForCompletion();

    const now = Date.now() + 1e9;
    const life = new LogLifecycle(app.eventStore, app.snapshotStore);
    expect(await life.applyRetention("del-1", { terminalTtlMs: 0 }, now)).toBe("reclaimed");

    const lifecycleLog = await app.eventStore.read(LIFECYCLE_STREAM);
    const folded = foldEvents(lifecycleLog).variables._lifecycle as {
      op: string;
      executionId: string;
    }[];
    expect(folded).toContainEqual({ op: "deleted", executionId: "del-1", at: now });
  });
});

// ── ADR 0022 Amendment (L1) — an encrypted log is retainable and compactable, but plaintext
// never leaves the encryption boundary on the way ──────────────────────────────────────────
//
// `applyRetention` archives what it READ through the encrypting decorator — plaintext — and
// `compact` saves the DECRYPTED fold as a snapshot. Before L1 the decorator dropped
// `deleteExecution`/`truncatePrefix`, so both were impossible (every row `unsupported`,
// compaction a silent null). Forwarding them is only safe with the key rule these tests pin.

const SECRET = 918273645;

function encryptedApp(keys = new InMemoryKeyStore()) {
  const rawEvents = new SqliteEventStore(":memory:");
  const rawSnaps = new SqliteSnapshotStore(":memory:");
  const eventStore = new EncryptingEventStore(rawEvents, keys, {
    sensitive: { EXECUTION_STARTED: ["input.n"] },
  });
  const snapshotStore = new EncryptingSnapshotStore(rawSnaps, keys, {
    sensitive: ["variables._input.n"],
  });
  const effects = new EffectRuntime();
  for (const id of ["t1", "t2", "t3"]) effects.register(id, new ToolEffect(async () => ({ n: 0 })));
  const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime: effects });
  const flow = completingFlow();
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, flow, keys, rawEvents, rawSnaps, eventStore, snapshotStore };
}

describe("ADR 0022 Amendment — encrypted logs: retention + compaction under the key rule", () => {
  it("compacts an encrypted SQLite log when the snapshot store shares its KeyStore — and a shred still erases the snapshot", async () => {
    const app = encryptedApp();
    const handle = await app.runtime.start(app.flow, { n: SECRET }, { executionId: "ec-1" });
    await handle.waitForCompletion();
    const before = await app.eventStore.read("ec-1");

    const life = new LogLifecycle(app.eventStore, app.snapshotStore);
    expect(await life.compact("ec-1")).toBe(before.at(-1)!.sequence);
    expect((await app.rawEvents.read("ec-1")).length).toBeLessThan(before.length);

    // The checkpoint is at rest as CIPHERTEXT at the declared path. (Only the declared paths:
    // whether `sensitive` covers every copy of a value in the fold — step inputs in `frames`,
    // say — cannot be checked structurally; ADR 0022 and `loom doctor` say so.)
    const raw = await app.rawSnaps.loadLatest("ec-1");
    const rawInput = (raw?.state.variables._input as { n: unknown }).n;
    expect(rawInput).not.toBe(SECRET);
    expect(JSON.stringify(rawInput)).not.toContain(String(SECRET));
    expect((await app.snapshotStore.loadLatest("ec-1"))?.state.variables._input).toEqual({
      n: SECRET,
    });

    // The security property compaction must not break: destroying the key erases the subject
    // EVERYWHERE, the compaction snapshot included.
    await shredSubject(app.keys, app.rawEvents, "ec-1");
    await expect(app.snapshotStore.loadLatest("ec-1")).rejects.toThrow(PayloadShreddedError);
    await expect(app.eventStore.read("ec-1")).rejects.toThrow(PayloadShreddedError);
  });

  it("NEGATIVE — compact THROWS UnsafeCompactionError over a plaintext snapshot store, and touches nothing", async () => {
    const app = encryptedApp();
    const handle = await app.runtime.start(app.flow, { n: SECRET }, { executionId: "ec-2" });
    await handle.waitForCompletion();
    const before = await app.rawEvents.read("ec-2");
    const plain = new InMemoryAsyncSnapshotStore();

    const life = new LogLifecycle(app.eventStore, plain);
    await expect(life.compact("ec-2")).rejects.toThrow(UnsafeCompactionError);
    // Not a silent null: nothing was checkpointed in plaintext and nothing was truncated.
    expect(await plain.loadLatest("ec-2")).toBeNull();
    expect(await app.rawEvents.read("ec-2")).toEqual(before);
    // A DIFFERENT KeyStore is as unsafe as none: shredding the log's key would leave it readable.
    const otherKeys = new EncryptingSnapshotStore(
      new InMemoryAsyncSnapshotStore(),
      new InMemoryKeyStore(),
      {
        sensitive: ["variables._input.n"],
      }
    );
    await expect(new LogLifecycle(app.eventStore, otherKeys).compact("ec-2")).rejects.toThrow(
      UnsafeCompactionError
    );
  });

  it("the guard sees through a decorator stacked above the encrypting store (Coalescing(Encrypting(sqlite)))", async () => {
    const app = encryptedApp();
    const handle = await app.runtime.start(app.flow, { n: SECRET }, { executionId: "ec-3" });
    await handle.waitForCompletion();
    const outer = new CoalescingEventStore(app.eventStore);
    // The capability now reaches the outer store — so the key marker must too, or this
    // would compact straight into a plaintext store.
    expect(outer.truncatePrefix).toBeDefined();
    await expect(
      new LogLifecycle(outer, new InMemoryAsyncSnapshotStore()).compact("ec-3")
    ).rejects.toThrow(UnsafeCompactionError);
    expect(await new LogLifecycle(outer, app.snapshotStore).compact("ec-3")).not.toBeNull();
  });

  it("retains an encrypted log into an archive that shares its KeyStore — and a shred still erases the archive", async () => {
    const app = encryptedApp();
    const handle = await app.runtime.start(app.flow, { n: SECRET }, { executionId: "er-1" });
    await handle.waitForCompletion();
    await new LogLifecycle(app.eventStore, app.snapshotStore).compact("er-1"); // a snapshot to archive

    const rawArchive = new SqliteEventStore(":memory:");
    const rawArchiveSnaps = new SqliteSnapshotStore(":memory:");
    const archive = {
      eventStore: new EncryptingEventStore(rawArchive, app.keys, {
        sensitive: { EXECUTION_STARTED: ["input.n"] },
      }),
      snapshotStore: new EncryptingSnapshotStore(rawArchiveSnaps, app.keys, {
        sensitive: ["variables._input.n"],
      }),
    };
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, { archive });
    expect(await life.applyRetention("er-1", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "reclaimed"
    );
    expect(await app.rawEvents.read("er-1")).toEqual([]);
    expect(await app.rawSnaps.loadLatest("er-1")).toBeNull(); // EncryptingSnapshotStore.deleteExecution forwarded
    // Archived at rest as ciphertext (at the declared paths — see the compaction test).
    const archivedStart = (await rawArchive.read("er-1"))[0]?.payload as { input: { n: unknown } };
    expect(JSON.stringify(archivedStart.input.n)).not.toContain(String(SECRET));
    const archivedSnap = await rawArchiveSnaps.loadLatest("er-1");
    expect(archivedSnap).not.toBeNull();
    const archivedSnapInput = (archivedSnap?.state.variables._input as { n: unknown }).n;
    expect(JSON.stringify(archivedSnapInput)).not.toContain(String(SECRET));
    expect((await archive.eventStore.read("er-1"))[0]?.payload).toMatchObject({
      input: { n: SECRET },
    });

    await shredSubject(app.keys, rawArchive, "er-1");
    await expect(archive.eventStore.read("er-1")).rejects.toThrow(PayloadShreddedError);
    await expect(archive.snapshotStore.loadLatest("er-1")).rejects.toThrow(PayloadShreddedError);
  });

  it("NEGATIVE — an archive without the same keys is refused as 'unsafe-archive', and nothing is copied or deleted", async () => {
    const app = encryptedApp();
    const handle = await app.runtime.start(app.flow, { n: SECRET }, { executionId: "er-2" });
    await handle.waitForCompletion();
    const before = await app.rawEvents.read("er-2");
    const plainArchive = new InMemoryAsyncEventStore();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      archive: { eventStore: plainArchive },
    });
    const now = Date.now() + 1e9;
    // The preview and the apply agree (the dry run cannot drift from the thing it previews).
    expect(await life.evaluate("er-2", { terminalTtlMs: 0 }, now)).toBe("unsafe-archive");
    expect(await life.applyRetention("er-2", { terminalTtlMs: 0 }, now)).toBe("unsafe-archive");
    expect(await plainArchive.read("er-2")).toEqual([]);
    expect(await app.rawEvents.read("er-2")).toEqual(before);

    // Same event keys but a plaintext archive SNAPSHOT store: the snapshot copy would leak.
    const halfSafe = new LogLifecycle(app.eventStore, app.snapshotStore, {
      archive: {
        eventStore: new EncryptingEventStore(new InMemoryAsyncEventStore(), app.keys, {
          sensitive: { EXECUTION_STARTED: ["input.n"] },
        }),
        snapshotStore: new InMemoryAsyncSnapshotStore(),
      },
    });
    expect(await halfSafe.applyRetention("er-2", { terminalTtlMs: 0 }, now)).toBe("unsafe-archive");
    expect(await app.rawEvents.read("er-2")).toEqual(before);
  });

  it("a plain (unencrypted) log is unaffected by the key rule — and a COMPACTED execution is still reclaimable", async () => {
    // The second half is a regression: `evaluate` folded only the surviving log, and a log
    // compacted through its tip is just the bootstrap, so it read as not-terminal forever.
    const app = boot();
    const handle = await app.runtime.start(app.flow, { n: 1 }, { executionId: "pl-1" });
    await handle.waitForCompletion();
    const life = new LogLifecycle(app.eventStore, app.snapshotStore, {
      archive: {
        eventStore: new InMemoryAsyncEventStore(),
        snapshotStore: new InMemoryAsyncSnapshotStore(),
      },
    });
    expect(await life.compact("pl-1")).not.toBeNull();
    expect(await life.applyRetention("pl-1", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "reclaimed"
    );
  });
});
