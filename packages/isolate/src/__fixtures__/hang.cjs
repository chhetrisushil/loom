// Never settles — the kill path (abort / timeoutMs) must reclaim it. It announces that it is
// running first, so a test can kill a tool that is provably mid-run rather than still booting.
module.exports = (_input, ctx) => {
  ctx.emit("TOOL_ENTERED", {});
  return new Promise(() => {});
};
