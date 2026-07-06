// Runs the durable Node server (tsx watch) and the Vite client together, with
// clean shutdown — a zero-dependency stand-in for `concurrently`.
import { spawn } from "node:child_process";

const procs = [
  spawn("tsx", ["watch", "src/server/main.ts"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  }),
  spawn("vite", [], { stdio: "inherit", shell: process.platform === "win32" }),
];

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) p.kill("SIGTERM");
  process.exit(code ?? 0);
}

for (const p of procs) {
  p.on("exit", (code) => shutdown(code ?? 0));
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
