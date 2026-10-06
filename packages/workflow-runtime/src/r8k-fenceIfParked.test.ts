import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { type EventStore, InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import { ResumeContendedError, ResumeRefusedError } from "./types";
import type { FlowRunner, RegisteredFlow } from "./types";

// ADR 0118 D2 (R8k) — `RunOptions.fenceIfParkedAt`: answer a park under a CONDITIONAL fence.

const io = {
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ ok: z.boolean() }),
};
const echo = step$({ id: "echo", name: "Echo", toolId: "echo", ...io });
type R = FlowRunner<{ n: number }, { ok: boolean }>;
function makeFlow(id: string, runner: R): RegisteredFlow<{ n: number }, { ok: boolean }> {
  const definition: FlowDefinition<{ n: number }, { ok: boolean }> = {
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1.0.0",
    ...io,
    steps: [echo],
  };
  return { definition, runner };
}
const gate = makeFlow("gated", async (ctx) => {
  await ctx.suspend({ on: "GO" });
  return ctx.run(echo, { n: 1 });
});

/** A store view whose `acquireFenceIf` runs `before` first (a rival acting at the worst moment). */
function hooked(
  inner: InMemoryAsyncEventStore,
  before: (call: number) => Promise<void>,
  opts: { hideIf?: boolean } = {}
): EventStore {
  let calls = 0;
  const view = Object.create(inner) as InMemoryAsyncEventStore;
  if (opts.hideIf === true) {
    (view as { acquireFenceIf?: unknown }).acquireFenceIf = undefined;
    return view;
  }
  view.acquireFenceIf = async (id, expect) => {
    await before(++calls);
    return inner.acquireFenceIf(id, expect);
  };
  return view;
}

async function build(opts: {
  before?: (
    call: number,
    inner: InMemoryAsyncEventStore,
    rt: () => WorkflowRuntime
  ) => Promise<void>;
  hideIf?: boolean;
}) {
  const inner = new InMemoryAsyncEventStore();
  const effects = new EffectRuntime();
  effects.register("echo", new ToolEffect(async () => ({ ok: true })));
  const holder: { rt?: WorkflowRuntime } = {};
  const eventStore = hooked(
    inner,
    (c) => opts.before?.(c, inner, () => holder.rt as WorkflowRuntime) ?? Promise.resolve(),
    {
      ...(opts.hideIf !== undefined && { hideIf: opts.hideIf }),
    }
  );
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  holder.rt = runtime;
  runtime.registerFlow(gate.definition, gate.runner);
  const handle = await runtime.start(gate, { n: 1 }, { executionId: "e1" });
  await handle.waitForSuspend();
  const parkSeq = (await runtime.parkedAtSequence("e1")) as number;
  const kinds = async () => (await inner.read("e1")).map((e) => e.eventType);
  return { runtime, inner, parkSeq, kinds };
}

const GO = { eventType: "GO", payload: {} };

describe("R8k — resume with fenceIfParkedAt", () => {
  it("answers the park under the next token, and the run completes under it", async () => {
    const h = await build({});
    const handle = await h.runtime.resume("e1", GO, { fenceIfParkedAt: h.parkSeq });
    await handle.waitForCompletion();
    expect(await h.kinds()).toContain("EXECUTION_COMPLETED");
    // exactly one token was taken: the next unconditional acquire is the second
    expect(await h.inner.acquireFence("e1")).toBe(2);
  });

  it("a dead acquirer (acquire, never append) does not strand the park: the retry on the returned token wins", async () => {
    const h = await build({});
    await h.inner.acquireFence("e1"); // the dead supervisor: token 1, no append
    const handle = await h.runtime.resume("e1", GO, { fenceIfParkedAt: h.parkSeq });
    await handle.waitForCompletion();
    const resumes = (await h.kinds()).filter((k) => k === "EXECUTION_RESUMED");
    expect(resumes).toHaveLength(1);
    expect(await h.inner.acquireFence("e1")).toBe(3); // 1 dead, 2 ours
  });

  it("three consecutive dead acquirers surface ResumeContendedError (retryable), never not-suspended, and append nothing", async () => {
    const h = await build({ before: async (_c, inner) => void (await inner.acquireFence("e1")) });
    const before = await h.kinds();
    const err = await h.runtime
      .resume("e1", GO, { fenceIfParkedAt: h.parkSeq })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResumeContendedError);
    expect(err).not.toBeInstanceOf(ResumeRefusedError);
    expect((err as ResumeContendedError).retryable).toBe(true);
    expect((err as ResumeContendedError).attempts).toBe(3);
    expect(await h.kinds()).toEqual(before); // the park is still unanswered, log untouched
  });

  it("A's resume commits between B's re-read and B's acquire: B is refused not-suspended, A's body is never fenced out, one RESUMED", async () => {
    let aDone: Promise<unknown> | undefined;
    const h = await build({
      before: async (call, inner, rt) => {
        if (call !== 2) return; // B's retry: the dead acquirer moved the token, B re-read, now A strikes
        const parkSeq = (await rt().parkedAtSequence("e1")) as number;
        const a = await inner.acquireFenceIf("e1", { fence: 1, parkSeq });
        expect("stale" in a).toBe(false);
        const handle = await rt().resume("e1", GO, { fence: (a as { fence: number }).fence });
        aDone = handle.waitForCompletion();
        await aDone;
      },
    });
    await h.inner.acquireFence("e1"); // a dead acquirer first: token 1
    const err = await h.runtime
      .resume("e1", GO, { fenceIfParkedAt: h.parkSeq })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResumeRefusedError);
    expect((err as ResumeRefusedError).reason).toBe("not-suspended");
    // A's body ran to completion under ITS token: it was never fenced out.
    expect(await h.kinds()).toContain("EXECUTION_COMPLETED");
    expect((await h.kinds()).filter((k) => k === "EXECUTION_RESUMED")).toHaveLength(1);
  });

  it("an unfenced audit event / application event after the park does not make the acquire stale", async () => {
    const h = await build({});
    const tip = (await h.inner.head("e1")) as number;
    await h.inner.append({
      id: "e1-d",
      workflowId: "gated",
      executionId: "e1",
      eventType: "EXECUTION_DENIED",
      sequence: tip + 1,
      timestamp: 1,
      payload: { op: "query" },
    });
    await h.inner.append({
      id: "e1-app",
      workflowId: "gated",
      executionId: "e1",
      eventType: "SOME_APP_EMIT",
      sequence: tip + 2,
      timestamp: 2,
      payload: {},
    });
    const handle = await h.runtime.resume("e1", GO, { fenceIfParkedAt: h.parkSeq });
    await handle.waitForCompletion();
    expect(await h.kinds()).toContain("EXECUTION_COMPLETED");
  });

  it("an ignorable append BETWEEN the caller's fold and the acquire does not burn the token: the run executes from the advanced fold (P2-1)", async () => {
    const h = await build({
      before: async (call, inner) => {
        if (call !== 1) return;
        const tip = (await inner.head("e1")) as number;
        await inner.append({
          id: "e1-late-d",
          workflowId: "gated",
          executionId: "e1",
          eventType: "EXECUTION_DENIED",
          sequence: tip + 1,
          timestamp: 1,
          payload: { op: "query" },
        });
      },
    });
    const handle = await h.runtime.resume("e1", GO, { fenceIfParkedAt: h.parkSeq });
    await handle.waitForCompletion();
    expect(await h.kinds()).toContain("EXECUTION_COMPLETED");
    expect((await h.kinds()).filter((k) => k === "EXECUTION_RESUMED")).toHaveLength(1);
    expect(await h.inner.acquireFence("e1")).toBe(2); // one token, and it was USED
  });

  it("the same for resumeAs (P2-1)", async () => {
    const h = await build({
      before: async (call, inner) => {
        if (call !== 1) return;
        const tip = (await inner.head("e1")) as number;
        await inner.append({
          id: "e1-late-d2",
          workflowId: "gated",
          executionId: "e1",
          eventType: "EXECUTION_DENIED",
          sequence: tip + 1,
          timestamp: 1,
          payload: { op: "query" },
        });
      },
    });
    const handle = await h.runtime.resumeAs("e1", "gated", GO, {
      strategy: "operator-ack",
      fenceIfParkedAt: h.parkSeq,
    });
    await handle.waitForCompletion();
    expect(await h.kinds()).toContain("EXECUTION_COMPLETED");
  });

  it("LOG half of staleness: an answer lands past the park with the token UNCHANGED -> refused not-suspended, nothing appended by the loser (P3-9)", async () => {
    let aDone: Promise<unknown> | undefined;
    const h = await build({
      before: async (call, _inner, rt) => {
        if (call !== 1) return;
        const handle = await rt().resume("e1", GO); // unfenced answer: token stays 0
        aDone = handle.waitForCompletion();
        await aDone;
      },
    });
    const err = await h.runtime
      .resume("e1", GO, { fenceIfParkedAt: h.parkSeq })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResumeRefusedError);
    expect((err as ResumeRefusedError).reason).toBe("not-suspended");
    expect((await h.kinds()).filter((k) => k === "EXECUTION_RESUMED")).toHaveLength(1);
    expect(await h.kinds()).toContain("EXECUTION_COMPLETED");
  });

  it("an already-answered park is refused not-suspended, the log is untouched and NO token is taken", async () => {
    const h = await build({});
    await (await h.runtime.resume("e1", GO)).waitForCompletion();
    const before = await h.kinds();
    const err = await h.runtime
      .resume("e1", GO, { fenceIfParkedAt: h.parkSeq })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResumeRefusedError);
    expect((err as ResumeRefusedError).reason).toBe("not-suspended");
    expect(await h.kinds()).toEqual(before);
    expect(await h.inner.acquireFence("e1")).toBe(1); // nobody fenced the answered execution
  });

  it("a sequence that is not a park is refused not-suspended", async () => {
    const h = await build({});
    const err = await h.runtime
      .resume("e1", GO, { fenceIfParkedAt: 0 })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResumeRefusedError);
    expect((err as ResumeRefusedError).reason).toBe("not-suspended");
    expect(await h.inner.acquireFence("e1")).toBe(1);
  });

  it("a store without acquireFenceIf falls back to the unconditional acquire", async () => {
    const h = await build({ hideIf: true });
    const handle = await h.runtime.resume("e1", GO, { fenceIfParkedAt: h.parkSeq });
    await handle.waitForCompletion();
    expect(await h.kinds()).toContain("EXECUTION_COMPLETED");
    expect(await h.inner.acquireFence("e1")).toBe(2);
  });
});
