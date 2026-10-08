import { flow$, handler$, step$ } from "@loom/core";
import type { AgentDefinition, EventEnvelope } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import type { EventStore } from "@loom/event-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { A2APeerClient, fetchAgentCard } from "./A2APeerClient";
import type { PeerAgentRegistrar } from "./A2APeerClient";
import { createA2AServer } from "./A2AServer";
import type { A2AServer } from "./A2AServer";

// ── Minimal in-memory stores (mirrors A2AServer.test.ts) ──────────────────────

class MemEventStore implements EventStore {
  private readonly events = new Map<string, EventEnvelope[]>();
  async append(e: EventEnvelope): Promise<void> {
    const list = this.events.get(e.executionId) ?? [];
    list.push(e);
    this.events.set(e.executionId, list);
  }
  async read(id: string): Promise<EventEnvelope[]> {
    return this.events.get(id) ?? [];
  }
  async readFrom(id: string, from: number): Promise<EventEnvelope[]> {
    return (await this.read(id)).filter((e) => e.sequence >= from);
  }
  async subscribe(): Promise<() => void> {
    return () => {};
  }
  async close(): Promise<void> {}
}

class MemSnapshotStore implements SnapshotStore {
  private readonly snaps = new Map<string, Snapshot[]>();
  async save(s: Snapshot): Promise<void> {
    const list = this.snaps.get(s.executionId) ?? [];
    list.push(s);
    this.snaps.set(s.executionId, list);
  }
  async loadLatest(id: string): Promise<Snapshot | null> {
    const list = this.snaps.get(id);
    return list && list.length > 0 ? (list[list.length - 1] ?? null) : null;
  }
  async loadAt(id: string, sequence: number): Promise<Snapshot | null> {
    const list = this.snaps.get(id);
    if (!list) return null;
    const c = list.filter((s) => s.sequence <= sequence);
    return c[c.length - 1] ?? null;
  }
  async loadLatestBefore(id: string, sequence: number): Promise<Snapshot | null> {
    return this.loadAt(id, sequence);
  }
  async close(): Promise<void> {}
}

const echoStep = step$({
  id: "echo",
  name: "Echo",
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ reply: z.string() }),
  handler: handler$(async (input: { prompt: string }) => ({ reply: `Echo: ${input.prompt}` })),
});

const echoRunner: FlowRunner<{ prompt: string }, { reply: string }> = async (ctx, input) =>
  ctx.run(echoStep, { prompt: input.prompt });

const echoFlow: RegisteredFlow = {
  definition: flow$({
    id: "echo-flow",
    name: "Echo Flow",
    version: "1.0.0",
    inputSchema: z.object({ prompt: z.string() }),
    outputSchema: z.object({ reply: z.string() }),
    steps: [echoStep],
  }),
  runner: echoRunner as FlowRunner<unknown, unknown>,
};

function makeRuntime(): WorkflowRuntime {
  const runtime = new WorkflowRuntime({
    eventStore: new MemEventStore(),
    snapshotStore: new MemSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });
  runtime.registerFlow(echoFlow.definition, echoFlow.runner);
  return runtime;
}

function makeCtx(): EffectContext {
  return {
    executionId: "exec-1",
    stepId: "step-1",
    workflowId: "wf-1",
    attempt: 1,
    emit: () => {},
  };
}

let server: A2AServer | undefined;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
});

async function startEchoServer(): Promise<A2AServer> {
  const s = createA2AServer(
    makeRuntime(),
    echoFlow,
    {
      name: "Echo Agent",
      version: "1.0.0",
      capabilities: { streaming: false },
      skills: [{ id: "echo", name: "Echo", description: "Echoes the prompt back" }],
    },
    { port: 0, insecure: true, warn: () => {} }
  );
  await s.start();
  return loopbackServer(s);
}

/**
 * Point `server.url` at the loopback ADDRESS instead of the name `localhost`. The name costs a
 * resolver round trip (getaddrinfo on libuv's 4-thread pool) for every new connection, and under
 * a loaded full-suite run that lookup stalls for seconds, which is what timed these tests out at
 * vitest's 5s. The server listens dual-stack, so 127.0.0.1 always reaches it. These tests
 * exercise the peer client, not name resolution.
 */
function loopbackServer(s: A2AServer): A2AServer {
  const url = s.url.replace("://localhost:", "://127.0.0.1:");
  return Object.defineProperty(s, "url", { value: url, configurable: true });
}

describe("A2APeerClient", () => {
  it("discovers a remote agent card", async () => {
    server = await startEchoServer();

    const card = await fetchAgentCard(server.url);
    expect(card.name).toBe("Echo Agent");
    expect(card.skills[0]?.name).toBe("Echo");
  });

  it("registers a remote peer as a callable a2a tool", async () => {
    server = await startEchoServer();
    const effectRuntime = new EffectRuntime();

    const peer = new A2APeerClient({ url: server.url, pollIntervalMs: 25 });
    const tool = await peer.registerInto(effectRuntime);

    expect(tool.id).toBe("echo-agent");
    expect(tool.kind).toBe("a2a");
    // Built from a REMOTE agent card: tool search must treat it as un-vouched (ADR 0125 D7).
    expect(tool.origin).toBe("remote");
    expect(tool.description).toContain("Echo");
    expect(effectRuntime.has("echo-agent")).toBe(true);
  });

  it("round-trips a call through the peer tool", async () => {
    server = await startEchoServer();
    const effectRuntime = new EffectRuntime();

    const peer = new A2APeerClient({ url: server.url, pollIntervalMs: 25 });
    const tool = await peer.registerInto(effectRuntime);

    const output = await effectRuntime.execute<{ prompt: string }, { content: string }>(
      tool.id,
      { prompt: "hello" },
      makeCtx()
    );

    expect(output.content).toContain("Echo: hello");
  });

  it("optionally registers the peer with an agent registry", async () => {
    server = await startEchoServer();
    const effectRuntime = new EffectRuntime();

    const registered: AgentDefinition[] = [];
    const registry: PeerAgentRegistrar = {
      register(definition) {
        registered.push(definition);
        return this;
      },
    };

    const peer = new A2APeerClient({ url: server.url, pollIntervalMs: 25 });
    await peer.registerInto(effectRuntime, registry);

    expect(registered).toHaveLength(1);
    expect(registered[0]?.id).toBe("echo-agent");
    expect(registered[0]?.tools[0]?.kind).toBe("a2a");
  });

  it("honors an explicit toolId override", async () => {
    server = await startEchoServer();
    const effectRuntime = new EffectRuntime();

    const peer = new A2APeerClient({ url: server.url, toolId: "remote-echo", pollIntervalMs: 25 });
    const tool = await peer.registerInto(effectRuntime);

    expect(tool.id).toBe("remote-echo");
    expect(effectRuntime.has("remote-echo")).toBe(true);
  });

  it("L30: two transient calls stamped as ONE execution mint distinct task ids (callKey), so neither collides", async () => {
    server = await startEchoServer();
    const effectRuntime = new EffectRuntime();
    const peer = new A2APeerClient({ url: server.url, pollIntervalMs: 25 });
    const tool = await peer.registerInto(effectRuntime);
    const as = { workflowId: "wf", executionId: "exec-collide" };
    const call = (prompt: string, callKey: string) =>
      effectRuntime.invokeTransient<{ prompt: string }, { content: string }>(
        tool.id,
        { prompt },
        { as: { ...as, callKey } }
      );
    const [a, b] = await Promise.all([call("first", "decide:p:0"), call("second", "decide:p:1")]);
    expect(a.content).toContain("Echo: first");
    expect(b.content).toContain("Echo: second");
  });
});
