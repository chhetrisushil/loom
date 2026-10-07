// R1b acceptance (ADR 0109): the message loop of `exp.cjs`, with and without continue-as-new.
//
//   node exp-r1b.cjs <turns> <rotateEvery>     (run from the repo root, after `pnpm build:fast`)
//
// `rotateEvery` 0 = no rotation (the baseline `exp.cjs` measures: per-turn cost and state grow
// with the turn number). `rotateEvery` n = `ctx.continueAsNew` every n turns: each generation's
// fold, snapshot and re-run cost are bounded by n, whatever the turn number. The driver resumes
// the CHAIN HEAD (the id of the newest generation), the way a client holding the executionId a
// `send` returned would.
const L = `${process.cwd()}/packages/`;
const { WorkflowRuntime } = require(`${L}workflow-runtime`);
const { EffectRuntime, ToolEffect } = require(`${L}effect-runtime`);
const { InMemoryAsyncEventStore } = require(`${L}event-runtime`);
const { InMemoryAsyncSnapshotStore } = require(`${L}snapshot-runtime`);
const { z } = require(`${L}core/node_modules/zod`);

(async () => {
  const N = +process.argv[2] || 1500;
  const every = +process.argv[3] || 0;
  const es = new InMemoryAsyncEventStore();
  const ss = new InMemoryAsyncSnapshotStore();
  const er = new EffectRuntime([]);
  er.register("work", new ToolEffect(async (i) => i));
  const rt = new WorkflowRuntime({
    eventStore: es,
    snapshotStore: ss,
    effectRuntime: er,
    snapshotEvery: 50,
    continueAsNewEnabled: every > 0,
    onWarn: () => {},
  });
  let runnerCalls = 0;
  const def = {
    _tag: "FlowDefinition",
    id: "agent",
    name: "agent",
    version: "1",
    inputSchema: z.any(),
    outputSchema: z.any(),
    steps: [],
  };
  rt.registerFlow(def, async (ctx) => {
    runnerCalls++;
    for (let i = 0; ; i++) {
      const m = await ctx.suspend({ on: "msg" });
      await ctx.execute(
        { _tag: "TaskDefinition", kind: "tool", id: `work#${i}`, toolId: "work" },
        m
      );
      // a flow counts its OWN turns (a pure function of its logged state)
      if (every > 0 && i + 1 >= every) return ctx.continueAsNew({});
    }
  });

  let head = "e1";
  let generation = 0;
  let h = await rt.start("agent", {}, { executionId: head });
  await h.waitForSuspend();
  const marks = [];
  let maxStateBytes = 0; // the live head's folded state, sampled every 100 turns
  const t00 = Date.now();
  for (let turn = 0; turn < N; turn++) {
    const t = process.hrtime.bigint();
    h = await rt.resume(head, { eventType: "msg", payload: { turn } });
    await Promise.race([h.waitForSuspend(), h.waitForCompletion()]);
    if (h.getState().status === "continued") {
      generation++;
      head = `e1~${generation}`;
      const live = rt.liveHandle(head);
      await live.waitForSuspend();
      h = live;
    }
    if (turn % 100 === 99) {
      maxStateBytes = Math.max(maxStateBytes, JSON.stringify(h.getState()).length);
    }
    if (turn % 1000 === 0 || turn === N - 1) {
      marks.push([turn, +(Number(process.hrtime.bigint() - t) / 1e6).toFixed(3)]);
    }
  }
  const total = Date.now() - t00;
  const st = await rt.loadState(head);
  const snap = await ss.loadLatest(head);
  console.log(`turns ${N}, rotateEvery ${every || "never"}, total ${total} ms`);
  console.log("per-resume ms at turn:", JSON.stringify(marks));
  console.log(
    "head",
    head,
    "| head frames",
    Object.keys(st.frames).length,
    "| head state JSON bytes",
    JSON.stringify(st).length,
    "| head snapshot bytes",
    snap ? JSON.stringify(snap.state).length : "-",
    "| max head state JSON bytes (sampled)",
    maxStateBytes,
    "| head log events",
    (await es.read(head)).length,
    "| generations",
    generation + 1
  );
  console.log("runner re-runs from top:", runnerCalls);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
