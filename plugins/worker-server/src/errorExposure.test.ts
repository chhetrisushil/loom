import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerServer } from "./createWorkerServer";
import type { WorkerServer } from "./createWorkerServer";

// The worker endpoint is reachable by anything that can dial it — and is UNAUTHENTICATED
// unless an authorizer is wired. Its 500s used to carry `err.message` verbatim.
const SECRET_DETAIL = 'relation "events" does not exist at /srv/secret/path.ts:41';

const exploding = {
  allocate: async () => {
    throw new Error(SECRET_DETAIL);
  },
  execute: async () => {
    throw new Error(SECRET_DETAIL);
  },
  release: async () => {},
};

describe("worker server — error exposure", () => {
  let server: WorkerServer;
  const seen: { errorId: string; err: unknown }[] = [];

  beforeAll(async () => {
    server = createWorkerServer(exploding as never, {
      onError: (errorId, err) => seen.push({ errorId, err }),
    });
    await server.start();
  });
  afterAll(() => server.stop());

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${server.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("never puts internal detail on the wire, but stays correlatable", async () => {
    const res = await post("/execute", { executionPackage: { executionId: "e", flowId: "f" } });
    expect(res.status).toBe(500);
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain("relation");
    expect(wire).not.toContain("/srv/secret");
    expect(res.body.error).toBe("internal error");
    expect(typeof res.body.errorId).toBe("string");

    // The operator still gets the real error, tied to what the caller was told.
    const logged = seen.find((s) => s.errorId === res.body.errorId);
    expect(logged).toBeDefined();
    expect((logged?.err as Error).message).toBe(SECRET_DETAIL);
  });

  it("still tells a caller what THEY got wrong", async () => {
    const bad = await post("/execute", "{not json");
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("request body is not valid JSON");
    // A client error is self-inflicted, so there is nothing to hide and nothing to log.
    expect(bad.body.errorId).toBeUndefined();

    const invalid = await post("/execute", { executionPackage: { flowId: "f" } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("invalid executionPackage");
  });
});
