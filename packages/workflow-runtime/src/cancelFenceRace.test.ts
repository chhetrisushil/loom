import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import type { EventStore } from "@loom/event-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { inboxBackends } from "./__tests__/r2Backends";
import { until } from "./__tests__/r2Harness";
import type { FlowRunner, RegisteredFlow } from "./types";

// `cancel` of a parked execution vs a wake that answers the park between cancel's fold and its fence.
// Before the fix cancel superseded the woken runner with an UNCONDITIONAL fence, then lost slot N+1
// (DuplicateSequenceError): nothing written, the execution left resumed with no driver. The same
// protocol now serves the direct route and the continued-chain route (`cancelForward`).

const io = {
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ ok: z.boolean() }),
};
const hang = step$({ id: "hang", name: "Hang", toolId: "hang", ...io });
type In = { n: number };
type Out = { ok: boolean };
type Flow = RegisteredFlow<In, Out>;
function makeFlow(id: string, runner: FlowRunner<In, Out>): Flow {
  const definition: FlowDefinition<In, Out> = {
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
/** Generation 0 parks on GO0 and rotates; generation 1 parks on GO, then runs the hanging step. */
const rotating = makeFlow("rotating", async (ctx, input) => {
  if (input.n === 0) {
    await ctx.suspend({ on: "GO0" });
    return ctx.continueAsNew({ n: 1 });
  }
  await ctx.suspend({ on: "GO" });
  return ctx.run(hang, { n: 1 });
});
const GO = { eventType: "GO", payload: {} };

type Hook = (id: string) => Promise<void>;

/** Wraps `h` so it runs at most once (a rival acts at one moment, not on every call). */
const fire = (h: Hook | undefined): Hook => {
  let fired = false;
  return async (id) => {
    if (fired || h === undefined) return;
    fired = true;
    await h(id);
  };
};

/** A view of `inner` whose fence acquires and reads first run `before*` (a rival acting at the worst moment). */
function interleaved(
  inner: EventStore,
  hooks: {
    onFence?: Hook;
    onAppend?: (e: EventEnvelope) => Promise<void>;
  }
): EventStore {
  const view = Object.create(inner) as EventStore;
  const onFence = fire(hooks.onFence);
  let appendFired = false;
  view.acquireFence = async (id) => {
    await onFence(id);
    return (inner.acquireFence as NonNullable<EventStore["acquireFence"]>)(id);
  };
  view.acquireFenceIf = async (id, expect) => {
    await onFence(id);
    return (inner.acquireFenceIf as NonNullable<EventStore["acquireFenceIf"]>)(id, expect);
  };
  if (hooks.onAppend !== undefined) {
    const append = inner.append.bind(inner);
    let runnerFence = Number.POSITIVE_INFINITY;
    view.append = async (e) => {
      if (e.eventType === "EXECUTION_RESUMED" && typeof e.metadata?.fence === "number") {
        runnerFence = e.metadata.fence; // the woken runner's token
      }
      // the cancel's own write carries a newer token than the wake's; the fenced-out
      // runner's own CANCELLED (first token) must pass untouched
      if (
        !appendFired &&
        e.eventType === "EXECUTION_CANCELLED" &&
        typeof e.metadata?.fence === "number" &&
        e.metadata.fence > runnerFence
      ) {
        appendFired = true;
        await hooks.onAppend?.(e);
      }
      return append(e);
    };
  }
  return view;
}

function node(
  store: EventStore,
  snapshotStore: ReturnType<ReturnType<typeof inboxBackends>[0]["make"]>["snapshotStore"],
  effects: EffectRuntime,
  flow: Flow
): WorkflowRuntime {
  const rt = new WorkflowRuntime({
    eventStore: store,
    snapshotStore,
    effectRuntime: effects,
    continueAsNewEnabled: true,
    onStorageError: () => {},
  });
  rt.registerFlow(flow.definition, flow.runner);
  return rt;
}

/** The woken runner is mid-step AND its writes are durable (its journal drains in the background). */
async function midStep(inFlight: Promise<void>, store: EventStore, id: string): Promise<void> {
  await inFlight;
  await until(async () => (await store.read(id)).some((e) => e.eventType === "STEP_STARTED"));
}

/** A tool that is in flight until aborted; `inFlight` resolves once it started, `aborted` once its signal fired. */
function hangingTool() {
  let started!: () => void;
  let abort!: () => void;
  const inFlight = new Promise<void>((r) => {
    started = r;
  });
  let signalled = false;
  const tool = new ToolEffect(
    (_in: unknown, ctx: EffectContext) =>
      new Promise((_, reject) => {
        started();
        ctx.signal?.addEventListener(
          "abort",
          () => {
            signalled = true;
            abort?.();
            reject(ctx.signal?.reason);
          },
          { once: true }
        );
      })
  );
  return { tool, inFlight, wasAborted: () => signalled };
}

const [memory, , postgres] = inboxBackends("cfr");
describe.each([memory, postgres])(
  "cancel of a parked execution races a wake ($name)",
  (backend) => {
    beforeAll(backend.setup);
    afterAll(backend.teardown);
    const d = backend.skip === true ? describe.skip : describe;
    let seq = 0;

    /** Node A starts and parks `id`; node B (never ran it, so NOT live there) is the cancelling node. */
    async function setup(
      flow: Flow,
      tool: ToolEffect,
      hooks: Parameters<typeof interleaved>[1] & { beforeFold?: Hook } = {},
      input: In = { n: 1 }
    ) {
      const id = `e${++seq}`;
      const { eventStore: inner, snapshotStore } = backend.make();
      const effects = new EffectRuntime();
      effects.register("hang", tool);
      const a = node(inner, snapshotStore, effects, flow);
      const b = node(interleaved(inner, hooks), snapshotStore, effects, flow);
      if (hooks.beforeFold !== undefined) {
        // The cancel's fold is the window: a wake lands right before it reads, after cancel's own
        // entry check found nothing live. (Not a store hook: some backends read earlier, on entry.)
        const once = fire(hooks.beforeFold);
        const b2 = b as unknown as { foldStateForCancel(id: string): Promise<unknown> };
        const fold = b2.foldStateForCancel.bind(b);
        b2.foldStateForCancel = async (eid) => {
          await once(eid);
          return fold(eid);
        };
      }
      const handle = await a.start(flow, input, { executionId: id });
      await handle.waitForSuspend();
      const kinds = async (of = id) => (await inner.read(of)).map((e) => e.eventType);
      const lastKind = async (of = id) => (await kinds(of)).at(-1);
      return { id, a, b, inner, kinds, lastKind };
    }
    /** Answer the park the way an inbox wake does: conditional fence, then a fenced resume on `rt`. */
    async function wake(rt: WorkflowRuntime, inner: EventStore, id: string, event = GO) {
      const parkSeq = (await rt.parkedAtSequence(id)) as number;
      const got = await (inner.acquireFenceIf as NonNullable<EventStore["acquireFenceIf"]>)(id, {
        fence: 0,
        parkSeq,
      });
      expect("stale" in got).toBe(false);
      return rt.resume(id, event, { fence: (got as { fence: number }).fence });
    }

    d("direct route", () => {
      it("a wake on the cancelling node between cancel's fold and its fence still ends cancelled", async () => {
        const { tool, inFlight } = hangingTool();
        const ref: { h?: Awaited<ReturnType<typeof setup>> } = {};
        ref.h = await setup(gated, tool, {
          onFence: async (id) => {
            const h = ref.h as NonNullable<typeof ref.h>;
            await wake(h.b, h.inner, id);
            await midStep(inFlight, h.inner, id);
          },
        });
        const h = ref.h;
        expect(await h.b.cancel(h.id, "erase")).toBe(true);

        // the live runner's CANCELLED write is a background drain: wait for it
        await until(async () => (await h.kinds()).includes("EXECUTION_CANCELLED"));
        expect(await h.kinds()).toContain("EXECUTION_RESUMED");
        expect((await h.b.loadState(h.id))?.status).toBe("cancelled");
      });

      it("a wake on ANOTHER node (its runner is not live here) is fenced out and the cancel lands at the tip", async () => {
        const { tool, inFlight } = hangingTool();
        const ref: { h?: Awaited<ReturnType<typeof setup>> } = {};
        ref.h = await setup(gated, tool, {
          onFence: async (id) => {
            const h = ref.h as NonNullable<typeof ref.h>;
            await wake(h.a, h.inner, id);
            await midStep(inFlight, h.inner, id);
          },
        });
        const h = ref.h;
        expect(await h.b.cancel(h.id, "erase")).toBe(true);

        const kinds = await h.kinds();
        expect(kinds).toContain("EXECUTION_RESUMED");
        expect(kinds.at(-1)).toBe("EXECUTION_CANCELLED");
        expect((await h.b.loadState(h.id))?.status).toBe("cancelled");
      });

      it("a wake that resumes AND completes the execution is reported accurately (false), not as an error", async () => {
        const quick = makeFlow("quick", async (ctx) => {
          await ctx.suspend({ on: "GO" });
          return { ok: true };
        });
        const ref: { h?: Awaited<ReturnType<typeof setup>> } = {};
        ref.h = await setup(quick, hangingTool().tool, {
          onFence: async (id) => {
            const h = ref.h as NonNullable<typeof ref.h>;
            await (await wake(h.b, h.inner, id)).waitForCompletion();
          },
        });
        const h = ref.h;
        expect(await h.b.cancel(h.id)).toBe(false);

        const kinds = await h.kinds();
        expect(kinds).toContain("EXECUTION_COMPLETED");
        expect(kinds).not.toContain("EXECUTION_CANCELLED");
      });

      it("a local runner fenced out by this cancel is aborted and the cancel still lands durably (a slipped late append)", async () => {
        // The wake lands during the cancel's FIRST read, so the cancel folds `running`, takes the plain
        // fence (fencing the local runner out) and re-reads the tail. A non-answering append from the
        // fenced runner then slips in at the cancel's slot (what a store without FOR SHARE on that
        // path can do), so the cancel loses the slot. The next round must NOT trust the dead runner.
        const { tool, inFlight, wasAborted } = hangingTool();
        const ref: { h?: Awaited<ReturnType<typeof setup>> } = {};
        ref.h = await setup(gated, tool, {
          beforeFold: async (id) => {
            const h = ref.h as NonNullable<typeof ref.h>;
            await wake(h.b, h.inner, id);
            await midStep(inFlight, h.inner, id);
          },
          onAppend: async (e) => {
            const h = ref.h as NonNullable<typeof ref.h>;
            await h.inner.append({
              ...e,
              id: `${e.id}-late`,
              eventType: "APP_NOTE",
              payload: {},
            });
          },
        });
        const h = ref.h;
        expect(await h.b.cancel(h.id, "erase")).toBe(true);

        await until(async () => (await h.b.loadState(h.id))?.status === "cancelled");
        expect(await h.kinds()).toContain("APP_NOTE");
        expect(await h.lastKind()).toBe("EXECUTION_CANCELLED");
        expect(wasAborted()).toBe(true); // M2: the fenced-out runner's in-flight effect was told to stop
      });

      it("regression guard: a retried cancel still repairs an execution stranded resumed with no driver", async () => {
        // Passes on main as well (a running owner is cancelled at its tip); it pins that this stays so.
        const h = await setup(gated, hangingTool().tool);
        const parkSeq = (await h.b.parkedAtSequence(h.id)) as number;
        const first = (await h.inner.read(h.id))[0];
        const wakeToken = await (h.inner.acquireFence as NonNullable<EventStore["acquireFence"]>)(
          h.id
        );
        await h.inner.append({
          id: `${h.id}-${parkSeq + 1}`,
          workflowId: first?.workflowId ?? "gated",
          executionId: h.id,
          eventType: "EXECUTION_RESUMED",
          sequence: parkSeq + 1,
          timestamp: Date.now(),
          payload: null,
          metadata: { fence: wakeToken },
        } as never);
        await (h.inner.acquireFence as NonNullable<EventStore["acquireFence"]>)(h.id); // a token taken and never used
        expect((await h.b.loadState(h.id))?.status).toBe("running");

        expect(await h.b.cancel(h.id, "retry")).toBe(true);

        expect(await h.lastKind()).toBe("EXECUTION_CANCELLED");
        expect(await h.b.cancel(h.id)).toBe(false); // now terminal: a further retry is a no-op
      });
    });

    d("continued-chain route (cancelForward)", () => {
      it("the chain head woken mid-cancel (cancel addressed to the rotated-out id) still ends cancelled", async () => {
        const { tool, inFlight } = hangingTool();
        const ref: { h?: Awaited<ReturnType<typeof setup>> } = {};
        ref.h = await setup(
          rotating,
          tool,
          {
            onFence: async () => {
              const h = ref.h as NonNullable<typeof ref.h>;
              await wake(h.a, h.inner, `${h.id}~1`);
              await midStep(inFlight, h.inner, `${h.id}~1`);
            },
          },
          { n: 0 }
        );
        const h = ref.h;
        // rotate: c -> c~1, which parks on GO
        await (await h.a.resume(h.id, { eventType: "GO0", payload: {} }))
          .waitForCompletion()
          .catch(() => {});
        await until(async () => (await h.b.loadState(`${h.id}~1`))?.status === "suspended");

        expect(await h.b.cancel(h.id, "erase")).toBe(true);

        const head = `${h.id}~1`;
        const kinds = await h.kinds(head);
        expect(kinds).toContain("EXECUTION_RESUMED");
        expect(kinds.at(-1)).toBe("EXECUTION_CANCELLED");
        expect((await h.b.loadState(head))?.status).toBe("cancelled");
      });
    });
  }
);
