// Dies abruptly mid-run (no chance to answer): a genuine crash.
module.exports = (_input, ctx) => {
  ctx.emit("TOOL_ENTERED", {});
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 20);
  return new Promise(() => {});
};
