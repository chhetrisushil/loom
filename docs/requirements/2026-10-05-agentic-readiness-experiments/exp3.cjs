const L = `${process.cwd()}/packages/`;
const { WorkflowRuntime } = require(`${L}workflow-runtime`);
const { EffectRuntime, ToolEffect } = require(`${L}effect-runtime`);
const { InMemoryAsyncEventStore } = require(`${L}event-runtime`);
const { InMemoryAsyncSnapshotStore } = require(`${L}snapshot-runtime`);
const { z } = require(`${L}core/node_modules/zod`);
(async () => {
  const er = new EffectRuntime([]);
  let sideEffects = 0;
  er.register(
    "slow",
    new ToolEffect(async (i) => {
      await new Promise((r) => setTimeout(r, 200));
      sideEffects++;
      return i;
    })
  );
  const es = new InMemoryAsyncEventStore();
  const rt = new WorkflowRuntime({
    eventStore: es,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: er,
    onWarn: () => {},
  });
  rt.registerFlow(
    {
      _tag: "FlowDefinition",
      id: "c",
      name: "c",
      version: "1",
      inputSchema: z.any(),
      outputSchema: z.any(),
      steps: [],
    },
    async (ctx) => {
      await Promise.all([
        ctx.execute({ _tag: "TaskDefinition", kind: "tool", id: "s2", toolId: "slow" }, 1),
        (async () => {
          await new Promise((r) => setTimeout(r, 20));
          return ctx.suspend({ on: "A" });
        })(),
      ]);
    }
  );
  const h = await rt.start("c", {}, { executionId: "x3" });
  await h.waitForSuspend();
  const ev = async () => (await es.read("x3")).map((e) => e.eventType).join(",");
  console.log("at suspend:", await ev(), "status", h.getState().status);
  await new Promise((r) => setTimeout(r, 400));
  console.log(
    "400ms later:",
    await ev(),
    "status",
    h.getState().status,
    "sideEffects",
    sideEffects
  );
})();
