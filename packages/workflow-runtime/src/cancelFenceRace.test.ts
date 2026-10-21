import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { type EventStore, InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// `cancel` of a parked execution vs a wake that answers the park between cancel's fold and its fence.
// Before the fix cancel superseded the woken runner with an UNCONDITIONAL fence, then lost slot N+1
// (DuplicateSequenceError): nothing written, the execution left resumed with nobody driving it.

const io = {
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ ok: z.boolean() }),
};
const hang = step$({ id: "hang", name: "Hang", toolId: "hang", ...io });
type R = FlowRunner<{ n: number }, { ok: boolean }>;
function makeFlow(id: string, runner: R): RegisteredFlow<{ n: number }, { ok: boolean }> {
  const definition: FlowDefinition<{ n: number }, { ok: boolean }> = {
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1.0.0",
    ...io,
    steps: [hang],
  };
  return { definition, runner };
}
const gated = makeFlow("gated", async (ctx) => {
  await ctx.suspend({ on: "GO" });
  return ctx.run(hang, { n: 1 });
});
const GO = { eventType: "GO", payload: {} };

/** The wake fires at the worst moment: when cancel first reaches for a fence, after it folded. */
function interleaved(
  inner: InMemoryAsyncEventStore,
  onFirstFence: () => Promise<void>
): EventStore {
  let fired = false;
  const strike = async (): Promise<void> => {
    if (fired) return;
    fired = true;
    await onFirstFence();
  };
  const view = Object.create(inner) as InMemoryAsyncEventStore;
  view.acquireFence = async (id) => {
    await strike();
    return inner.acquireFence(id);
  };
  view.acquireFenceIf = async (id, expect) => {
    await strike();
    return inner.acquireFenceIf(id, expect);
  };
  return view;
}

type Flow = RegisteredFlow<{ n: number }, { ok: boolean }>;

/** A runtime over `store`. The starting node and the cancelling node are two of these over one log. */
function node(store: EventStore, effects: EffectRuntime, flow: Flow): WorkflowRuntime {
  const rt = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    onStorageError: () => {},
  });
  rt.registerFlow(flow.definition, flow.runner);
  return rt;
}

/** Node A starts `flow` as "e1" and parks it. Node B (never ran it, so it is NOT live there) is returned. */
async function parked(
  flow: Flow,
  tool: ToolEffect,
  onFirstFence?: (b: WorkflowRuntime, inner: InMemoryAsyncEventStore) => Promise<void>
) {
  const inner = new InMemoryAsyncEventStore();
  const effects = new EffectRuntime();
  effects.register("hang", tool);
  const a = node(inner, effects, flow);
  const holder: { b?: WorkflowRuntime } = {};
  const b = node(
    onFirstFence === undefined
      ? inner
      : interleaved(inner, () => onFirstFence(holder.b as WorkflowRuntime, inner)),
    effects,
    flow
  );
  holder.b = b;
  const handle = await a.start(flow, { n: 1 }, { executionId: "e1" });
  await handle.waitForSuspend();
  const kinds = async () => (await inner.read("e1")).map((e) => e.eventType);
  return { a, b, inner, kinds };
}

/** Answer the park the way an inbox wake does: conditional fence, then a fenced resume. */
async function wake(rt: WorkflowRuntime, inner: InMemoryAsyncEventStore) {
  const parkSeq = (await rt.parkedAtSequence("e1")) as number;
  const got = await inner.acquireFenceIf("e1", { fence: 0, parkSeq });
  expect("stale" in got).toBe(false);
  return rt.resume("e1", GO, { fence: (got as { fence: number }).fence });
}

/** A tool that is in flight until aborted; `inFlight` resolves once it has started. */
function hangingTool() {
  let started!: () => void;
  const inFlight = new Promise<void>((r) => {
    started = r;
  });
  const tool = new ToolEffect(
    (_in: unknown, ctx: EffectContext) =>
      new Promise((_, reject) => {
        started();
        ctx.signal?.addEventListener("abort", () => reject(ctx.signal?.reason), { once: true });
      })
  );
  return { tool, inFlight };
}

describe("cancel of a parked execution races a wake", () => {
  it("a wake that resumes the execution between cancel's fold and its fence still ends cancelled", async () => {
    const { tool, inFlight } = hangingTool();
    const h = await parked(gated, tool, async (b, inner) => {
      await wake(b, inner);
      await inFlight; // the woken runner is live and mid-step when cancel proceeds
    });

    expect(await h.b.cancel("e1", "erase")).toBe(true);

    const kinds = await h.kinds();
    expect(kinds).toContain("EXECUTION_RESUMED");
    expect(kinds[kinds.length - 1]).toBe("EXECUTION_CANCELLED");
    expect((await h.b.loadState("e1"))?.status).toBe("cancelled");
  });

  it("a wake that resumes AND completes the execution is reported accurately (false), not as an error", async () => {
    const quick = makeFlow("quick", async (ctx) => {
      await ctx.suspend({ on: "GO" });
      return { ok: true };
    });
    const h = await parked(quick, hangingTool().tool, async (b, inner) => {
      await (await wake(b, inner)).waitForCompletion();
    });

    expect(await h.b.cancel("e1")).toBe(false);

    const kinds = await h.kinds();
    expect(kinds).toContain("EXECUTION_COMPLETED");
    expect(kinds).not.toContain("EXECUTION_CANCELLED");
  });

  it("a retried cancel repairs an execution already stranded resumed with no driver", async () => {
    const h = await parked(gated, hangingTool().tool);
    // The state the old race left: the park answered (RESUMED at N+1), a token taken after it, no runner.
    const parkSeq = (await h.b.parkedAtSequence("e1")) as number;
    const first = (await h.inner.read("e1"))[0];
    const wakeToken = await h.inner.acquireFence("e1");
    await h.inner.append({
      id: `e1-${parkSeq + 1}`,
      workflowId: first?.workflowId ?? "gated",
      executionId: "e1",
      eventType: "EXECUTION_RESUMED",
      sequence: parkSeq + 1,
      timestamp: new Date().toISOString(),
      payload: null,
      metadata: { fence: wakeToken },
    } as never);
    await h.inner.acquireFence("e1"); // cancel's superseding token, taken and never used
    expect((await h.b.loadState("e1"))?.status).toBe("running");

    expect(await h.b.cancel("e1", "retry")).toBe(true);

    const kinds = await h.kinds();
    expect(kinds[kinds.length - 1]).toBe("EXECUTION_CANCELLED");
    expect(await h.b.cancel("e1")).toBe(false); // now terminal: a further retry is a no-op
  });
});
