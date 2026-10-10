import { step$ } from "@loom/core";
import { GrantTable, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import {
  type FlowRunner,
  type RegisteredFlow,
  executionAccessPolicy,
  signedResumeAuthenticator,
} from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig } from "./defineConfig";
import {
  PRINCIPAL_EVENT_PATHS,
  PRINCIPAL_STATE_PATHS,
  PrincipalRecordingRefusedError,
} from "./principalPolicy";
import { testPrincipalCodec } from "./principalTestSupport";

// ── R3k (ADR 0111 D1) — identity is never written verbatim under an erasure obligation ──────

const io = { inputSchema: z.object({}), outputSchema: z.object({}) };
const gate = step$({ id: "act", name: "act", toolId: "t", ...io });
const flow: RegisteredFlow = {
  definition: {
    _tag: "FlowDefinition",
    id: "f",
    name: "f",
    version: "1.0.0",
    ...io,
    steps: [gate],
  },
  runner: (async (ctx) => {
    await ctx.suspend({ on: "Go" });
    await ctx.run(gate, {});
    return {};
  }) as FlowRunner<unknown, unknown>,
} as RegisteredFlow;

const alice = { actor: "alice", tenant: "acme" };

const strictSecurity = {
  strict: true as const,
  authorizer: new GrantTable({ f: ["t"] }),
  executionAuthorizer: executionAccessPolicy(),
  resumeAuthenticator: signedResumeAuthenticator({ gates: ["Approval"], keys: {} }),
};

function registry() {
  const calls: Array<{ eventType?: string; paths: readonly string[] }> = [];
  return {
    calls,
    events: {
      registerSensitive: (eventType: string, paths: readonly string[]) =>
        void calls.push({ eventType, paths }),
    },
    snapshots: { registerSensitive: (paths: readonly string[]) => void calls.push({ paths }) },
  };
}

describe("security.strict / compliance: the identity subset is never written verbatim", () => {
  it("strict with neither crypto nor a principalCodec REFUSES to compose, naming the three ways out", () => {
    expect(() =>
      defineConfig({ storage: { kind: "memory" }, flows: [flow], security: strictSecurity })
    ).toThrow(PrincipalRecordingRefusedError);
    try {
      defineConfig({ storage: { kind: "memory" }, flows: [flow], security: strictSecurity });
    } catch (err) {
      const m = String((err as Error).message);
      expect(m).toMatch(/security\.crypto/);
      expect(m).toMatch(/principalCodec/);
      expect(m).toMatch(/strict/);
    }
  });

  it("a composed compliance plugin refuses the same way (non-strict)", () => {
    const cfg = {
      storage: { kind: "memory" as const },
      flows: [flow],
      security: { strict: false as const, compliance: { subjectOf: () => undefined } },
      observability: { onWarn: () => {} },
    };
    expect(() => defineConfig(cfg)).toThrow(PrincipalRecordingRefusedError);
    expect(() =>
      defineConfig({
        ...cfg,
        security: { ...cfg.security, principalCodec: testPrincipalCodec() },
      })
    ).not.toThrow();
  });

  it("strict + principalCodec composes and the log carries an opaque ref, no actor and no tenant", async () => {
    const stores = {
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
    };
    const app = defineConfig({
      storage: { kind: "custom", ...stores },
      flows: [flow],
      security: { ...strictSecurity, principalCodec: testPrincipalCodec() },
      execution: { registerEffects: (rt) => rt.register("t", new ToolEffect(async () => ({}))) },
      observability: { onWarn: () => {} },
    });
    try {
      const h = await app.runtime.start(flow, {}, { executionId: "p1", principal: alice });
      await h.waitForSuspend();
      const log = JSON.stringify(await stores.eventStore.read("p1"));
      expect(log).toMatch(/"principal":\{"v":1,"ref":"t:0"\}/);
      expect(log).not.toContain("alice");
      expect(log).not.toContain("acme");
      // The effects after a park still run as alice: the codec rehydrates her from the ref.
      const resumed = await app.runtime.resume(
        "p1",
        { eventType: "Go", payload: {} },
        { principal: alice }
      );
      await resumed.waitForCompletion();
      expect((await app.runtime.loadState("p1", { principal: alice }))?.status).toBe("completed");
    } finally {
      await app.close();
    }
  });

  it("crypto composed registers the identity paths (events AND the snapshot fold) and composes under strict", () => {
    const reg = registry();
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      security: { ...strictSecurity, crypto: { events: reg.events, snapshots: reg.snapshots } },
      observability: { onWarn: () => {} },
    });
    expect(reg.calls).toEqual([
      { eventType: "EXECUTION_STARTED", paths: PRINCIPAL_EVENT_PATHS },
      // ADR 0116 — a late outcome's `recordedBy` is the same identity, so it is shredded with it.
      { eventType: "OUTCOME_RECORDED", paths: ["recordedBy"] },
      { paths: [...PRINCIPAL_STATE_PATHS, "variables._outcomes[].recordedBy"] },
    ]);
    expect(PRINCIPAL_EVENT_PATHS).toEqual([
      "principal.identity.tenant",
      "principal.identity.actor",
      "principal.identity.onBehalfOf",
    ]);
    void app.close();
  });

  it("with the inbox on, crypto also seals an in-flight message payload (ADR 0110); with it off, nothing extra", () => {
    const withInbox = registry();
    const a = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      security: {
        ...strictSecurity,
        crypto: { events: withInbox.events, snapshots: withInbox.snapshots },
      },
      kernel: { features: { inbox: true } },
      timers: { store: new InMemoryTimerStore() },
      observability: { onWarn: () => {} },
    });
    expect(withInbox.calls).toContainEqual({ eventType: "INBOX_MESSAGE", paths: ["payload"] });
    // P3-2: the consumed copy in the owner's log is sealed too (new writes).
    expect(withInbox.calls).toContainEqual({ eventType: "MESSAGE_CONSUMED", paths: ["payload"] });
    void a.close();
    const without = registry();
    const b = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      security: {
        ...strictSecurity,
        crypto: { events: without.events, snapshots: without.snapshots },
      },
      observability: { onWarn: () => {} },
    });
    expect(without.calls.some((c) => c.eventType === "INBOX_MESSAGE")).toBe(false);
    expect(without.calls.some((c) => c.eventType === "MESSAGE_CONSUMED")).toBe(false);
    void b.close();
  });

  it("outside strict/compliance the verbatim subset is the zero-config default", async () => {
    const stores = {
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
    };
    const app = defineConfig({
      storage: { kind: "custom", ...stores },
      flows: [flow],
      security: { strict: false },
      observability: { onWarn: () => {} },
    });
    try {
      const h = await app.runtime.start(flow, {}, { executionId: "p2", principal: alice });
      await h.waitForSuspend();
      expect(
        ((await stores.eventStore.read("p2"))[0]?.payload as { principal: unknown }).principal
      ).toEqual({
        v: 1,
        identity: { tenant: "acme", actor: "alice" },
      });
    } finally {
      await app.close();
    }
  });
});
