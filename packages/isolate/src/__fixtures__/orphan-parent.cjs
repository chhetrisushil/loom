// A throwaway PARENT process for the orphan test. It starts an isolated tool that holds the loop
// open, prints the runner's pid once the tool is mid-run, then either waits to be kill -9'd
// ("wait") or exits without close() ("exit").
const path = require("node:path");
const { IsolatedToolEffect } = require(path.join(__dirname, "..", "..", "dist", "index.js"));
const mode = process.argv[2];
const effect = new IsolatedToolEffect({
  id: "orphan",
  modulePath: path.join(__dirname, "hang-interval.cjs"),
});
effect
  .execute(
    {},
    {
      executionId: "e",
      stepId: "s",
      workflowId: "w",
      attempt: 1,
      emit: () => {
        console.log(`PID ${effect.child.pid}`);
        if (mode === "exit") setTimeout(() => process.exit(0), 20);
      },
    }
  )
  .catch(() => {});
setInterval(() => {}, 1000);
