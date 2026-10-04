const { ReplayVM } = require(`${process.cwd()}/packages/replay-vm`);
for (const n of [5000, 20000, 40000]) {
  const vm = new ReplayVM([], { executionId: "e", workflowId: "w", workflowVersion: "1" });
  const t = Date.now();
  for (let i = 0; i < n; i++) {
    vm.applyEvent({
      id: `${i}`,
      workflowId: "w",
      executionId: "e",
      eventType: "STEP_COMPLETED",
      sequence: i,
      timestamp: 1,
      payload: { stepId: `s${i}`, output: i },
    });
  }
  console.log(n, "live applyEvent STEP_COMPLETED total ms", Date.now() - t);
}
