import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { EffectContext } from "@loom/effect-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createA2AClientEffect } from "./A2AClientEffect";

// A peer that answers `/tasks/send` with the FINISHED task — a synchronous agent, such as a
// thin shim whose send handler invokes a graph and returns its artifact (the shape the A2A mesh
// deck describes for LangGraph/CrewAI peers). The client used to read only `id` from that
// answer, sleep `pollIntervalMs`, and ask `/tasks/:id` for a result it already held (L18).

const ctx: EffectContext = {
  executionId: "e",
  workflowId: "w",
  stepId: "s",
  attempt: 1,
  emit: () => {},
};

interface Peer {
  url: string;
  requests: string[];
  close: () => Promise<void>;
}

let peer: Peer | undefined;
afterEach(async () => {
  await peer?.close();
  peer = undefined;
});

/** `sendBody` is what `/tasks/send` answers; `/tasks/:id` answers `pollBody`, or 404 when unset. */
async function startPeer(sendBody: unknown, pollBody?: unknown): Promise<Peer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      const body = req.url === "/tasks/send" ? sendBody : pollBody;
      if (body === undefined) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const task = {
  id: "t1",
  message: { role: "user" as const, parts: [{ type: "text" as const, text: "go" }] },
};

describe("createA2AClientEffect", () => {
  it("returns a terminal task from /tasks/send without polling for it", async () => {
    const done = {
      id: "t1",
      status: "completed",
      artifacts: [{ parts: [{ type: "text", text: "hi" }] }],
    };
    // No `/tasks/:id` route: a peer that does not keep finished tasks. `pollIntervalMs: 1`
    // (not a long interval) so that on old code — which polls anyway — the missing route's
    // 404 fails this test immediately with a clear assertion, rather than only after old
    // code's full poll sleep runs out vitest's 5s test timeout.
    peer = await startPeer(done);
    const effect = createA2AClientEffect(peer.url, { pollIntervalMs: 1 });

    await expect(effect.execute(task, ctx)).resolves.toEqual(done);
    expect(peer.requests).toEqual(["POST /tasks/send"]);
  });

  it("a failed task in the send answer is terminal too", async () => {
    const failed = { id: "t1", status: "failed", error: "boom" };
    peer = await startPeer(failed);
    const effect = createA2AClientEffect(peer.url, { pollIntervalMs: 1 });

    await expect(effect.execute(task, ctx)).resolves.toEqual(failed);
    expect(peer.requests).toEqual(["POST /tasks/send"]);
  });

  it("an id-only (status: working) send answer is still polled", async () => {
    const done = { id: "t1", status: "completed", artifacts: [] };
    peer = await startPeer({ id: "t1", status: "working" }, done);
    const effect = createA2AClientEffect(peer.url, { pollIntervalMs: 1 });

    await expect(effect.execute(task, ctx)).resolves.toEqual(done);
    expect(peer.requests).toEqual(["POST /tasks/send", "GET /tasks/t1"]);
  });

  it("a bare { id } send answer (loom's own server) is polled too", async () => {
    const done = { id: "t1", status: "completed", artifacts: [] };
    peer = await startPeer({ id: "t1" }, done);
    const effect = createA2AClientEffect(peer.url, { pollIntervalMs: 1 });

    await expect(effect.execute(task, ctx)).resolves.toEqual(done);
    expect(peer.requests).toEqual(["POST /tasks/send", "GET /tasks/t1"]);
  });

  it("encodes a peer-supplied task id before polling for it", async () => {
    // A peer's `id` goes straight into the poll URL. Unencoded, `../admin` would be collapsed
    // by URL dot-segment normalization into a request for a completely different route.
    const weirdId = "../admin";
    const done = { id: weirdId, status: "completed", artifacts: [] };
    peer = await startPeer({ id: weirdId }, done);
    const effect = createA2AClientEffect(peer.url, { pollIntervalMs: 1 });

    await expect(effect.execute(task, ctx)).resolves.toEqual(done);
    expect(peer.requests).toEqual([
      "POST /tasks/send",
      `GET /tasks/${encodeURIComponent(weirdId)}`,
    ]);
  });

  describe("a malformed send answer", () => {
    it("a non-object (string) answer throws a clear error, not a bare TypeError", async () => {
      peer = await startPeer("abc");
      const effect = createA2AClientEffect(peer.url, { pollIntervalMs: 1 });

      await expect(effect.execute(task, ctx)).rejects.toThrow("A2A send error: malformed answer");
    });

    it("a null answer throws a clear error", async () => {
      peer = await startPeer(null);
      const effect = createA2AClientEffect(peer.url, { pollIntervalMs: 1 });

      await expect(effect.execute(task, ctx)).rejects.toThrow("A2A send error: malformed answer");
    });

    it("a terminal answer with no id throws a clear error", async () => {
      peer = await startPeer({ status: "completed", artifacts: [] });
      const effect = createA2AClientEffect(peer.url, { pollIntervalMs: 1 });

      await expect(effect.execute(task, ctx)).rejects.toThrow("A2A send error: malformed answer");
    });
  });
});
