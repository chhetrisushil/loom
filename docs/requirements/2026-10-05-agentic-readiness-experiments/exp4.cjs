const { ReplayVM } = require(`${process.cwd()}/packages/replay-vm`);
for (const n of [5000, 10000, 20000]) {
  const evs = [
    {
      id: "0",
      workflowId: "w",
      executionId: "e",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { input: {} },
    },
  ];
  for (let i = 1; i <= n; i++)
    evs.push({
      id: `${i}`,
      workflowId: "w",
      executionId: "e",
      eventType: "DECISION_RECORDED",
      sequence: i,
      timestamp: 1,
      payload: { decisionId: `d${i}`, choice: i },
    });
  const t = Date.now();
  new ReplayVM(evs, { executionId: "e", workflowId: "w", workflowVersion: "1" });
  console.log(n, "decisions fold ms", Date.now() - t);
}
for (const n of [5000, 10000, 20000]) {
  const evs = [
    {
      id: "0",
      workflowId: "w",
      executionId: "e",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { input: {} },
    },
  ];
  for (let i = 1; i <= n; i++)
    evs.push({
      id: `${i}`,
      workflowId: "w",
      executionId: "e",
      eventType: "STEP_COMPLETED",
      sequence: i,
      timestamp: 1,
      payload: { stepId: `s${i}`, output: i },
    });
  const t = Date.now();
  new ReplayVM(evs, { executionId: "e", workflowId: "w", workflowVersion: "1" });
  console.log(n, "step fold ms", Date.now() - t);
}
