const L = `${process.cwd()}/packages/`;
const { WorkflowRuntime } = require(`${L}workflow-runtime`);
const { EffectRuntime, ToolEffect } = require(`${L}effect-runtime`);
const { InMemoryAsyncEventStore } = require(`${L}event-runtime`);
const { InMemoryAsyncSnapshotStore } = require(`${L}snapshot-runtime`);
const { z } = require(`${L}core/node_modules/zod`);
(async () => {
  const es = new InMemoryAsyncEventStore();
  const ss = new InMemoryAsyncSnapshotStore();
  const er = new EffectRuntime([]);
  er.register("work", new ToolEffect(async (i) => i));
  const rt = new WorkflowRuntime({
    eventStore: es,
    snapshotStore: ss,
    effectRuntime: er,
    snapshotEvery: 50,
    onWarn: () => {},
  });
  let runnerCalls = 0;
  const execs = 0;
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
    }
  });
  const h = await rt.start("agent", {}, { executionId: "e1" });
  await h.waitForSuspend();
  const N = +process.argv[2] || 1500;
  const t0 = Date.now();
  const marks = [];
  for (let i = 0; i < N; i++) {
    const t = process.hrtime.bigint();
    const hh = await rt.resume("e1", { eventType: "msg", payload: { i } });
    await hh.waitForSuspend();
    if (i % 250 === 0 || i === N - 1) marks.push([i, Number(process.hrtime.bigint() - t) / 1e6]);
  }
  console.log("per-resume ms at turn:", JSON.stringify(marks));
  const st = await rt.loadState("e1");
  console.log(
    "frames",
    Object.keys(st.frames).length,
    "resumePayloads",
    st.variables._resumePayloads.length,
    "stateJSON bytes",
    JSON.stringify(st).length,
    "events",
    (await es.read("e1")).length
  );
  console.log("runner re-runs from top:", runnerCalls);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
