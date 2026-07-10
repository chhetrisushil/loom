import type { WorkerRuntime } from "@loom/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import { LocalDispatcher } from "./LocalDispatcher";

// K8.5 — the dispatcher's cancel() used to stop at lease bookkeeping; it now
// forwards the kill to the worker when the worker supports it.
describe("LocalDispatcher.cancel (K8.5)", () => {
  const base = {
    allocate: async (r: { executionId: string }) => ({ leaseId: `l-${r.executionId}` }),
    execute: async () => {
      throw new Error("unused");
    },
    release: async () => {},
  };

  it("forwards the kill to a cancel-capable worker", async () => {
    const cancel = vi.fn(async () => true);
    const worker: WorkerRuntime = { ...base, cancel };
    const dispatcher = new LocalDispatcher(worker);

    await dispatcher.cancel("e1");
    expect(cancel).toHaveBeenCalledWith("e1");
  });

  it("remains safe on a worker without cancel support", async () => {
    const worker: WorkerRuntime = { ...base };
    const dispatcher = new LocalDispatcher(worker);
    await expect(dispatcher.cancel("e1")).resolves.toBeUndefined();
  });
});
