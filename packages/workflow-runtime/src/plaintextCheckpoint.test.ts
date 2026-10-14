import { unwrapTainted } from "@loom/classify";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  EncryptingEventStore,
  EncryptingSnapshotStore,
  InMemoryKeyStore,
} from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { LogLifecycle } from "./LogLifecycle";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { build, echo, flow, until } from "./__tests__/r2Harness";

// ADR 0130 D8 (kernel half) - when the event store seals, the kernel refuses a checkpoint into a
// snapshot store that does not seal the WHOLE folded state under the SAME KeyStore. A checkpoint is
// an optimisation; the log is the source of truth, so a refused checkpoint never fails a run.

const SECRET = "hunter2-wait-answer";

function sealed() {
  const keys = new InMemoryKeyStore();
  const events = new EncryptingEventStore(new InMemoryAsyncEventStore(), keys, {
    sensitive: { INBOX_MESSAGE: ["payload"] },
    subjectOf: (e) => e.executionId,
  });
  return { keys, events };
}

function boot(deps: ConstructorParameters<typeof WorkflowRuntime>[0]): unknown {
  try {
    new WorkflowRuntime(deps);
    return undefined;
  } catch (err) {
    return err;
  }
}

const f = flow("w", async (ctx) => {
  const y = unwrapTainted(await ctx.receive<unknown>("y"));
  await ctx.suspend({ on: "Go" });
  return { y };
});

const done = flow("done", async () => ({ ok: true }));

const refusal = (err: unknown) => err as Error & { reason?: string; retryable?: boolean };

describe("kernel refusal of a plaintext checkpoint (ADR 0130 D8)", () => {
  const stores = () => {
    const { keys, events } = sealed();
    return { keys, events, effects: build().effects };
  };

  it("refuses a plaintext snapshot store at construction, naming BOTH fixes", () => {
    const { events, effects } = stores();
    const err = refusal(
      boot({
        eventStore: events,
        snapshotStore: new InMemoryAsyncSnapshotStore(),
        effectRuntime: effects,
      })
    );
    expect(err.name).toBe("PlaintextCheckpointError");
    expect(err.reason).toBe("not-sealed");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("sealState");
    expect(err.message).toContain("allowPlaintextCheckpoints");
  });

  it("refuses a static-path EncryptingSnapshotStore (it leaves _waitAnswers plaintext)", () => {
    const { keys, events, effects } = stores();
    const snaps = new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), keys, {
      sensitive: ["variables._input.ssn"],
    });
    const err = refusal(boot({ eventStore: events, snapshotStore: snaps, effectRuntime: effects }));
    expect(err.name).toBe("PlaintextCheckpointError");
    expect(err.reason).toBe("not-sealed");
  });

  it("refuses a sealState store under DIFFERENT keys (keys-not-shared)", () => {
    const { events, effects } = stores();
    const snaps = new EncryptingSnapshotStore(
      new InMemoryAsyncSnapshotStore(),
      new InMemoryKeyStore(),
      {
        sealState: true,
      }
    );
    const err = refusal(boot({ eventStore: events, snapshotStore: snaps, effectRuntime: effects }));
    expect(err.name).toBe("PlaintextCheckpointError");
    expect(err.reason).toBe("keys-not-shared");
  });

  it("a forged sealsWholeState boolean on a plaintext store does not pass (keys identity is kept)", () => {
    const { events, effects } = stores();
    const forged = Object.assign(new InMemoryAsyncSnapshotStore(), { sealsWholeState: true });
    const err = refusal(
      boot({ eventStore: events, snapshotStore: forged, effectRuntime: effects })
    );
    expect(err.name).toBe("PlaintextCheckpointError");
    expect(err.reason).toBe("keys-not-shared");
  });

  it("boots with sealState + the shared KeyStore, and a suspend checkpoints (sealed at rest)", async () => {
    const { keys, events } = sealed();
    const raw = new InMemoryAsyncSnapshotStore();
    const snaps = new EncryptingSnapshotStore(raw, keys, { sealState: true });
    const h = build(
      { allowPlaintextCheckpoints: false },
      { eventStore: events, snapshotStore: snaps }
    );
    h.rt.registerFlow(f.definition, f.runner);
    const run = await h.rt.start(f, {}, { executionId: "ok-1" });
    await run.waitForSuspend();
    await until(async () => (await raw.loadLatest("ok-1")) !== null);
    expect(JSON.stringify((await raw.loadLatest("ok-1"))?.state)).not.toContain("variables");
    expect(h.storageErrors).toEqual([]);
  });

  it("allowPlaintextCheckpoints: true boots and checkpoints in plaintext (the migration escape)", async () => {
    const { events } = sealed();
    const raw = new InMemoryAsyncSnapshotStore();
    const h = build(
      { allowPlaintextCheckpoints: true },
      { eventStore: events, snapshotStore: raw }
    );
    h.rt.registerFlow(f.definition, f.runner);
    const run = await h.rt.start(f, {}, { executionId: "esc-1" });
    await run.waitForSuspend();
    await until(async () => (await raw.loadLatest("esc-1")) !== null);
    expect(h.storageErrors).toEqual([]);
  });

  it("a save-time breach (the store starts sealing AFTER construction) does not fail the run and writes nothing", async () => {
    const keys = new InMemoryKeyStore();
    const events = new EncryptingEventStore(new InMemoryAsyncEventStore(), keys, {
      sensitive: {},
      subjectOf: (e) => e.executionId,
    }); // seals nothing yet: boots with a plaintext snapshot store
    const raw = new InMemoryAsyncSnapshotStore();
    const h = build(
      { allowPlaintextCheckpoints: false },
      { eventStore: events, snapshotStore: raw }
    );
    h.rt.registerFlow(f.definition, f.runner);
    events.registerSensitive("INBOX_MESSAGE", ["payload"]); // the capability is live
    const run = await h.rt.start(f, {}, { executionId: "late-1" });
    await run.waitForSuspend(); // the run itself is unaffected
    await until(() => h.storageErrors.length > 0);
    expect((h.storageErrors[0] as Error).name).toBe("PlaintextCheckpointError");
    expect(await raw.loadLatest("late-1")).toBeNull();
    // and it finishes: the checkpoint skip cost nothing but a longer replay
    await h.rt.send("late-1", { topic: "y", payload: { ssn: SECRET }, messageId: "m1" });
    await until(async () => (await h.rt.loadState("late-1"))?.suspendedOn?.on === "Go");
    const done = await h.rt.resume("late-1", { eventType: "Go", payload: null });
    await done.waitForCompletion();
    expect(await raw.loadLatest("late-1")).toBeNull();
  });

  it("a save-time breach is reported ONCE per execution, however many checkpoints are refused", async () => {
    const keys = new InMemoryKeyStore();
    const events = new EncryptingEventStore(new InMemoryAsyncEventStore(), keys, {
      sensitive: {},
      subjectOf: (e) => e.executionId,
    });
    const raw = new InMemoryAsyncSnapshotStore();
    const h = build(
      { allowPlaintextCheckpoints: false, snapshotEvery: 1 },
      { eventStore: events, snapshotStore: raw }
    );
    const many = flow("many", async (ctx) => {
      for (let i = 0; i < 6; i++) await ctx.run(echo, { i });
      await ctx.suspend({ on: "Go" });
      return null;
    });
    h.rt.registerFlow(many.definition, many.runner);
    events.registerSensitive("INBOX_MESSAGE", ["payload"]);
    const run = await h.rt.start(many, {}, { executionId: "rl-1" });
    await run.waitForSuspend();
    await h.rt.resume("rl-1", { eventType: "Go", payload: null }).then((r) => r.waitForCompletion());
    await until(() => h.storageErrors.length > 0);
    const refusals = h.storageErrors.filter((e) => (e as Error).name === "PlaintextCheckpointError");
    expect(refusals).toHaveLength(1);
    expect(await raw.loadLatest("rl-1")).toBeNull();
  });

  it("a fork whose seed checkpoint is refused at SAVE time still succeeds, seeds nothing, and reports it", async () => {
    const keys = new InMemoryKeyStore();
    const events = new EncryptingEventStore(new InMemoryAsyncEventStore(), keys, {
      sensitive: {},
      subjectOf: (e) => e.executionId,
    });
    const raw = new InMemoryAsyncSnapshotStore();
    const h = build(
      { allowPlaintextCheckpoints: false },
      { eventStore: events, snapshotStore: raw }
    );
    h.rt.registerFlow(f.definition, f.runner);
    const run = await h.rt.start(f, {}, { executionId: "fk-p" });
    await run.waitForSuspend();
    events.registerSensitive("INBOX_MESSAGE", ["payload"]); // now sealing: a plaintext seed is refused
    const tip = (await events.read("fk-p")).at(-1)!.sequence;
    const child = await h.rt.fork("fk-p", tip, { executionId: "fk-c" });
    expect(child.executionId).toBe("fk-c");
    expect(await raw.loadLatest("fk-c")).toBeNull();
    expect(
      h.storageErrors.some((e) => (e as Error).name === "PlaintextCheckpointError")
    ).toBe(true);
    // the child is a real execution: it folds from the copied log with no seed
    expect((await h.rt.loadState("fk-c"))?.status).toBe("suspended");
  });

  it("crash-resume: with the refusal in force the execution recovers from the LOG alone", async () => {
    const { keys, events } = sealed();
    const raw = new InMemoryAsyncSnapshotStore();
    const snaps = new EncryptingSnapshotStore(raw, keys, { sealState: true });
    const a = build(
      { allowPlaintextCheckpoints: false },
      { eventStore: events, snapshotStore: snaps }
    );
    a.rt.registerFlow(f.definition, f.runner);
    const run = await a.rt.start(f, {}, { executionId: "crash-1" });
    await run.waitForSuspend();
    // node A "dies"; wipe every checkpoint it wrote: only the log remains
    await (raw as { deleteExecution?: (id: string) => Promise<void> }).deleteExecution?.("crash-1");
    expect(await raw.loadLatest("crash-1")).toBeNull();
    const b = build(
      { allowPlaintextCheckpoints: false },
      { eventStore: events, snapshotStore: snaps }
    );
    b.rt.registerFlow(f.definition, f.runner);
    await b.rt.send("crash-1", { topic: "y", payload: { ssn: SECRET }, messageId: "m1" });
    await until(async () => (await b.rt.loadState("crash-1"))?.suspendedOn?.on === "Go");
    const done = await b.rt.resume("crash-1", { eventType: "Go", payload: null });
    await expect(done.waitForCompletion()).resolves.toBeDefined();
  });

  it("a runtime whose event store seals nothing is unaffected (golden), and so is one without the capability", async () => {
    const raw = new InMemoryAsyncSnapshotStore();
    const h = build({}, { snapshotStore: raw }); // plain in-memory event store: no sealingCapability
    h.rt.registerFlow(f.definition, f.runner);
    const run = await h.rt.start(f, {}, { executionId: "plain-1" });
    await run.waitForSuspend();
    await until(async () => (await raw.loadLatest("plain-1")) !== null);
    expect(h.storageErrors).toEqual([]);
  });
});

describe("the archive snapshot store follows the same rule (LogLifecycle)", () => {
  it("an archive snapshot store that is not whole-state sealing is 'unsafe-archive' even on the same keys", async () => {
    const { keys, events } = sealed();
    const snaps = new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), keys, {
      sealState: true,
    });
    const h = build(
      { allowPlaintextCheckpoints: false },
      { eventStore: events, snapshotStore: snaps }
    );
    h.rt.registerFlow(done.definition, done.runner);
    const run = await h.rt.start(done, {}, { executionId: "arc-1" });
    await run.waitForCompletion();
    const archiveEvents = new EncryptingEventStore(new InMemoryAsyncEventStore(), keys, {
      sensitive: { INBOX_MESSAGE: ["payload"] },
    });
    const staticSnaps = new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), keys, {
      sensitive: ["variables._input.ssn"],
    });
    const bad = new LogLifecycle(events, snaps, {
      archive: { eventStore: archiveEvents, snapshotStore: staticSnaps },
    });
    expect(await bad.evaluate("arc-1", { terminalTtlMs: 0 }, Date.now() + 1e9)).toBe(
      "unsafe-archive"
    );
    const good = new LogLifecycle(events, snaps, {
      archive: {
        eventStore: archiveEvents,
        snapshotStore: new EncryptingSnapshotStore(new InMemoryAsyncSnapshotStore(), keys, {
          sealState: true,
        }),
      },
    });
    expect(await good.evaluate("arc-1", { terminalTtlMs: 0 }, Date.now() + 1e9)).not.toBe(
      "unsafe-archive"
    );
  });
});
