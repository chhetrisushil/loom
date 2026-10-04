const L = `${process.cwd()}/packages/`;
const { WorkflowRuntime } = require(`${L}workflow-runtime`);
const { EffectRuntime, ToolEffect } = require(`${L}effect-runtime`);
const { InMemoryAsyncEventStore } = require(`${L}event-runtime`);
const { InMemoryAsyncSnapshotStore } = require(`${L}snapshot-runtime`);
const { z } = require(`${L}core/node_modules/zod`);
(async () => {
  const mk = () => {
    const er = new EffectRuntime([]);
    er.register(
      "slow",
      new ToolEffect(async (i) => {
        await new Promise((r) => setTimeout(r, 200));
        return i;
      })
    );
    return new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: er,
      onWarn: () => {},
    });
  };
  const def = (id) => ({
    _tag: "FlowDefinition",
    id,
    name: id,
    version: "1",
    inputSchema: z.any(),
    outputSchema: z.any(),
    steps: [],
  });
  // 1: signal while busy
  let rt = mk();
  rt.registerFlow(def("a"), async (ctx) => {
    await ctx.execute({ _tag: "TaskDefinition", kind: "tool", id: "s", toolId: "slow" }, 1);
    const m = await ctx.suspend({ on: "msg" });
    return m;
  });
  const h = await rt.start("a", {}, { executionId: "x1" });
  try {
    await rt.resume("x1", { eventType: "msg", payload: 1 });
    console.log("1: accepted");
  } catch (e) {
    console.log("1: signal-while-running ->", e.name, e.message.slice(0, 90));
  }
  await h.waitForSuspend();
  // 2: two parallel gates (two different signals) in Promise.all
  rt = mk();
  rt.registerFlow(def("b"), async (ctx) => {
    const [x, y] = await Promise.all([ctx.suspend({ on: "A" }), ctx.suspend({ on: "B" })]);
    return [x, y];
  });
  const h2 = await rt.start("b", {}, { executionId: "x2" });
  try {
    await h2.waitForSuspend();
    const st = h2.getState();
    console.log(
      "2: parked on",
      JSON.stringify(st.suspendedOn),
      "(first gate only; B never registered)"
    );
  } catch (e) {
    console.log("2 err", e.message);
  }
  // 3: parallel sibling zombie after suspend
  rt = mk();
  rt.registerFlow(def("c"), async (ctx) => {
    await Promise.all([
      ctx.suspend({ on: "A" }),
      ctx.execute({ _tag: "TaskDefinition", kind: "tool", id: "s2", toolId: "slow" }, 1),
    ]);
  });
  const h3 = await rt.start("c", {}, { executionId: "x3" });
  await h3.waitForSuspend();
  const before = Object.keys(h3.getState().frames).map(
    (k) => `${k}:${h3.getState().frames[k].status}`
  );
  await new Promise((r) => setTimeout(r, 400));
  const after = Object.keys(h3.getState().frames).map(
    (k) => `${k}:${h3.getState().frames[k].status}`
  );
  console.log("3: at suspend", before, "400ms later", after, "status", h3.getState().status);
})();
