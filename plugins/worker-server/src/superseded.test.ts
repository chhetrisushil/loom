import { LocalDispatcher } from "@loom/dispatcher";
import { RemoteWorkerRuntime } from "@loom/plugin-worker-remote";
import { isSupersededRefusal } from "@loom/worker-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerServer } from "./createWorkerServer";
import type { WorkerServer } from "./createWorkerServer";

// L20 across the wire — the server-side worker refuses because another holder owns the
// execution. That used to leave as an opaque 500, which the caller's retrying dispatcher
// could not tell from a crash, so it redispatched and the new fence superseded the winner.
function refusingWorker(err: () => Error) {
  const w = {
    executes: 0,
    allocate: async (r: { executionId: string }) => ({ leaseId: `l-${r.executionId}` }),
    execute: async () => {
      w.executes += 1;
      throw err();
    },
    release: async () => {},
  };
  return w;
}
const named = (name: string, fields: Record<string, unknown>) => {
  const e = Object.assign(new Error(name), fields);
  e.name = name;
  return e;
};
const pkg = { executionId: "e1", workflowId: "f", flowId: "f", input: {} };

describe("worker server — superseded refusals (L20)", () => {
  let server: WorkerServer | undefined;
  afterEach(() => server?.stop());

  it("answers 409 `superseded`; a remote dispatcher with retries does not redispatch", async () => {
    const internal: unknown[] = [];
    const worker = refusingWorker(() =>
      named("ExecutionAlreadyExistsError", { executionId: "e1" })
    );
    const superseded: string[] = [];
    server = createWorkerServer(worker as never, {
      onError: (_id, e) => internal.push(e),
      onSuperseded: (id) => superseded.push(id),
    });
    await server.start();

    const raw = await fetch(`${server.url}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionPackage: pkg }),
    });
    expect(raw.status).toBe(409);
    expect(await raw.json()).toEqual({
      error: "execution superseded",
      code: "superseded",
      executionId: "e1",
    });

    const dispatcher = new LocalDispatcher(new RemoteWorkerRuntime(server.url), { maxAttempts: 3 });
    const before = worker.executes;
    const err = await dispatcher.dispatch(pkg).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "ExecutionSupersededError", executionId: "e1" });
    expect(isSupersededRefusal(err, "e1")).toBe(true);
    expect(worker.executes - before).toBe(1); // no redispatch
    expect(internal).toEqual([]); // not an internal error…
    expect(superseded).toEqual(["e1", "e1"]); // …but operators still see it
  });

  it("a genuine failure stays an opaque 500 and IS retried", async () => {
    const worker = refusingWorker(() =>
      named("StorageWriteError", { cause: named("StaleFenceError", { executionId: "other" }) })
    );
    server = createWorkerServer(worker as never);
    await server.start();

    const dispatcher = new LocalDispatcher(new RemoteWorkerRuntime(server.url), { maxAttempts: 3 });
    await expect(dispatcher.dispatch(pkg)).rejects.toThrow(/500/);
    expect(worker.executes).toBe(3);
  });
});
