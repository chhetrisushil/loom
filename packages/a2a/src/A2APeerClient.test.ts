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
  append(e: EventEnvelope): void {
    const list = this.events.get(e.executionId) ?? [];
    list.push(e);
    this.events.set(e.executionId, list);
  }
  read(id: string): EventEnvelope[] {
    return this.events.get(id) ?? [];
  }
  readFrom(id: string, from: number): EventEnvelope[] {
    return this.read(id).filter((e) => e.sequence >= from);
  }
  subscribe(): () => void {
    return () => {};
  }
  nextSequence(id: string): number {
    const list = this.events.get(id);
    if (!list || list.length === 0) return 0;
    return (list[list.length - 1]?.sequence ?? -1) + 1;
  }
  close(): void {}
}

class MemSnapshotStore implements SnapshotStore {
  private readonly snaps = new Map<string, Snapshot[]>();
  save(s: Snapshot): void {
    const list = this.snaps.get(s.executionId) ?? [];
    list.push(s);
    this.snaps.set(s.executionId, list);
  }
  loadLatest(id: string): Snapshot | null {
    const list = this.snaps.get(id);
    return list && list.length > 0 ? (list[list.length - 1] ?? null) : null;
  }
  loadAt(id: string, sequence: number): Snapshot | null {
    const list = this.snaps.get(id);
    if (!list) return null;
    const c = list.filter((s) => s.sequence <= sequence);
    return c[c.length - 1] ?? null;
  }
  loadLatestBefore(id: string, sequence: number): Snapshot | null {
    return this.loadAt(id, sequence);
  }
  close(): void {}
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
    { port: 0 }
  );
  await s.start();
  return s;
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
});
