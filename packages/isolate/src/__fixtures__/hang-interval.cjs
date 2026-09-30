// Holds the event loop open (setInterval) and never settles: the shape of a tool that would
// outlive a dead parent. Announces itself so a test knows it is mid-run.
module.exports = (_input, ctx) => {
  setInterval(() => {}, 1000);
  ctx.emit("TOOL_ENTERED", {});
  return new Promise(() => {});
};
