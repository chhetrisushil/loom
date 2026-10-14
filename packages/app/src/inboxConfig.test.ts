import { unwrapTainted } from "@loom/classify";
import type { FlowDefinition } from "@loom/core";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig } from "./defineConfig";

// ADR 0110 (R2 review 3, P2-2) — `kernel.inbox.maxRetained` reaches the runtime beside `maxBacklog`.

const io = { inputSchema: z.any(), outputSchema: z.any() };
const definition: FlowDefinition<unknown, unknown> = {
  _tag: "FlowDefinition",
  id: "pinned",
  name: "pinned",
  version: "1.0.0",
  ...io,
  steps: [],
};

async function refusal(maxRetained: number | undefined): Promise<string | undefined> {
  const app = defineConfig({
    storage: { kind: "memory" },
    autostart: false,
    kernel: {
      features: { inbox: true },
      inbox: { maxBacklog: 2, ...(maxRetained !== undefined && { maxRetained }) },
    },
  });
  const runner: FlowRunner<unknown, unknown> = async (ctx) => {
    for (;;) unwrapTainted(await ctx.receive("hot"));
  };
  app.runtime.registerFlow(definition, runner);
  const h = await app.runtime.start({ definition, runner }, {}, { executionId: "x" });
  await h.waitForSuspend();
  await app.runtime.send("x", { topic: "cold", payload: "c", messageId: "c" });
  let msg: string | undefined;
  for (let i = 0; i < 40 && msg === undefined; i++) {
    try {
      await app.runtime.send("x", { topic: "hot", payload: i, messageId: `h${i}` });
    } catch (e) {
      msg = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  await app.close();
  return msg;
}

describe("kernel.inbox.maxRetained", () => {
  it("is honoured: a cold topic pins the stream and `send` refuses at the configured cap", async () => {
    expect(await refusal(6)).toMatch(/inboxMaxRetained/);
  });

  it("defaults to 4 x maxBacklog (8 here): the cap is the configured one, not a fixed number", async () => {
    // With 6 the refusal comes earlier than with the default; both name the retained cap.
    const tight = await refusal(3);
    const loose = await refusal(undefined);
    expect(tight).toMatch(/retains 3\+/);
    expect(loose).toMatch(/retains 8\+/);
  });
});

// ADR 0110 amendment, D10a — `kernel.inbox.messageTtlMs` reaches the runtime; unset leaves expiry off.
describe("kernel.inbox.messageTtlMs", () => {
  const mk = (messageTtlMs?: number | { default?: number; topics?: Record<string, number> }) =>
    defineConfig({
      storage: { kind: "memory" },
      autostart: false,
      kernel: {
        features: { inbox: true },
        ...(messageTtlMs !== undefined && { inbox: { messageTtlMs } }),
      },
    });

  it("is off by default and on when configured", async () => {
    const off = mk();
    expect(off.runtime.inboxTtlOn).toBe(false);
    expect(await off.runtime.expireInbox("nope")).toEqual({ status: "off", expired: 0 });
    await off.close();
    for (const ttl of [60_000, { topics: { cold: 120_000 } }]) {
      const on = mk(ttl);
      expect(on.runtime.inboxTtlOn).toBe(true);
      await on.close();
    }
  });

  it("refuses a TTL that is not an integer of at least the 60 s floor", () => {
    expect(() => mk(0)).toThrow(/messageTtlMs/);
    expect(() => mk({ topics: { a: -1 } })).toThrow(/messageTtlMs/);
    // Below the floor: a TTL near the fleet's clock skew could expire a fresh message.
    expect(() => mk(59_999)).toThrow(/at least 60000/);
    expect(() => mk({ default: 1_000 })).toThrow(/at least 60000/);
    expect(() => mk({ topics: { a: 5_000 } })).toThrow(/at least 60000/);
  });
});

// ADR 0110 amendment, D10b — `kernel.features.inboxTopicStreams` and `kernel.inbox.maxTopics` reach the runtime.
describe("kernel.features.inboxTopicStreams", () => {
  const mk = (topicStreams: boolean | undefined, maxTopics?: number) =>
    defineConfig({
      storage: { kind: "memory" },
      autostart: false,
      kernel: {
        features: {
          inbox: true,
          ...(topicStreams !== undefined && { inboxTopicStreams: topicStreams }),
        },
        ...(maxTopics !== undefined && { inbox: { maxTopics } }),
      },
    });
  const OPS = { actor: "ops", tenant: "t1" };

  it("is off by default: the switch is refused and the node writes the legacy stream", async () => {
    const app = mk(undefined);
    await expect(app.runtime.enableInboxTopicStreams({ principal: OPS })).rejects.toThrow(
      /inboxTopicStreams/
    );
    await app.close();
  });

  it("is honoured: the fleet switch can be written, once", async () => {
    const app = mk(true, 3);
    expect(await app.runtime.enableInboxTopicStreams({ principal: OPS })).toEqual({
      enabled: true,
      newlyEnabled: true,
    });
    await app.close();
  });

  it("refuses a topic cap that is not a positive integer", () => {
    expect(() => mk(true, 0)).toThrow(/inboxMaxTopics/);
  });
});

// ADR 0130 residuals D9 - `kernel.inbox.quarantineMax` / `autoRelease` reach the runtime.
describe("kernel.inbox.quarantineMax / autoRelease", () => {
  const mk = (inbox?: { quarantineMax?: number; autoRelease?: boolean }) =>
    defineConfig({
      storage: { kind: "memory" },
      autostart: false,
      kernel: { features: { inbox: true }, ...(inbox !== undefined && { inbox }) },
    });

  it("default to 256 held messages and auto-release ON", async () => {
    const app = mk();
    expect(app.runtime.inboxQuarantineLimit).toBe(256);
    expect(app.runtime.inboxAutoReleaseOn).toBe(true);
    await app.close();
  });

  it("are honoured when configured (the opt-out is node-local)", async () => {
    const app = mk({ quarantineMax: 1024, autoRelease: false });
    expect(app.runtime.inboxQuarantineLimit).toBe(1024);
    expect(app.runtime.inboxAutoReleaseOn).toBe(false);
    await app.close();
  });

  it("a quarantineMax above the fold's cap (1024) is refused at composition", () => {
    expect(() => mk({ quarantineMax: 1025 })).toThrow(/quarantineMax/);
    expect(() => mk({ quarantineMax: 0 })).toThrow(/quarantineMax/);
  });
});
