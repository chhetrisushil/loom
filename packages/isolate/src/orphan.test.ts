import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// ── an untrusted child must not outlive its parent ───────────────────────────
//
// The runner used to have no `disconnect` handler: when the parent died or exited without
// close(), a tool holding the loop open (setInterval) ran forever with ppid 1.

const parentScript = path.join(__dirname, "__fixtures__", "orphan-parent.cjs");
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function runParent(
  mode: "wait" | "exit"
): Promise<{ parent: ChildProcess; runnerPid: number }> {
  const parent = spawn(process.execPath, [parentScript, mode], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const runnerPid = await new Promise<number>((resolve, reject) => {
    let buf = "";
    parent.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = /PID (\d+)/.exec(buf);
      if (m) resolve(Number(m[1]));
    });
    parent.once("exit", () => reject(new Error(`parent exited early: ${buf}`)));
    setTimeout(() => reject(new Error("no runner pid")), 15_000);
  }).catch((e: unknown) => {
    parent.kill("SIGKILL");
    throw e;
  });
  return { parent, runnerPid };
}

async function gone(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

describe("the runner child dies with its parent", () => {
  for (const mode of ["wait", "exit"] as const) {
    it(mode === "wait"
      ? "parent kill -9: the runner exits (no orphan with ppid 1)"
      : "parent process.exit(0) without close(): the runner exits", async () => {
      const { parent, runnerPid } = await runParent(mode);
      try {
        if (mode === "wait") {
          expect(alive(runnerPid)).toBe(true);
          parent.kill("SIGKILL");
        }
        expect(await gone(runnerPid, 5000)).toBe(true);
      } finally {
        // never leave an orphan, whatever happened above
        try {
          process.kill(runnerPid, "SIGKILL");
        } catch {}
        parent.kill("SIGKILL");
      }
    }, 30_000);
  }
});
