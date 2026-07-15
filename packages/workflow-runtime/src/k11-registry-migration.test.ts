import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { FlowCodeMismatchError, FlowMigrationCheckError, StateMigrationError } from "./types";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── K11.2 (version-aware registry, pinned resumption) + K11.3 (resumeAs) ──────

const inputSchema = z.object({ n: z.number() });
const outputSchema = z.object({ done: z.boolean() });
type In = { n: number };
type Out = { done: boolean };

const FLOW = "versioned-flow";

const collectV1 = step$({
  id: "collect",
  name: "Collect",
  toolId: "collect-tool",
  inputSchema,
  outputSchema,
});
const collectV2 = step$({
  id: "collect",
  name: "Collect",
  toolId: "collect-tool-v2",
  inputSchema,
  outputSchema,
});
const publishV2 = step$({
  id: "publish",
  name: "Publish",
  toolId: "publish-tool",
  inputSchema,
  outputSchema,
});

function gatedFlow(
  version: string,
  steps: Array<typeof collectV1>,
  marker: { ranOn?: string }
): RegisteredFlow<In, Out> {
  const runner: FlowRunner<In, Out> = async (ctx, input) => {
    for (const step of steps) {
      await ctx.run(step, input);
    }
    await ctx.suspend({ on: "Approval" });
    marker.ranOn = version;
    return { done: true };
  };
  const definition: FlowDefinition<In, Out> = {
    _tag: "FlowDefinition",
    id: FLOW,
    name: FLOW,
    version,
    inputSchema,
    outputSchema,
    steps,
  };
  return { definition, runner };
}

function bootRuntime() {
  const effects = new EffectRuntime();
  for (const id of ["collect-tool", "collect-tool-v2", "publish-tool"]) {
    effects.register(id, new ToolEffect(async () => ({ done: false })));
  }
  const eventStore = new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const runtime = new WorkflowRuntime({ eventStore, snapshotStore, effectRuntime: effects });
  return { runtime, eventStore, snapshotStore, effects };
}

function sharedRuntime(stores: {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
}) {
  const effects = new EffectRuntime();
  for (const id of ["collect-tool", "collect-tool-v2", "publish-tool"]) {
    effects.register(id, new ToolEffect(async () => ({ done: false })));
  }
  return new WorkflowRuntime({ ...stores, effectRuntime: effects });
}

describe("K11.2 — version-aware registry", () => {
  it("re-registering the same id+version+content is idempotent (dev watch-mode)", () => {
    const { runtime } = bootRuntime();
    const marker = {};
    const flow = gatedFlow("1.0.0", [collectV1], marker);
    runtime.registerFlow(flow.definition, flow.runner);
    expect(() => runtime.registerFlow(flow.definition, flow.runner)).not.toThrow();
  });

  it("re-registering the same id+version with DIFFERENT content is a hard error", () => {
    const { runtime } = bootRuntime();
    const v1 = gatedFlow("1.0.0", [collectV1], {});
    const v1changed = gatedFlow("1.0.0", [collectV2], {}); // same version, different structure
    runtime.registerFlow(v1.definition, v1.runner);
    expect(() => runtime.registerFlow(v1changed.definition, v1changed.runner)).toThrow(
      /bump the flow version/
    );
  });

  it("PINNED RESUMPTION: an in-flight execution resumes on the version it started under", async () => {
    // Started on v1…
    const a = bootRuntime();
    const markerV1 = {} as { ranOn?: string };
    const v1 = gatedFlow("1.0.0", [collectV1], markerV1);
    a.runtime.registerFlow(v1.definition, v1.runner);
    const handle = await a.runtime.start(v1, { n: 1 }, { executionId: "pin-1" });
    await handle.waitForSuspend();

    // …deploy registers BOTH versions (v2 last = current for new starts).
    const b = sharedRuntime(a);
    const markerB1 = {} as { ranOn?: string };
    const markerB2 = {} as { ranOn?: string };
    const v1again = gatedFlow("1.0.0", [collectV1], markerB1);
    const v2 = gatedFlow("2.0.0", [collectV2, publishV2], markerB2);
    b.registerFlow(v1again.definition, v1again.runner);
    b.registerFlow(v2.definition, v2.runner);

    const resumed = await b.resume("pin-1", { eventType: "Approval", payload: {} });
    const state = await resumed.waitForCompletion();
    expect(state.status).toBe("completed");
    expect(markerB1.ranOn).toBe("1.0.0"); // the PINNED v1 runner drove the resume
    expect(markerB2.ranOn).toBeUndefined();
  });

  it("without the pinned version registered, the mismatch still refuses loudly", async () => {
    const a = bootRuntime();
    const v1 = gatedFlow("1.0.0", [collectV1], {});
    a.runtime.registerFlow(v1.definition, v1.runner);
    const handle = await a.runtime.start(v1, { n: 1 }, { executionId: "pin-2" });
    await handle.waitForSuspend();

    const b = sharedRuntime(a);
    const v2 = gatedFlow("2.0.0", [collectV2], {});
    b.registerFlow(v2.definition, v2.runner);

    await expect(b.resume("pin-2", { eventType: "Approval", payload: {} })).rejects.toBeInstanceOf(
      FlowCodeMismatchError
    );
  });
});

describe("K11.3 — resumeAs migration verdicts", () => {
  async function suspendedOnV1() {
    const a = bootRuntime();
    const v1 = gatedFlow("1.0.0", [collectV1], {});
    a.runtime.registerFlow(v1.definition, v1.runner);
    const handle = await a.runtime.start(v1, { n: 1 }, { executionId: "mig-1" });
    await handle.waitForSuspend();
    return a;
  }

  it("replay-check migration succeeds when the new code is fold-compatible", async () => {
    const a = await suspendedOnV1();
    const b = sharedRuntime(a);
    const marker = {} as { ranOn?: string };
    // v2 keeps the recorded step "collect" (rebound tool is fine — outputs are
    // served from the log) and ADDS a step: fold-compatible.
    const v2 = gatedFlow("2.0.0", [collectV2, publishV2], marker);
    b.registerFlow(v2.definition, v2.runner);

    const handle = await b.resumeAs(
      "mig-1",
      FLOW,
      { eventType: "Approval", payload: {} },
      {
        strategy: "replay-check",
      }
    );
    const state = await handle.waitForCompletion();
    expect(state.status).toBe("completed");
    expect(marker.ranOn).toBe("2.0.0"); // the NEW code drove the resume

    // The migration is durable: audit entry + re-pointed hash.
    const after = await b.loadState("mig-1");
    const migrations = after?.variables._migrations as Array<{ strategy?: string }>;
    expect(migrations?.length).toBe(1);
    expect(migrations?.[0]?.strategy).toBe("replay-check");
    const events = await a.eventStore.read("mig-1");
    expect(events.some((e) => e.eventType === "EXECUTION_MIGRATED")).toBe(true);
  });

  it("replay-check REFUSES when a recorded step is orphaned by the new code", async () => {
    const a = await suspendedOnV1();
    const b = sharedRuntime(a);
    // v2 renamed the recorded step "collect" → its durable output is orphaned.
    const renamed = step$({
      id: "collect-renamed",
      name: "Collect",
      toolId: "collect-tool-v2",
      inputSchema,
      outputSchema,
    });
    const v2 = gatedFlow("2.0.0", [renamed], {});
    b.registerFlow(v2.definition, v2.runner);

    const err = await b
      .resumeAs("mig-1", FLOW, { eventType: "Approval", payload: {} }, { strategy: "replay-check" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowMigrationCheckError);
    expect((err as FlowMigrationCheckError).orphanedStepIds).toEqual(["collect"]);
  });

  it("operator-ack migrates without the check", async () => {
    const a = await suspendedOnV1();
    const b = sharedRuntime(a);
    const renamed = step$({
      id: "collect-renamed",
      name: "Collect",
      toolId: "collect-tool-v2",
      inputSchema,
      outputSchema,
    });
    // The renamed step re-runs live on resume (its old output is orphaned) —
    // exactly what the operator is acking.
    const marker = {} as { ranOn?: string };
    const v2 = gatedFlow("2.0.0", [renamed], marker);
    b.registerFlow(v2.definition, v2.runner);

    const handle = await b.resumeAs(
      "mig-1",
      FLOW,
      { eventType: "Approval", payload: {} },
      {
        strategy: "operator-ack",
      }
    );
    const state = await handle.waitForCompletion();
    expect(state.status).toBe("completed");
    expect(marker.ranOn).toBe("2.0.0");
  });

  it("the migration re-points the recorded hash to the NEW code (subsequent checks target it)", async () => {
    const a = await suspendedOnV1();
    const b = sharedRuntime(a);
    const v2 = gatedFlow("2.0.0", [collectV2, publishV2], {});
    b.registerFlow(v2.definition, v2.runner);

    const v1Hash = (await b.loadState("mig-1"))?.variables._flowHash;
    const handle = await b.resumeAs(
      "mig-1",
      FLOW,
      { eventType: "Approval", payload: {} },
      {
        strategy: "replay-check",
      }
    );
    await handle.waitForCompletion();

    // EXECUTION_MIGRATED folded `_flowHash` to v2's hash — the durable pointer
    // any later resume/recovery would be checked against.
    const after = await b.loadState("mig-1");
    expect(after?.variables._flowHash).toBeDefined();
    expect(after?.variables._flowHash).not.toBe(v1Hash);
    const migration = (after?.variables._migrations as Array<{ toHash?: string }>)[0];
    expect(after?.variables._flowHash).toBe(migration?.toHash);
  });

  it("dynamic ad-hoc task ids are the documented replay-check caveat (ack path works)", async () => {
    // A flow that ran an ad-hoc ctx.execute task (id not in definition.steps)
    // has frames the check can't attribute — operator-ack is the escape.
    const a = bootRuntime();
    const adhocRunner: FlowRunner<In, Out> = async (ctx, input) => {
      await ctx.execute(
        { _tag: "TaskDefinition", kind: "tool", id: "adhoc-probe", toolId: "collect-tool" },
        input
      );
      await ctx.suspend({ on: "Approval" });
      return { done: true };
    };
    const definition: FlowDefinition<In, Out> = {
      _tag: "FlowDefinition",
      id: FLOW,
      name: FLOW,
      version: "1.0.0",
      inputSchema,
      outputSchema,
      steps: [collectV1],
    };
    a.runtime.registerFlow(definition, adhocRunner);
    const handle = await a.runtime.start(
      { definition, runner: adhocRunner },
      { n: 1 },
      { executionId: "mig-2" }
    );
    await handle.waitForSuspend();

    const b = sharedRuntime(a);
    b.registerFlow(definition, adhocRunner);
    await expect(
      b.resumeAs(
        "mig-2",
        FLOW,
        { eventType: "Approval", payload: {} },
        {
          strategy: "replay-check",
        }
      )
    ).rejects.toBeInstanceOf(FlowMigrationCheckError); // "adhoc-probe" not in steps

    const acked = await b.resumeAs(
      "mig-2",
      FLOW,
      { eventType: "Approval", payload: {} },
      {
        strategy: "operator-ack",
      }
    );
    const state = await acked.waitForCompletion();
    expect(state.status).toBe("completed");
  });
});

describe("K11.5 — contract-versioned state migration (ADR 0056)", () => {
  type NewIn = { count: number; unit: string };

  function capturingFlow(version: string, marker: { sawInput?: unknown }): RegisteredFlow<In, Out> {
    const runner: FlowRunner<In, Out> = async (ctx, input) => {
      await ctx.run(collectV2, input);
      await ctx.suspend({ on: "Approval" });
      marker.sawInput = input;
      return { done: true };
    };
    const definition: FlowDefinition<In, Out> = {
      _tag: "FlowDefinition",
      id: FLOW,
      name: FLOW,
      version,
      inputSchema,
      outputSchema,
      steps: [collectV2],
    };
    return { definition, runner };
  }

  async function suspendedOnV1() {
    const a = bootRuntime();
    const v1 = gatedFlow("1.0.0", [collectV1], {});
    a.runtime.registerFlow(v1.definition, v1.runner);
    const handle = await a.runtime.start(v1, { n: 7 }, { executionId: "sm-1" });
    await handle.waitForSuspend();
    return a;
  }

  const transform = (old: unknown): NewIn => ({ count: (old as In).n, unit: "items" });

  it("migrates the recorded input; the new runner sees the new contract; the fold is durable", async () => {
    const a = await suspendedOnV1();
    const b = sharedRuntime(a);
    const marker = {} as { sawInput?: unknown };
    const v2 = capturingFlow("2.0.0", marker);
    b.registerFlow(v2.definition, v2.runner);

    const handle = await b.resumeAs(
      "sm-1",
      FLOW,
      { eventType: "Approval", payload: {} },
      { strategy: "replay-check", transformState: transform }
    );
    const state = await handle.waitForCompletion();
    expect(state.status).toBe("completed");
    expect(marker.sawInput).toEqual({ count: 7, unit: "items" }); // new contract, live

    // Durable: the fold's _input IS the migrated value, audit says so.
    const after = await b.loadState("sm-1");
    expect(after?.variables._input).toEqual({ count: 7, unit: "items" });
    const migrations = after?.variables._migrations as Array<{ stateMigrated?: boolean }>;
    expect(migrations?.[0]?.stateMigrated).toBe(true);
  });

  it("a LATER plain resume() folds the migrated input (never the pre-migration payload)", async () => {
    // Hand-crafted history: started on the OLD contract, K11.5 migration fact
    // recorded, still parked on the gate (the migrating deploy crashed before
    // its own resume ran). A later plain resume() must fold `_input` — the
    // migrated value — not re-read the pre-migration EXECUTION_STARTED payload.
    const a = bootRuntime();
    const marker = {} as { sawInput?: unknown };
    const v2 = capturingFlow("2.0.0", marker);
    a.runtime.registerFlow(v2.definition, v2.runner);

    const history = [
      { eventType: "EXECUTION_STARTED", payload: { input: { n: 7 } } },
      {
        eventType: "EXECUTION_MIGRATED",
        payload: {
          toFlowId: FLOW,
          strategy: "operator-ack",
          migratedInput: { count: 7, unit: "items" },
        },
      },
      { eventType: "EXECUTION_SUSPENDED", payload: { condition: { on: "Approval" } } },
    ];
    for (const [sequence, e] of history.entries()) {
      await a.eventStore.append({
        id: `sm-2-${sequence}`,
        workflowId: FLOW,
        executionId: "sm-2",
        eventType: e.eventType,
        sequence,
        timestamp: 1_000 + sequence,
        payload: e.payload,
      });
    }

    const done = await a.runtime.resume("sm-2", { eventType: "Approval", payload: {} });
    const state = await done.waitForCompletion();
    expect(state.status).toBe("completed");
    expect(marker.sawInput).toEqual({ count: 7, unit: "items" }); // migrated input, folded
  });

  it("a throwing transform refuses with StateMigrationError and appends nothing", async () => {
    const a = await suspendedOnV1();
    const b = sharedRuntime(a);
    const v2 = capturingFlow("2.0.0", {});
    b.registerFlow(v2.definition, v2.runner);
    const before = (await a.eventStore.read("sm-1")).length;

    const err = await b
      .resumeAs(
        "sm-1",
        FLOW,
        { eventType: "Approval", payload: {} },
        {
          strategy: "replay-check",
          transformState: () => {
            throw new Error("zod: count required");
          },
        }
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StateMigrationError);
    expect((await a.eventStore.read("sm-1")).length).toBe(before); // untouched
  });

  it("without a transform, resumeAs is byte-identical to before (G2)", async () => {
    const a = await suspendedOnV1();
    const b = sharedRuntime(a);
    const marker = {} as { sawInput?: unknown };
    const v2 = capturingFlow("2.0.0", marker);
    b.registerFlow(v2.definition, v2.runner);
    const handle = await b.resumeAs(
      "sm-1",
      FLOW,
      { eventType: "Approval", payload: {} },
      { strategy: "replay-check" }
    );
    await handle.waitForCompletion();
    expect(marker.sawInput).toEqual({ n: 7 }); // original input, unchanged
    const after = await b.loadState("sm-1");
    const migrations = after?.variables._migrations as Array<{ stateMigrated?: boolean }>;
    expect(migrations?.[0]?.stateMigrated).toBeUndefined();
  });
});
