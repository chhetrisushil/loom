import type { ExecutionPackage, WorkerLease } from "@loom/worker-runtime";
import { describe, expect, it, vi } from "vitest";
import { CloudRunWorkerRuntime } from "./CloudRunWorkerRuntime";
import { StaticCloudRunPlatform } from "./StaticCloudRunPlatform";

const ENDPOINT = "https://worker-abc.a.run.app/";
const pkg = { executionId: "x" } as unknown as ExecutionPackage;
const request = { executionId: "x" } as never;

function okFetch() {
  return vi.fn(async (_url: string, _init?: { headers?: Record<string, string> }) => ({
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ status: "completed" }),
  }));
}

async function run(runtime: CloudRunWorkerRuntime): Promise<void> {
  const lease: WorkerLease = await runtime.allocate(request);
  await runtime.execute(lease, pkg);
}

describe("CloudRunPlatform.identity", () => {
  it("sends a token for the service URL on the request, keeping the other headers", async () => {
    const fetchImpl = okFetch();
    const getIdentityToken = vi.fn(async (audience: string) => `token-for:${audience}`);
    await run(
      new CloudRunWorkerRuntime(
        new StaticCloudRunPlatform(ENDPOINT, { identity: { getIdentityToken } }),
        { fetchImpl }
      )
    );
    expect(getIdentityToken).toHaveBeenCalledWith("https://worker-abc.a.run.app");
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers;
    expect(headers?.authorization).toBe("Bearer token-for:https://worker-abc.a.run.app");
    expect(headers?.["content-type"]).toBe("application/json");
  });

  it("asks per request, so a provider can refresh an expiring token", async () => {
    const fetchImpl = okFetch();
    const getIdentityToken = vi.fn(async () => "t");
    await run(
      new CloudRunWorkerRuntime(
        new StaticCloudRunPlatform(ENDPOINT, { identity: { getIdentityToken } }),
        { fetchImpl }
      )
    );
    await run(
      new CloudRunWorkerRuntime(
        new StaticCloudRunPlatform(ENDPOINT, { identity: { getIdentityToken } }),
        { fetchImpl }
      )
    );
    expect(getIdentityToken).toHaveBeenCalledTimes(2);
  });

  it("a failing provider fails the dispatch, and nothing is sent without its token", async () => {
    const fetchImpl = okFetch();
    const failing = {
      getIdentityToken: async () => {
        throw new Error("metadata server down");
      },
    };
    await expect(
      run(
        new CloudRunWorkerRuntime(new StaticCloudRunPlatform(ENDPOINT, { identity: failing }), {
          fetchImpl,
        })
      )
    ).rejects.toThrow("metadata server down");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("without it, the request is unchanged and carries no credential", async () => {
    const fetchImpl = okFetch();
    await run(new CloudRunWorkerRuntime(new StaticCloudRunPlatform(ENDPOINT), { fetchImpl }));
    expect(fetchImpl.mock.calls[0]?.[1]?.headers?.authorization).toBeUndefined();
  });
});
