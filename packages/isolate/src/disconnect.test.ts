import { fork } from "node:child_process";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import type { EffectContext } from "@loom/effect-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IsolatedToolDisconnectedError, IsolatedToolEffect } from "./IsolatedToolEffect";

// ── an untrusted tool must not be able to crash the PARENT ───────────────────
//
// A callback-less `send()` on a closed IPC channel does not throw: it emits 'error' on the
// next tick, and with no listener that is an uncaught exception in the kernel process.

const fixture = (n: string) => path.join(__dirname, "__fixtures__", n);
const ctx = (): EffectContext => ({
  executionId: "e",
  stepId: "s",
  workflowId: "w",
  attempt: 1,
  emit: vi.fn(),
});
const open: IsolatedToolEffect[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const e of open.splice(0)) e.close();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});
const hungHost = async (): Promise<{ target: string; url: string }> => {
  const s = http.createServer(() => {}); // accepts, never answers
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  return { target: `127.0.0.1:${port}`, url: `http://127.0.0.1:${port}/` };
};

describe("a disconnecting tool cannot crash or wedge the parent", () => {
  it("disconnect mid-run (hung fetch in flight) fails the run with a typed error", async () => {
    const host = await hungHost();
    const effect = new IsolatedToolEffect({
      id: "dc",
      modulePath: fixture("disconnecting.cjs"),
      egress: [host.target],
      fetchTimeoutMs: 300,
    });
    open.push(effect);
    const err = await effect
      .execute({ mode: "fetch-then-disconnect", url: host.url }, ctx())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IsolatedToolDisconnectedError);
    // Outlive fetchTimeoutMs: the reply to the dead child must not blow up the process.
    await new Promise((r) => setTimeout(r, 500));
  });

  it("a child that disconnected but stayed alive is not reused by the next execute", async () => {
    const effect = new IsolatedToolEffect({
      id: "dc2",
      modulePath: fixture("disconnecting.cjs"),
      timeoutMs: 3000,
    });
    open.push(effect);
    await expect(effect.execute({ mode: "return-then-disconnect" }, ctx())).resolves.toEqual({
      ok: true,
    });
    await new Promise((r) => setTimeout(r, 200)); // the tool has disconnected by now
    // biome-ignore lint/suspicious/noExplicitAny: reading the private child under test
    const first = (effect as any).child;
    expect(first?.connected ?? false).toBe(false);
    await expect(effect.execute({ mode: "return-then-disconnect" }, ctx())).resolves.toEqual({
      ok: true,
    });
    // biome-ignore lint/suspicious/noExplicitAny: reading the private child under test
    expect((effect as any).child?.pid).not.toBe(first?.pid);
  });

  it("replying to a dead child is swallowed, not emitted as an 'error' event", async () => {
    const host = await hungHost();
    const effect = new IsolatedToolEffect({
      id: "dc3",
      modulePath: "/nonexistent.js",
      egress: [host.target],
      fetchTimeoutMs: 50,
    });
    const child = fork(fixture("idle.cjs"), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    const onError = vi.fn();
    child.on("error", onError);
    // biome-ignore lint/suspicious/noExplicitAny: reaching the private broker path under test
    await (effect as any).handleFetch(child, 0, host.url, undefined, ctx());
    await new Promise((r) => setTimeout(r, 50)); // 'error' would be emitted on the next tick
    expect(onError).not.toHaveBeenCalled();
  });
});
