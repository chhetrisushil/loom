import type { WorkerRuntime } from "@loom/worker-runtime";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerServer } from "./createWorkerServer";
import { startWorkerServer } from "./startWorkerServer";

const worker = {} as WorkerRuntime;

describe("startWorkerServer (container entrypoint, R12 round 2)", () => {
  let server: WorkerServer | undefined;
  const saved = process.env.HOST;
  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (saved === undefined) {
      // biome-ignore lint/performance/noDelete: env var must be truly unset
      delete process.env.HOST;
    } else process.env.HOST = saved;
  });

  it("binds all interfaces by default (Cloud Run needs 0.0.0.0)", async () => {
    // biome-ignore lint/performance/noDelete: env var must be truly unset
    delete process.env.HOST;
    server = await startWorkerServer(worker, { port: 0 });
    const port = Number(new URL(server.url).port);
    // A non-loopback interface address only answers if the bind is 0.0.0.0.
    const { networkInterfaces } = await import("node:os");
    const ext = Object.values(networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (ext) {
      const res = await fetch(`http://${ext.address}:${port}/health`);
      expect(res.status).toBe(200);
    }
    // and the host override is passed through: loopback-only refuses the external address
    await server.stop();
    server = await startWorkerServer(worker, { port: 0, host: "127.0.0.1" });
    const port2 = Number(new URL(server.url).port);
    if (ext) {
      await expect(fetch(`http://${ext.address}:${port2}/health`)).rejects.toBeDefined();
    }
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
  });

  it("HOST env var is honoured", async () => {
    process.env.HOST = "127.0.0.1";
    server = await startWorkerServer(worker, { port: 0 });
    expect(server.url).toContain("127.0.0.1");
  });

  it("passes authorize through to the worker server", async () => {
    server = await startWorkerServer(worker, {
      port: 0,
      host: "127.0.0.1",
      authorize: () => false,
    });
    expect((await fetch(`${server.url}/health`)).status).toBe(200);
    expect((await fetch(`${server.url}/run`, { method: "POST", body: "{}" })).status).toBe(401);
  });
});
