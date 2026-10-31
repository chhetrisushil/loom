import { canonicalJson, step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import {
  ArchiveIncarnationError,
  type ArchiveStore,
  type EventStore,
  InMemoryArchiveStore,
  InMemoryAsyncEventStore,
  TenantScopedArchiveStore,
  TenantScopedEventStore,
} from "@loom/event-runtime";
import {
  EncryptingArchiveStore,
  EncryptingEventStore,
  EncryptingSnapshotStore,
  InMemoryKeyStore,
} from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore, type SnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LogLifecycle } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
import {
  ArchiveIncompleteError,
  ArchiveLogMismatchError,
  ArchiveTenantMismatchError,
  PlaintextArchiveError,
} from "./checkpointGuard";
import type { FlowRunner } from "./types";

// ADR 0138 review round: legacy remnant (B2), incarnation binding (H2), tenant scoping (H3),
// duplicate byte-compare (M2), subject mapping (M4), unserializable envelopes (L1).

const io = z.object({ n: z.number() });
const s1 = step$({ id: "s1", name: "s1", toolId: "t1", inputSchema: io, outputSchema: io });
const s2 = step$({ id: "s2", name: "s2", toolId: "t2", inputSchema: io, outputSchema: io });

const definition: FlowDefinition<{ n: number }, { n: number }> = {
  _tag: "FlowDefinition",
  id: "review-flow",
  name: "review-flow",
  version: "1.0.0",
  inputSchema: io,
  outputSchema: io,
  steps: [s1, s2],
};

const runner: FlowRunner<{ n: number }, { n: number }> = async (ctx, input) => {
  const a = await ctx.run(s1, input);
  await ctx.suspend({ on: "go1" });
  const b = await ctx.run(s2, a);
  await ctx.suspend({ on: "go2" });
  return { n: b.n };
};

function boot(eventStore: EventStore, snapshotStore: SnapshotStore) {
  const effects = new EffectRuntime();
  for (const id of ["t1", "t2"] as const) {
    effects.register(id, new ToolEffect(async (x: { n: number }) => ({ n: x.n + 1 })));
  }
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime: effects,
    now: () => 1_000,
  });
  runtime.registerFlow(definition, runner);
  return runtime;
}

const plain = () => ({
  eventStore: new InMemoryAsyncEventStore() as EventStore,
  snapshotStore: new InMemoryAsyncSnapshotStore() as SnapshotStore,
  archive: new InMemoryArchiveStore() as ArchiveStore,
});

const bytes = (events: readonly EventEnvelope[]) => events.map((e) => canonicalJson(e));

describe("B2 - a log compacted BEFORE the archive existed keeps its settled inputs", () => {
  /** Compact once WITH an archive, then rewrite history as pre-0138: no archive, a checkpoint that carries inputs. */
  async function legacyExecution(id: string) {
    const stores = plain();
    const runtime = boot(stores.eventStore, stores.snapshotStore);
    const original = new InMemoryArchiveStore();
    const first = new LogLifecycle(stores.eventStore, stores.snapshotStore, {
      compactionArchive: original,
    });
    await (
      await runtime.start({ definition, runner }, { n: 7 }, { executionId: id })
    ).waitForSuspend();
    const inputsBefore = (await stores.eventStore.read(id))
      .filter((e) => e.eventType === "STEP_STARTED")
      .map((e) => (e.payload as { input: unknown }).input);
    const through = (await first.compact(id))!;
    const checkpoint = (await stores.snapshotStore.loadLatest(id))!;
    // The pre-0138 checkpoint: the fold copied the step input into the settled frame.
    const legacyState = JSON.parse(JSON.stringify(checkpoint.state)) as typeof checkpoint.state;
    for (const frame of Object.values(legacyState.frames)) {
      (frame as { input?: unknown }).input = { n: 7 };
    }
    const legacySnapshot = { ...checkpoint, id: "legacy-checkpoint", state: legacyState };
    await stores.snapshotStore.save(legacySnapshot);
    // ... and the earlier compaction had no archive: its removed events are gone.
    await original.deleteExecution!(id);
    return { ...stores, runtime, through, legacySnapshot, inputsBefore };
  }

  it("a post-0138 compaction preserves the old checkpoint byte-exact as a typed legacy segment, recoverable without GC", async () => {
    const { eventStore, snapshotStore, runtime, through, legacySnapshot } =
      await legacyExecution("legacy");
    const archive = new InMemoryArchiveStore();
    const life = new LogLifecycle(eventStore, snapshotStore, { compactionArchive: archive });
    await (
      await runtime.resume("legacy", { eventType: "go1", payload: { answer: 1 } })
    ).waitForSuspend();
    expect(await life.compact("legacy")).not.toBeNull();

    const headers = await life.archiveHeaders("legacy");
    expect(headers[0]).toMatchObject({ kind: "legacy-checkpoint", from: 1, through });
    expect(headers[1]?.from).toBe(through + 1); // the events segment abuts it
    const [kept] = await life.readLegacyCheckpoints("legacy");
    expect(canonicalJson(kept)).toBe(canonicalJson(legacySnapshot)); // byte-exact, inputs included
    expect(
      Object.values(kept!.state.frames).every((f) => (f as { input?: unknown }).input !== undefined)
    ).toBe(true);
    // the NEW checkpoint is normalized (no settled input): the legacy segment is now the only copy
    const next = (await snapshotStore.loadLatest("legacy"))!;
    expect(
      Object.values(next.state.frames).some(
        (f) =>
          (f as { input?: unknown }).input !== undefined &&
          (f as { status: string }).status === "completed"
      )
    ).toBe(false);
  });

  it("readArchived / readWithArchive REPORT the unarchived legacy range instead of a silent hole", async () => {
    const { eventStore, snapshotStore, runtime, through } = await legacyExecution("legacy2");
    const life = new LogLifecycle(eventStore, snapshotStore, {
      compactionArchive: new InMemoryArchiveStore(),
    });
    await (
      await runtime.resume("legacy2", { eventType: "go1", payload: { answer: 1 } })
    ).waitForSuspend();
    await life.compact("legacy2");

    const cov = await life.archiveCoverage("legacy2");
    expect(cov.unarchived).toEqual([{ from: 1, through, why: "legacy" }]);
    await expect(life.readArchived("legacy2")).rejects.toBeInstanceOf(ArchiveIncompleteError);
    await expect(life.readWithArchive("legacy2")).rejects.toThrow(/readLegacyCheckpoints/);
    // a range clear of the legacy range is fine; so is an explicit opt-in
    const above = await life.readArchived("legacy2", { from: through + 1 });
    expect(above.length).toBeGreaterThan(0);
    const partial = await life.readWithArchive("legacy2", { allowIncomplete: true });
    expect(partial[0]!.sequence).toBe(0);
  });

  it("a log compacted BEFORE the archive existed reads `legacy`; the same log with its archive WIPED reads `missing`", async () => {
    // pre-0138 shape: an unmarked checkpoint, nothing archived
    const { eventStore, snapshotStore } = await legacyExecution("pre");
    const fresh = new LogLifecycle(eventStore, snapshotStore, {
      compactionArchive: new InMemoryArchiveStore(),
    });
    const pre = await fresh.archiveCoverage("pre");
    expect(pre.unarchived.map((r) => r.why)).toEqual(["legacy"]);

    // post-0138: an archiving compaction, then the archive loses the execution
    const plainStores = plain();
    const runtime = boot(plainStores.eventStore, plainStores.snapshotStore);
    const life = new LogLifecycle(plainStores.eventStore, plainStores.snapshotStore, {
      compactionArchive: plainStores.archive,
    });
    await (
      await runtime.start({ definition, runner }, { n: 1 }, { executionId: "wiped" })
    ).waitForSuspend();
    const through = (await life.compact("wiped"))!;
    expect((await life.archiveCoverage("wiped")).unarchived).toEqual([]);
    await plainStores.archive.deleteExecution!("wiped");
    expect((await life.archiveCoverage("wiped")).unarchived).toEqual([
      { from: 1, through, why: "missing" },
    ]);
    await expect(life.readWithArchive("wiped")).rejects.toBeInstanceOf(ArchiveIncompleteError);
    // a swapped-in EMPTY archive is the same loss
    const swapped = new LogLifecycle(plainStores.eventStore, plainStores.snapshotStore, {
      compactionArchive: new InMemoryArchiveStore(),
    });
    expect((await swapped.archiveCoverage("wiped")).unarchived.map((r) => r.why)).toEqual([
      "missing",
    ]);
  });

  it("with NO legacy history the coverage is complete (nothing reported)", async () => {
    const { eventStore, snapshotStore, archive } = plain();
    const runtime = boot(eventStore, snapshotStore);
    const life = new LogLifecycle(eventStore, snapshotStore, { compactionArchive: archive });
    await (
      await runtime.start({ definition, runner }, { n: 1 }, { executionId: "fresh" })
    ).waitForSuspend();
    await life.compact("fresh");
    expect((await life.archiveCoverage("fresh")).unarchived).toEqual([]);
    expect(await life.readLegacyCheckpoints("fresh")).toEqual([]);
  });
});

describe("H2 - an archive is bound to the incarnation of its log (a reused execution id)", () => {
  it("a reused id does not inherit the previous run's archive: typed error naming reuse, nothing mixed", async () => {
    const { eventStore, snapshotStore, archive } = plain();
    const runtime = boot(eventStore, snapshotStore);
    const retentionCopy = {
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
    };
    // A retention archive KEEPS the execution, so its compaction segments are left behind.
    const life = new LogLifecycle(eventStore, snapshotStore, {
      compactionArchive: archive,
      archive: retentionCopy,
    });
    await (
      await runtime.start({ definition, runner }, { n: 1 }, { executionId: "x" })
    ).waitForSuspend();
    await life.compact("x");
    await (
      await runtime.resume("x", { eventType: "go1", payload: { answer: 1 } })
    ).waitForSuspend();
    await (
      await runtime.resume("x", { eventType: "go2", payload: { answer: 2 } })
    ).waitForCompletion();
    expect(await life.applyRetention("x", { terminalTtlMs: 1 }, Date.now() + 1e9)).toBe(
      "reclaimed"
    );
    expect((await life.archiveHeaders("x")).length).toBe(1); // segments left with the kept execution

    await (
      await runtime.start({ definition, runner }, { n: 100 }, { executionId: "x" })
    ).waitForSuspend();
    await expect(life.compact("x")).rejects.toBeInstanceOf(ArchiveIncarnationError);
    await expect(life.compact("x")).rejects.toThrow(/reused/);
    await expect(life.readArchived("x")).rejects.toBeInstanceOf(ArchiveIncarnationError);
    await expect(life.readWithArchive("x")).rejects.toBeInstanceOf(ArchiveIncarnationError);
    // and the previous run's segments were not extended
    expect((await archive.headers("x")).length).toBe(1);
  });

  it("the re-compact no-op does not hide a reused-id leftover: a tip-retaining store with a foreign-incarnation archive refuses instead of returning null", async () => {
    const { buildSegment } = await import("@loom/event-runtime");
    const { eventStore: inner, snapshotStore, archive } = plain();
    // a store that keeps the tip as an anchor (a hash chain): truncates through - 1
    const keepsTip = Object.assign(Object.create(inner) as InMemoryAsyncEventStore, {
      truncatePrefix: async (id: string, through: number) => inner.truncatePrefix!(id, through - 1),
    }) as EventStore;
    const runtime = boot(inner, snapshotStore);
    await (
      await runtime.start({ definition, runner }, { n: 1 }, { executionId: "t" })
    ).waitForSuspend();
    const original = await inner.read("t");
    const life = new LogLifecycle(keepsTip, snapshotStore, { compactionArchive: archive });
    expect(await life.compact("t")).not.toBeNull();
    expect(await life.compact("t")).toBeNull(); // the true no-op
    // the same id now meets an archive holding ANOTHER run's segments
    const foreign = new InMemoryArchiveStore();
    await foreign.append(
      "t",
      buildSegment(original.slice(1), "some-other-run", 1, original[original.length - 1]!.sequence)
    );
    const meets = new LogLifecycle(keepsTip, snapshotStore, { compactionArchive: foreign });
    await expect(meets.compact("t")).rejects.toBeInstanceOf(ArchiveIncarnationError);
  });

  it("on the plain-delete path the segments go BEFORE the log, so a crash leaves nothing a reused id can meet", async () => {
    const { snapshotStore, archive } = plain();
    const inner = new InMemoryAsyncEventStore();
    let failDelete = true;
    const eventStore = Object.assign(Object.create(inner) as InMemoryAsyncEventStore, {
      deleteExecution: async (id: string) => {
        if (failDelete) throw new Error("crash before the log delete");
        return inner.deleteExecution(id);
      },
    }) as EventStore;
    const runtime = boot(inner, snapshotStore);
    const life = new LogLifecycle(eventStore, snapshotStore, { compactionArchive: archive });
    await (
      await runtime.start({ definition, runner }, { n: 1 }, { executionId: "p" })
    ).waitForSuspend();
    await life.compact("p");
    await (
      await runtime.resume("p", { eventType: "go1", payload: { answer: 1 } })
    ).waitForSuspend();
    await (
      await runtime.resume("p", { eventType: "go2", payload: { answer: 2 } })
    ).waitForCompletion();

    await expect(life.applyRetention("p", { terminalTtlMs: 1 }, Date.now() + 1e9)).rejects.toThrow(
      /crash/
    );
    expect(await archive.headers("p")).toEqual([]); // already gone: nothing for a reused id to inherit
    failDelete = false;
    expect(await life.applyRetention("p", { terminalTtlMs: 1 }, Date.now() + 1e9)).toBe(
      "reclaimed"
    ); // the retry finishes
    // a reused id then archives its own history cleanly
    await (
      await runtime.start({ definition, runner }, { n: 5 }, { executionId: "p" })
    ).waitForSuspend();
    expect(await life.compact("p")).not.toBeNull();
    const all = await life.readWithArchive("p");
    expect(all.map((e) => e.sequence)).toEqual(all.map((_, i) => i));
  });
});

describe("H3 - tenant scoping of the compaction archive", () => {
  it("refuses a tenant-scoped log with a shared (or differently scoped) archive, and the reverse", async () => {
    const shared = new InMemoryAsyncEventStore();
    const snaps = new InMemoryAsyncSnapshotStore();
    const archive = new InMemoryArchiveStore();
    const a = new TenantScopedEventStore(shared, "a");
    const runtimeA = boot(a, snaps);
    await (
      await runtimeA.start({ definition, runner }, { n: 1 }, { executionId: "x" })
    ).waitForSuspend();

    const unscoped = new LogLifecycle(a, snaps, { compactionArchive: archive });
    await expect(unscoped.compact("x")).rejects.toBeInstanceOf(ArchiveTenantMismatchError);
    const wrongTenant = new LogLifecycle(a, snaps, {
      compactionArchive: new TenantScopedArchiveStore(archive, "b"),
    });
    await expect(wrongTenant.compact("x")).rejects.toBeInstanceOf(ArchiveTenantMismatchError);
    const logUnscoped = new LogLifecycle(shared, snaps, {
      compactionArchive: new TenantScopedArchiveStore(archive, "a"),
    });
    await expect(logUnscoped.compact("a:x")).rejects.toBeInstanceOf(ArchiveTenantMismatchError);
    expect(await archive.headers("a:x")).toEqual([]); // nothing was archived by any refusal
    expect((await shared.read("a:x")).length).toBeGreaterThan(2); // nothing was truncated
  });

  it("two tenants sharing one archive and one execution id stay apart; B's plain-delete retention cannot touch A's segments", async () => {
    const shared = new InMemoryAsyncEventStore();
    const sharedSnaps = new InMemoryAsyncSnapshotStore();
    const archive = new InMemoryArchiveStore();
    const lives: Record<string, LogLifecycle> = {};
    for (const t of ["a", "b"]) {
      const ev = new TenantScopedEventStore(shared, t);
      const rt = boot(ev, sharedSnaps);
      lives[t] = new LogLifecycle(ev, sharedSnaps, {
        compactionArchive: new TenantScopedArchiveStore(archive, t),
      });
      await (
        await rt.start({ definition, runner }, { n: t === "a" ? 1 : 2 }, { executionId: "x" })
      ).waitForSuspend();
      expect(await lives[t]!.compact("x")).not.toBeNull();
    }
    expect((await lives.a!.archiveHeaders("x")).length).toBe(1);
    const aInputs = (await lives.a!.readWithArchive("x")).map((e) => JSON.stringify(e.payload));
    const bInputs = (await lives.b!.readWithArchive("x")).map((e) => JSON.stringify(e.payload));
    expect(aInputs.join()).not.toBe(bInputs.join()); // each reads only its own history
    // tenant B's execution is deleted on the plain path: A's segments survive
    await (
      await boot(new TenantScopedEventStore(shared, "b"), sharedSnaps).resume("x", {
        eventType: "go1",
        payload: { answer: 1 },
      })
    ).waitForSuspend();
    await (
      await boot(new TenantScopedEventStore(shared, "b"), sharedSnaps).resume("x", {
        eventType: "go2",
        payload: { answer: 2 },
      })
    ).waitForCompletion();
    expect(await lives.b!.applyRetention("x", { terminalTtlMs: 1 }, Date.now() + 1e9)).toBe(
      "reclaimed"
    );
    expect(await lives.b!.archiveHeaders("x")).toEqual([]);
    expect((await lives.a!.archiveHeaders("x")).length).toBe(1);
    expect((await lives.a!.readWithArchive("x")).length).toBeGreaterThan(2);
  });
});

describe("M2 - a duplicate sequence is compared byte-exact, never silently resolved", () => {
  it("identical copies (the crash window) stitch cleanly; a differing log copy is a typed mismatch", async () => {
    const { snapshotStore, archive } = plain();
    const inner = new InMemoryAsyncEventStore();
    const crashTruncate = true;
    const store = Object.assign(Object.create(inner) as InMemoryAsyncEventStore, {
      truncatePrefix: async (id: string, through: number) => {
        if (crashTruncate) throw new Error("crash after archive, before truncate");
        return inner.truncatePrefix(id, through);
      },
    }) as EventStore;
    const runtime = boot(inner, snapshotStore);
    const life = new LogLifecycle(store, snapshotStore, { compactionArchive: archive });
    await (
      await runtime.start({ definition, runner }, { n: 1 }, { executionId: "m" })
    ).waitForSuspend();
    await expect(life.compact("m")).rejects.toThrow(/crash/);
    // the events are in the log AND the archive, identical: one entry each
    const ok = await life.readWithArchive("m");
    expect(ok.map((e) => e.sequence)).toEqual(ok.map((_, i) => i));

    const altered = Object.assign(Object.create(inner) as InMemoryAsyncEventStore, {
      read: async (id: string) =>
        (await inner.read(id)).map((e) =>
          e.sequence === 1 ? { ...e, payload: { forged: true } } : e
        ),
    }) as EventStore;
    const audit = new LogLifecycle(altered, snapshotStore, { compactionArchive: archive });
    await expect(audit.readWithArchive("m")).rejects.toBeInstanceOf(ArchiveLogMismatchError);
    expect(bytes(ok).length).toBeGreaterThan(0);
  });
});

describe("M4 - the archive must use the event store's subject mapping", () => {
  const sealed = (logSubject: boolean, archiveSubject: boolean) => {
    const keys = new InMemoryKeyStore();
    const custom = (s: { executionId: string }) => `tenant-of-${s.executionId}`;
    const eventStore = new EncryptingEventStore(new InMemoryAsyncEventStore(), keys, {
      sensitive: { EXECUTION_STARTED: ["input"] },
      ...(logSubject && { subjectOf: custom }),
    });
    const snapshotStore = new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), keys, {
      sealState: true,
      ...(logSubject && { subjectOf: custom }),
    });
    const archive = new EncryptingArchiveStore(new InMemoryArchiveStore(), keys, {
      ...(archiveSubject && { subjectOf: custom }),
    });
    return { eventStore, snapshotStore, archive };
  };

  it("a custom subjectOf on the log only is refused (a shred of the subject would leave the archive readable)", async () => {
    const { eventStore, snapshotStore, archive } = sealed(true, false);
    const runtime = boot(eventStore, snapshotStore);
    await (
      await runtime.start({ definition, runner }, { n: 1 }, { executionId: "k" })
    ).waitForSuspend();
    const life = new LogLifecycle(eventStore, snapshotStore, { compactionArchive: archive });
    const err = await life.compact("k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaintextArchiveError);
    expect((err as PlaintextArchiveError).reason).toBe("subject-mismatch");
    expect((await eventStore.read("k")).length).toBeGreaterThan(2); // nothing moved
  });

  it("the same mapping on both sides compacts", async () => {
    const { eventStore, snapshotStore, archive } = sealed(true, true);
    const runtime = boot(eventStore, snapshotStore);
    await (
      await runtime.start({ definition, runner }, { n: 1 }, { executionId: "k2" })
    ).waitForSuspend();
    const life = new LogLifecycle(eventStore, snapshotStore, { compactionArchive: archive });
    expect(await life.compact("k2")).not.toBeNull();
  });
});

describe("L1 - envelopes that are not plain JSON", () => {
  it("a Date / toJSON payload digests identically before and after a JSON round trip (no false ArchiveDigestError)", async () => {
    const { eventStore, snapshotStore, archive } = plain();
    const runtime = boot(eventStore, snapshotStore);
    const life = new LogLifecycle(eventStore, snapshotStore, { compactionArchive: archive });
    await (
      await runtime.start({ definition, runner }, { n: 1 }, { executionId: "d" })
    ).waitForSuspend();
    // an in-memory store returns what it was handed: smuggle a Date into a not-yet-compacted event
    const live = await eventStore.read("d");
    const stamped = live.find((e) => e.eventType === "STEP_COMPLETED")!;
    (stamped.payload as Record<string, unknown>).at = new Date(0);
    expect(await life.compact("d")).not.toBeNull();
    const back = await life.readArchived("d");
    expect(JSON.stringify(back)).toContain("1970-01-01T00:00:00.000Z");
  });
});
