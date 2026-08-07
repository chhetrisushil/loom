import type { EventEnvelope, ExecutionState, FlowDefinition } from "@loom/core";
import { handler$, step$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type FlowRunner, type RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ReplayInspector } from "./ReplayInspector";
import type { ProjectionSource, ReadOnlyEventStore } from "./types";

// ── A real execution, driven by the real runtime ──────────────────────────────
//
// The §7 fidelity criterion is "reconstruction at the final event equals the
// execution's LIVE state". Comparing against `foldEvents(log)` alone would only prove
// the inspector agrees with itself, so this drives an actual `WorkflowRuntime` and
// compares against `runtime.loadState` — the same path the kernel uses on resume.

const io = z.object({ n: z.number() });
type IO = { n: number };

const double = step$<IO, IO>({
  id: "double",
  name: "double",
  inputSchema: io,
  outputSchema: io,
  handler: handler$(async (input: IO) => ({ n: input.n * 2 })),
});

const addOne = step$<IO, IO>({
  id: "addOne",
  name: "addOne",
  inputSchema: io,
  outputSchema: io,
  handler: handler$(async (input: IO) => ({ n: input.n + 1 })),
});

const runner: FlowRunner<IO, IO> = async (ctx, input) => {
  const a = await ctx.execute(double, input);
  const b = await ctx.execute(addOne, a);
  return b;
};

const definition: FlowDefinition<IO, IO> = {
  _tag: "FlowDefinition",
  id: "ix-flow",
  name: "ix-flow",
  version: "2.1.0",
  inputSchema: io,
  outputSchema: io,
  steps: [double, addOne],
};

const flow = { definition, runner } as RegisteredFlow<IO, IO>;

function build() {
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime: new EffectRuntime(),
  });
  runtime.registerFlow(definition, runner);
  return { eventStore, snapshotStore, runtime };
}

describe("ReplayInspector — IX-2 fidelity against a live execution", () => {
  it("reconstruction at the final event equals the runtime's own state", async () => {
    const { eventStore, snapshotStore, runtime } = build();
    const handle = await runtime.start(flow, { n: 5 }, { executionId: "e-fidelity" });
    await handle.waitForCompletion();

    const live = (await runtime.loadState("e-fidelity")) as ExecutionState;
    const inspector = new ReplayInspector({ events: eventStore, snapshots: snapshotStore });
    const reconstructed = await inspector.stateAt("e-fidelity", live.sequence);

    // Everything the LOG determines matches exactly. Structural equality, not
    // reference: the fold copies on write, so a segment-wise reconstruction and a
    // one-shot fold agree by value and not by array identity.
    //
    // `workflowVersion` is deliberately EXCLUDED, and this is the one place the
    // original "bit-identical to live state" criterion is wrong. No event handler
    // writes that field; `WorkflowRuntime.foldState` seeds it from
    // `this.flows.get(workflowId).definition.version` — the CURRENTLY REGISTERED
    // flow (WorkflowRuntime.ts:857-861). Under skew that is the deployed version,
    // not the one the execution ran under. Matching it would make the inspector
    // report inferred-from-current data as though the log said so, which is exactly
    // the failure IX-5 exists to prevent. Reporting "not recorded" is correct.
    const { workflowVersion: _liveVersion, ...liveRest } = live;
    const { workflowVersion: reconstructedVersion, ...reconstructedRest } = reconstructed.state;
    expect(reconstructedRest).toEqual(liveRest);
    expect(reconstructedVersion).toBe("");
    expect(reconstructed.state.status).toBe("completed");
  });

  it("recovers workflowVersion when a snapshot carries it, and only then", async () => {
    const { eventStore, snapshotStore, runtime } = build();
    await (await runtime.start(flow, { n: 5 }, { executionId: "e-ver" })).waitForCompletion();
    const live = (await runtime.loadState("e-ver")) as ExecutionState;

    // A snapshot persists the whole ExecutionState, so it is the only durable carrier
    // of workflowVersion. With one available the inspector reports it; without one it
    // reports "not recorded" rather than inferring.
    await snapshotStore.save({
      id: "s",
      executionId: "e-ver",
      workflowId: "ix-flow",
      sequence: 0,
      state: { ...live, sequence: 0 },
      createdAt: 1,
    });
    const withSnap = new ReplayInspector({ events: eventStore, snapshots: snapshotStore });
    expect((await withSnap.stateAt("e-ver", live.sequence)).state.workflowVersion).toBe("2.1.0");

    const withoutSnap = new ReplayInspector({ events: eventStore });
    expect((await withoutSnap.stateAt("e-ver", live.sequence)).state.workflowVersion).toBe("");
  });

  it("IX-5 skew: the pin follows the log, while the kernel's version follows current code", async () => {
    const { eventStore, runtime } = build();
    await (await runtime.start(flow, { n: 1 }, { executionId: "e-skew" })).waitForCompletion();
    const inspector = new ReplayInspector({ events: eventStore });
    const pinnedBefore = await inspector.pinAt("e-skew", Number.MAX_SAFE_INTEGER);

    // Deploy "v3" of the same flow id — the skew condition for a long-lived execution.
    runtime.registerFlow({ ...definition, version: "3.0.0" }, runner);

    const liveAfter = (await runtime.loadState("e-skew")) as ExecutionState;
    const pinnedAfter = await inspector.pinAt("e-skew", Number.MAX_SAFE_INTEGER);

    // The kernel's projected version moved with the registration; the inspector's pin
    // did not, because it is folded from EXECUTION_STARTED.flowHash.
    expect(liveAfter.workflowVersion).toBe("3.0.0");
    expect(pinnedAfter).toEqual(pinnedBefore);
    expect(pinnedAfter.status).toBe("pinned");
    expect(pinnedAfter.flowHash).toBeDefined();
  });

  it("reconstructs every intermediate point consistently with a from-zero fold", async () => {
    const { eventStore, runtime } = build();
    await (await runtime.start(flow, { n: 2 }, { executionId: "e-mid" })).waitForCompletion();
    const log = await eventStore.read("e-mid");

    const inspector = new ReplayInspector({ events: eventStore });
    const timeline = await inspector.timeline(
      "e-mid",
      log.map((e: EventEnvelope) => e.sequence)
    );
    expect(timeline).toHaveLength(log.length);

    for (const point of timeline) {
      const one = await inspector.stateAt("e-mid", point.position);
      expect(point.state).toEqual(one.state);
    }
  });

  it("surfaces the pin the execution actually started under", async () => {
    const { eventStore, runtime } = build();
    const handle = await runtime.start(flow, { n: 1 }, { executionId: "e-pin" });
    await handle.waitForCompletion();
    const inspector = new ReplayInspector({ events: eventStore });
    const pin = await inspector.pinAt("e-pin", Number.MAX_SAFE_INTEGER);
    // K11 records a flowHash on EXECUTION_STARTED; either way the status is reported
    // honestly and never inferred from currently-registered code.
    expect(["pinned", "unpinned-legacy"]).toContain(pin.status);
    expect(pin.workflowId).toBe("ix-flow");
  });
});

describe("ReplayInspector — IX-1 read-only boundary", () => {
  it("never calls a mutating store method on any public path", async () => {
    const { eventStore, snapshotStore, runtime } = build();
    await (await runtime.start(flow, { n: 3 }, { executionId: "e-ro" })).waitForCompletion();

    const append = vi.spyOn(eventStore, "append");
    const save = vi.spyOn(snapshotStore, "save");
    const subscribe = vi.spyOn(eventStore, "subscribe");
    const acquireFence = vi.spyOn(eventStore, "acquireFence");
    const deleteExecution = vi.spyOn(snapshotStore, "deleteExecution");

    const inspector = new ReplayInspector({
      events: eventStore,
      snapshots: snapshotStore,
      projections: [{ id: "p", eventTypes: ["STEP_COMPLETED"], initialState: { c: 0 } }],
    });
    await inspector.stateAt("e-ro", 3);
    await inspector.timeline("e-ro", [0, 1, 2, 3]);
    await inspector.pinAt("e-ro", 3);
    await inspector.transitionAt("e-ro", 2);

    for (const spy of [append, save, subscribe, acquireFence, deleteExecution]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("the narrowed store type does not carry write methods (compile-time)", () => {
    const narrowed = {} as ReadOnlyEventStore;
    // @ts-expect-error — `append` is outside ReadOnlyEventStore by construction. If this
    // line stops erroring, the IX-1 boundary has been widened and the build must fail.
    void narrowed.append;
    // @ts-expect-error — `subscribe` is excluded deliberately: the inspector never tails.
    void narrowed.subscribe;
    expect(typeof narrowed).toBe("object");
  });

  it("works against a store exposing only the narrowed surface", async () => {
    const { eventStore, runtime } = build();
    await (await runtime.start(flow, { n: 4 }, { executionId: "e-narrow" })).waitForCompletion();
    const onlyReads: ReadOnlyEventStore = {
      read: (id) => eventStore.read(id),
      readFrom: (id, f) => eventStore.readFrom(id, f),
      readRange: (id, f, t) => eventStore.readRange(id, f, t),
    };
    const inspector = new ReplayInspector({ events: onlyReads });
    expect((await inspector.stateAt("e-narrow", 99)).state.status).toBe("completed");
  });
});

describe("ReplayInspector — IX-3 transition view", () => {
  it("shows the delta, the frames the event moved, and every projection", async () => {
    const { eventStore, runtime } = build();
    await (await runtime.start(flow, { n: 10 }, { executionId: "e-t" })).waitForCompletion();
    const log = await eventStore.read("e-t");
    const completed = log.find(
      (e: EventEnvelope) => e.eventType === "STEP_COMPLETED"
    ) as EventEnvelope;

    const projections: ProjectionSource[] = [
      {
        id: "steps",
        eventTypes: ["STEP_COMPLETED"],
        initialState: { done: 0 },
        load: async () => ({
          STEP_COMPLETED: (s: unknown) => ({ done: (s as { done: number }).done + 1 }),
        }),
      },
      {
        id: "never",
        eventTypes: ["NOT_A_REAL_KIND"],
        initialState: { done: 0 },
        load: async () => ({}),
      },
    ];

    const inspector = new ReplayInspector({ events: eventStore, projections });
    const t = await inspector.transitionAt("e-t", completed.sequence);

    expect(t.event?.sequence).toBe(completed.sequence);
    expect(t.delta.truncated).toBe(false);
    expect(t.delta.changes.length).toBeGreaterThan(0);
    expect(t.frames.map((f) => f.stepId)).toContain("double");
    expect(t.frames.every((f) => f.status === "completed")).toBe(true);

    // Absence and no-change are different facts — the unaffected projection is present.
    expect(t.projections).toHaveLength(2);
    expect(t.projections.find((p) => p.projectionId === "steps")?.status).toBe("ok");
    expect(t.projections.find((p) => p.projectionId === "never")?.status).toBe("unaffected");
  });

  it("reports no event and no frames for a sequence the log does not contain", async () => {
    const { eventStore, runtime } = build();
    await (await runtime.start(flow, { n: 1 }, { executionId: "e-gap" })).waitForCompletion();
    const inspector = new ReplayInspector({ events: eventStore });
    const t = await inspector.transitionAt("e-gap", 9_999);
    expect(t.event).toBeUndefined();
    expect(t.frames).toEqual([]);
    expect(t.delta.changes).toEqual([]);
  });
});

describe("ReplayInspector — redaction", () => {
  it("masks configured paths before returning state", async () => {
    const { eventStore, runtime } = build();
    await (await runtime.start(flow, { n: 7 }, { executionId: "e-red" })).waitForCompletion();
    const inspector = new ReplayInspector({
      events: eventStore,
      redactPaths: ["variables._input.n"],
    });
    const s = await inspector.stateAt("e-red", 99);
    expect((s.state.variables._input as { n: unknown }).n).toBe("[redacted]");
  });

  it("masks BEFORE diffing, so a redacted value cannot leak through a change record", async () => {
    const { eventStore, runtime } = build();
    await (await runtime.start(flow, { n: 7 }, { executionId: "e-red2" })).waitForCompletion();
    const log = await eventStore.read("e-red2");
    const started = log.find(
      (e: EventEnvelope) => e.eventType === "EXECUTION_STARTED"
    ) as EventEnvelope;

    const inspector = new ReplayInspector({
      events: eventStore,
      redactPaths: ["variables._input.n"],
    });
    const t = await inspector.transitionAt("e-red2", started.sequence);
    const leaked = JSON.stringify(t.delta.changes);
    expect(leaked).not.toContain('"n":7');
  });

  it("still reports the pin, which is a content hash and not user data", async () => {
    const { eventStore, runtime } = build();
    await (await runtime.start(flow, { n: 7 }, { executionId: "e-red3" })).waitForCompletion();
    const inspector = new ReplayInspector({
      events: eventStore,
      redactPaths: ["variables._flowHash", "variables._input"],
    });
    const s = await inspector.stateAt("e-red3", 99);
    expect(s.state.variables._flowHash).toBe("[redacted]");
    // Pin is read from the unredacted fold so the header still names what you're seeing.
    if (s.pin.status === "pinned") expect(s.pin.flowHash).not.toBe("[redacted]");
  });

  it("returns the identical state object when no redaction is configured", async () => {
    const { eventStore, runtime } = build();
    await (await runtime.start(flow, { n: 7 }, { executionId: "e-nored" })).waitForCompletion();
    const inspector = new ReplayInspector({ events: eventStore });
    const s = await inspector.stateAt("e-nored", 99);
    expect(s.state.variables._input).toEqual({ n: 7 });
  });
});

describe("ReplayInspector — retention", () => {
  it("holds nothing across calls: repeated inspection is allocation-stable", async () => {
    const { eventStore, runtime } = build();
    await (await runtime.start(flow, { n: 1 }, { executionId: "e-mem" })).waitForCompletion();
    const inspector = new ReplayInspector({
      events: eventStore,
      projections: [
        {
          id: "p",
          eventTypes: ["STEP_COMPLETED"],
          initialState: { c: 0 },
          load: async () => ({ STEP_COMPLETED: (s: unknown) => s }),
        },
      ],
    });
    // The instance carries config only — no memo, no cache, no listener. Enumerating
    // its own keys after heavy use is the cheap structural proxy for "nothing grew".
    const before = Object.keys(inspector).length;
    for (let i = 0; i < 50; i++) await inspector.transitionAt("e-mem", 2);
    expect(Object.keys(inspector).length).toBe(before);
  });
});
