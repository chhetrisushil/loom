import { flow$, handler$, step$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import type { EventStore } from "@loom/event-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createA2AClientEffect } from "./A2AClientEffect";
import { createA2AServer } from "./A2AServer";
import type { A2AServer } from "./A2AServer";
import type { A2ATask, A2ATaskResult } from "./types";

// ── Minimal in-memory stores (self-contained for the test) ────────────────────

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

// ── A trivial echo flow ───────────────────────────────────────────────────────

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

// The server advertises a hostname URL ("localhost"), which can resolve to ::1 first under
// load while the server listens on IPv4; requests go to the literal loopback instead.
const loopback = (u: string): string => {
  const url = new URL(u);
  url.hostname = "127.0.0.1";
  return url.origin;
};

let server: A2AServer | undefined;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
});

describe("createA2AServer", () => {
  it("serves an agent card at /.well-known/agent.json", async () => {
    server = createA2AServer(
      makeRuntime(),
      echoFlow,
      {
        name: "Echo Agent",
        version: "1.0.0",
        capabilities: { streaming: false },
        skills: [{ id: "echo", name: "Echo" }],
      },
      { port: 0 }
    );
    await server.start();

    const resp = await fetch(`${loopback(server.url)}/.well-known/agent.json`);
    const card = (await resp.json()) as { name: string; url: string };
    expect(card.name).toBe("Echo Agent");
    expect(card.url).toBe(server.url);
  });

  it("completes a submitted task end-to-end", async () => {
    server = createA2AServer(
      makeRuntime(),
      echoFlow,
      { name: "Echo Agent", version: "1.0.0", capabilities: {}, skills: [] },
      { port: 0 }
    );
    await server.start();

    const task: A2ATask = {
      id: "t1",
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    };

    const sendResp = await fetch(`${loopback(server.url)}/tasks/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(task),
    });
    const { id } = (await sendResp.json()) as { id: string };
    expect(id).toBeTruthy();

    let result: A2ATaskResult | undefined;
    for (let i = 0; i < 20; i++) {
      const statusResp = await fetch(`${loopback(server.url)}/tasks/${id}`);
      result = (await statusResp.json()) as A2ATaskResult;
      if (result.status === "completed" || result.status === "failed") break;
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(result?.status).toBe("completed");
    const text = result?.artifacts?.[0]?.parts[0]?.text ?? "";
    expect(text).toContain("Echo: hello");
  });

  it("round-trips a task id containing '/' via the encoded GET route", async () => {
    server = createA2AServer(
      makeRuntime(),
      echoFlow,
      { name: "Echo Agent", version: "1.0.0", capabilities: {}, skills: [] },
      { port: 0 }
    );
    await server.start();

    const weirdId = "weird/id";
    const task: A2ATask = {
      id: weirdId,
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    };

    const sendResp = await fetch(`${loopback(server.url)}/tasks/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(task),
    });
    const { id } = (await sendResp.json()) as { id: string };
    expect(id).toBe(weirdId);

    let result: A2ATaskResult | undefined;
    for (let i = 0; i < 20; i++) {
      // A client must percent-encode the id before it becomes a path segment (see
      // `createA2AClientEffect`); the server's GET route decodes it back to `weirdId` before
      // looking the task up.
      const statusResp = await fetch(
        `${loopback(server.url)}/tasks/${encodeURIComponent(weirdId)}`
      );
      result = (await statusResp.json()) as A2ATaskResult;
      if (result.status === "completed" || result.status === "failed") break;
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(result?.status).toBe("completed");
    expect(result?.id).toBe(weirdId);
  });

  it("(c) round-trips a task id containing ':' through the real client, unencoded on the wire", async () => {
    // `:` is not one of the characters `createA2AClientEffect` escapes (see its
    // `encodeTaskIdSegment` — full `encodeURIComponent` would break wire compatibility with a
    // server that has not learned to decode). This proves the pair still works end to end: the
    // server never sees anything but the exact id it was given at submit time.
    server = createA2AServer(
      makeRuntime(),
      echoFlow,
      { name: "Echo Agent", version: "1.0.0", capabilities: {}, skills: [] },
      { port: 0 }
    );
    await server.start();

    const weirdId = "exec-1:step-1";
    const task: A2ATask = {
      id: weirdId,
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    };
    const ctx: EffectContext = {
      executionId: "e",
      workflowId: "w",
      stepId: "s",
      attempt: 1,
      emit: () => {},
    };

    const effect = createA2AClientEffect(loopback(server.url), { pollIntervalMs: 10 });
    const result = await effect.execute(task, ctx);

    expect(result.status).toBe("completed");
    expect(result.id).toBe(weirdId);
  });

  it("returns 404 for unknown tasks", async () => {
    server = createA2AServer(
      makeRuntime(),
      echoFlow,
      { name: "Echo Agent", version: "1.0.0", capabilities: {}, skills: [] },
      { port: 0 }
    );
    await server.start();

    const resp = await fetch(`${loopback(server.url)}/tasks/does-not-exist`);
    expect(resp.status).toBe(404);
  });
});
