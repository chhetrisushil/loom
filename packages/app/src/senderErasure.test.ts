import { ERASURE_STREAM } from "@loom/compliance";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore, SenderErasedError } from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineConfig } from "./defineConfig";

// ADR 0139 N6 - a sealing deployment seals message senders BY DEFAULT, defineConfig wires the sender
// eraser into `eraseSubject`, and a deployment that opts out is told at boot.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const def: FlowDefinition<unknown, unknown> = {
  _tag: "FlowDefinition",
  id: "done",
  name: "done",
  version: "1.0.0",
  ...io,
  steps: [],
};
const flow = {
  definition: def,
  runner: (async () => ({ done: true })) as FlowRunner<unknown, unknown>,
} as RegisteredFlow;
const STREAM = "__loom_inbox__:other-chain";
const message = (seq: number, actor: string): EventEnvelope => ({
  id: `${STREAM}-${seq}`,
  workflowId: "__loom_inbox__",
  executionId: STREAM,
  eventType: "INBOX_MESSAGE",
  sequence: seq,
  timestamp: 1_000 + seq,
  payload: { topic: "t", messageId: `m${seq}`, payload: `body ${seq}`, sender: { actor } },
});

function boot(options: { senderSubjectOf?: false; onWarn?: (m: string) => void } = {}) {
  const raw = new InMemoryAsyncEventStore();
  const keys = new InMemoryKeyStore();
  const events = new EncryptingEventStore(raw, keys, {
    sensitive: {},
    ...(options.senderSubjectOf === false && { senderSubjectOf: false as const }),
  });
  const shred = vi.fn(async () => {});
  const app = defineConfig({
    storage: {
      kind: "custom",
      eventStore: events,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
    },
    flows: [flow],
    autostart: false,
    security: {
      strict: false,
      crypto: { events, allowPlaintextCheckpoints: true },
      compliance: {
        subjectOf: (e) =>
          e.eventType === "EXECUTION_STARTED"
            ? (e.payload as { input?: { userId?: string } }).input?.userId
            : undefined,
        erase: { shred },
      },
    },
    ...(options.onWarn !== undefined && { observability: { onWarn: options.onWarn } }),
  });
  return { app, raw, events, shred };
}

describe("sender sealing is the default and eraseSubject erases the subject as a sender (ADR 0139 N6)", () => {
  it("a default sealing deployment seals the sender; erasing the subject makes their identity unreadable in another chain's inbox", async () => {
    const { app, raw, events, shred } = boot();
    await (
      await app.runtime.start(flow, { userId: "alice" }, { executionId: "a1" })
    ).waitForCompletion();
    await events.append(message(1, "alice"));
    await events.append(message(2, "kim"));
    // sealed at rest under an opaque handle, readable through the app's store
    expect(JSON.stringify(await raw.read(STREAM))).not.toContain("alice");
    expect(((await events.read(STREAM))[0]?.payload as { sender: unknown }).sender).toEqual({
      actor: "alice",
    });

    const r = await app.eraseSubject("alice");
    expect(r.outcome).toBe("erased");
    expect(shred).toHaveBeenCalled();
    const [a, k] = await events.read(STREAM);
    expect((a?.payload as { sender: unknown }).sender).toMatchObject({ erased: true });
    expect(JSON.stringify(a)).not.toContain("alice");
    expect((k?.payload as { sender: unknown }).sender).toEqual({ actor: "kim" });
    // the message BODY (the owner's data) is untouched
    expect((a?.payload as { payload: unknown }).payload).toBe("body 1");
    await app.close();
  });

  it("opting out (senderSubjectOf: false) is allowed but warned about at boot", async () => {
    const warnings: string[] = [];
    const { app } = boot({ senderSubjectOf: false, onWarn: (m) => warnings.push(m) });
    expect(warnings.some((w) => /senderSubjectOf: false/.test(w))).toBe(true);
    await app.close();
    const quiet: string[] = [];
    const { app: ok } = boot({ onWarn: (m) => quiet.push(m) });
    expect(quiet.some((w) => /senderSubjectOf: false/.test(w))).toBe(false);
    await ok.close();
  });

  it("recoverArchiveRedactions is an operator verb (a clean archive restores nothing)", async () => {
    const { app } = boot();
    await expect(app.recoverArchiveRedactions()).resolves.toEqual([]);
    await app.close();
  });

  it("an erased sender stays blocked until app.reinstateSender, which is recorded and mints a NEW handle (ADR 0139 D22)", async () => {
    const { app, raw, events } = boot();
    await (
      await app.runtime.start(flow, { userId: "alice" }, { executionId: "a1" })
    ).waitForCompletion();
    await events.append(message(1, "alice"));
    const handleOf = async (i: number) =>
      (
        (await raw.read(STREAM))[i]?.payload as {
          sender: { subject: string };
        }
      ).sender.subject;
    const oldHandle = await handleOf(0);
    await app.eraseSubject("alice");
    await expect(events.append(message(2, "alice"))).rejects.toThrow(SenderErasedError);

    const r = await app.reinstateSender("alice", undefined, { by: "ops" });
    expect(r).toMatchObject({ reinstated: true, epoch: 1 });
    await events.append(message(2, "alice"));
    expect(await handleOf(1)).not.toBe(oldHandle);
    const [oldMsg, newMsg] = await events.read(STREAM);
    expect((oldMsg?.payload as { sender: unknown }).sender).toMatchObject({ erased: true });
    expect((newMsg?.payload as { sender: unknown }).sender).toEqual({ actor: "alice" });

    const journal = (await raw.read(ERASURE_STREAM)).filter((e) =>
      e.eventType.startsWith("SENDER_REINSTATE")
    );
    expect(journal.map((e) => e.eventType)).toEqual([
      "SENDER_REINSTATE_INTENDED",
      "SENDER_REINSTATED",
    ]);
    expect(JSON.stringify(journal)).not.toContain("alice");
    expect(journal[1]?.payload).toMatchObject({ by: "ops", reinstated: true });
    await app.close();
  });

  it("reinstateSender rejects without compliance.erase", async () => {
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      autostart: false,
    });
    await expect(app.reinstateSender("alice")).rejects.toThrow(/reinstateSender requires/);
    await app.close();
  });
});
