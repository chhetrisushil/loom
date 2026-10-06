import * as http from "node:http";
import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, GrantTable, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { handleRpc } from "./carrier";
import type { JsonRpcResponse } from "./protocol";

const io = { inputSchema: z.object({ n: z.number() }), outputSchema: z.object({ n: z.number() }) };
const gateStep = step$({ id: "act", name: "act", toolId: "act-tool", ...io });

const FLOW = "wire-flow";

function makeFlow(): RegisteredFlow {
  const runner: FlowRunner<unknown, unknown> = async (ctx, input) => {
    const typed = input as { n: number };
    await ctx.suspend({ on: "Approval" });
    await ctx.run(gateStep, typed);
    return { n: typed.n + 1 };
  };
  const definition: FlowDefinition = {
    _tag: "FlowDefinition",
    id: FLOW,
    name: FLOW,
    version: "1.0.0",
    ...io,
    steps: [gateStep],
  };
  return { definition, runner };
}

function boot(authorizer?: GrantTable) {
  const effects = new EffectRuntime([], authorizer ? { authorizer } : {});
  effects.register("act-tool", new ToolEffect(async (input: unknown) => input));
  const runtime = new WorkflowRuntime({
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
  });
  const flow = makeFlow();
  runtime.registerFlow(flow.definition, flow.runner);
  return { runtime, flow };
}

/**
 * A "shell-script-grade" client: it speaks ONLY JSON strings over HTTP — no
 * @loom types, no SDK. Exactly what the T2 acceptance criterion demands.
 */
function rawClient(url: string) {
  let nextId = 1;
  return async (method: string, params: unknown): Promise<unknown> => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params });
    const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(
        url,
        { method: "POST", headers: { "content-type": "application/json" } },
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () =>
            resolve({ status: r.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf-8") })
          );
        }
      );
      req.on("error", reject);
      req.end(body);
    });
    const parsed = JSON.parse(res.text) as { result?: unknown; error?: { message: string } };
    if (parsed.error) throw new Error(parsed.error.message);
    return parsed.result;
  };
}

function serve(runtime: WorkflowRuntime): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const request = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        const response: JsonRpcResponse = await handleRpc(runtime, request);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
      });
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/rpc`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("T2.4 — a non-TS client starts, suspends, resumes, and replays over JSON-RPC", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  it("drives an execution end to end; the fold is byte-identical to an in-process run", async () => {
    // In-process reference run.
    const ref = boot();
    const refHandle = await ref.runtime.start(ref.flow, { n: 1 }, { executionId: "same-id" });
    await refHandle.waitForSuspend();
    const refResumed = await ref.runtime.resume("same-id", { eventType: "Approval", payload: {} });
    await refResumed.waitForCompletion();
    const refState = await ref.runtime.loadState("same-id");

    // Wire run via the raw JSON client against a fresh runtime.
    const wire = boot();
    const server = await serve(wire.runtime);
    servers.push(server);
    const call = rawClient(server.url);

    const started = (await call("execution.start", {
      flowId: FLOW,
      input: { n: 1 },
      executionId: "same-id",
    })) as { status: string };
    expect(started.status).toBe("suspended");

    const resumed = (await call("execution.resume", {
      executionId: "same-id",
      event: { eventType: "Approval", payload: {} },
    })) as { status: string };
    expect(resumed.status).toBe("completed");

    const wireState = (await call("execution.getState", { executionId: "same-id" })) as {
      status: string;
      variables: Record<string, unknown>;
      frames: unknown;
    };

    // Byte-identical fold of the DETERMINISTIC content — status, output, and the
    // frame graph (status/attempts/input/output). Wall-clock timestamps are
    // per-run by nature (both clients stamp their own) and aren't part of the
    // deterministic fold identity, so we compare the timestamp-free projection.
    const frameShape = (frames: Record<string, Record<string, unknown>>) =>
      Object.fromEntries(
        Object.entries(frames).map(([k, f]) => [
          k,
          { status: f.status, attempts: f.attempts, input: f.input, output: f.output },
        ])
      );
    expect(wireState.status).toBe(refState?.status);
    expect(wireState.variables._output).toEqual(refState?.variables._output);
    expect(frameShape(wireState.frames as Record<string, Record<string, unknown>>)).toEqual(
      frameShape(refState?.frames as unknown as Record<string, Record<string, unknown>>)
    );
  });

  it("T2.2 — kernel rings run on the KERNEL side of the wire (a denied effect is refused)", async () => {
    // The flow's tool is NOT granted → K2 denies it kernel-side; the wire client
    // gains no bypass. The run fails after the gate, with EFFECT_DENIED logged.
    const wire = boot(new GrantTable({ [FLOW]: [] })); // grant nothing
    const server = await serve(wire.runtime);
    servers.push(server);
    const call = rawClient(server.url);

    await call("execution.start", { flowId: FLOW, input: { n: 1 }, executionId: "denied-1" });
    // Resume drives past the gate into the ungranted effect.
    await call("execution.resume", {
      executionId: "denied-1",
      event: { eventType: "Approval", payload: {} },
    }).catch(() => undefined);

    const state = (await call("execution.getState", { executionId: "denied-1" })) as {
      variables: { _denials?: unknown[] };
    };
    expect(state.variables._denials?.length).toBeGreaterThan(0);
  });

  it("rejects a ctx.* syscall — wire clients drive executions, not raw syscalls", async () => {
    const wire = boot();
    const server = await serve(wire.runtime);
    servers.push(server);
    const call = rawClient(server.url);
    await expect(call("ctx.emit", { eventType: "X", payload: {} })).rejects.toThrow(
      /kernel-internal/
    );
  });

  it("advertises the wire ABI (abi.describe)", async () => {
    const wire = boot();
    const server = await serve(wire.runtime);
    servers.push(server);
    const call = rawClient(server.url);
    const abi = (await call("abi.describe", {})) as { wireVersion: string; syscalls: unknown[] };
    expect(abi.wireVersion).toBe("1.0.0");
    expect(abi.syscalls.length).toBeGreaterThan(0);
  });
});

// R3 round 1 (P2-3) — the transport's authenticated principal reaches EVERY execution method.
describe("carrier principal under fail-closed execution authz", () => {
  it("start, resume, getState and cancel all carry the principal resolved by the transport", async () => {
    const { executionAccessPolicy } = await import("@loom/workflow-runtime");
    const effects = new EffectRuntime();
    effects.register("act-tool", new ToolEffect(async (input: unknown) => input));
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
      executionAuthorizer: executionAccessPolicy(),
      executionAuthz: { requirePrincipal: true },
    });
    const flow = makeFlow();
    runtime.registerFlow(flow.definition, flow.runner);
    const alice = { actor: "alice", tenant: "t1" };
    const opts = { resolvePrincipal: () => alice };
    let n = 0;
    const rpc = (method: string, params: unknown, o: object = opts) =>
      handleRpc(runtime, { jsonrpc: "2.0", id: ++n, method, params } as never, o);

    const started = await rpc("execution.start", {
      flowId: FLOW,
      input: { n: 1 },
      executionId: "w1",
    });
    expect(started.error).toBeUndefined();
    expect((await rpc("execution.getState", { executionId: "w1" })).error).toBeUndefined();
    const resumed = await rpc("execution.resume", {
      executionId: "w1",
      event: { eventType: "Approval", payload: {} },
    });
    expect(resumed.error).toBeUndefined();
    expect((await rpc("execution.cancel", { executionId: "w1" })).error).toBeUndefined();

    // no resolvePrincipal => anonymous on every method => refused
    for (const [m, p] of [
      ["execution.getState", { executionId: "w1" }],
      ["execution.resume", { executionId: "w1", event: { eventType: "Approval", payload: {} } }],
      ["execution.cancel", { executionId: "w1" }],
    ] as const) {
      expect((await rpc(m, p, {})).error).toBeDefined();
    }
  });
});

describe("ADR 0110 D3 — a wire resume carries its waitId through to the runtime", () => {
  it("execution.resume with a waitId answers THAT wait of a multi-wait park (the field is not dropped)", async () => {
    const effects = new EffectRuntime();
    const runtime = new WorkflowRuntime({
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
      inboxEnabled: true,
    });
    const definition = {
      _tag: "FlowDefinition",
      id: "sel",
      name: "sel",
      version: "1.0.0",
      ...io,
      steps: [],
    } as unknown as FlowDefinition;
    runtime.registerFlow(definition, async (ctx) => {
      const r = await ctx.select([{ gate: "G" }, { gate: "G" }]);
      return { arm: r.arm };
    });
    const started = await handleRpc(runtime, {
      jsonrpc: "2.0",
      id: 1,
      method: "execution.start",
      params: { flowId: "sel", input: { n: 1 }, executionId: "w1" },
    });
    expect((started as { error?: unknown }).error).toBeUndefined();
    const resumed = await handleRpc(runtime, {
      jsonrpc: "2.0",
      id: 2,
      method: "execution.resume",
      params: { executionId: "w1", event: { eventType: "G", waitId: "#1", payload: { ok: 1 } } },
    });
    expect((resumed as { error?: unknown }).error).toBeUndefined();
    const state = await runtime.loadState("w1", runtime.systemOptions());
    expect(state?.status).toBe("completed");
    expect(state?.variables._output).toEqual({ arm: 1 });
  });
});
