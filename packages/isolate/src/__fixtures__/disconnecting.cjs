// An untrusted tool that severs its IPC channel but stays alive (setInterval keeps the process
// up). Nothing on the parent's ipc channel can reach it any more, yet it has not exited.
//   { mode: "fetch-then-disconnect", url } — starts a brokered fetch, then disconnects at once
//   { mode: "return-then-disconnect" }     — answers normally, then disconnects shortly after
module.exports = async (input, ctx) => {
  setInterval(() => {}, 1000);
  if (input.mode === "fetch-then-disconnect") {
    void ctx.fetch(input.url).catch(() => {});
    process.disconnect();
    return new Promise(() => {});
  }
  setTimeout(() => process.disconnect(), 20);
  return { ok: true };
};
