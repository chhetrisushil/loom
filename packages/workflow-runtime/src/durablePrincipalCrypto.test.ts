import { step$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, type PrincipalChain, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  EncryptingEventStore,
  EncryptingSnapshotStore,
  InMemoryKeyStore,
  shredSubject,
} from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowRuntime } from "./WorkflowRuntime";
import type { FlowRunner, RegisteredFlow } from "./types";

// ── R3k (ADR 0111 D1/D2) — the identity subset under the crypto plugin ─────────────────────
//
// `defineConfig` registers `principal.identity.*` (events) and `variables._principal.identity.*`
// (the snapshot fold) as sensitive when crypto is composed. These tests do that registration by
// hand, the way `defineConfig` does, and check what is on disk and what a shred does.

const io = { inputSchema: z.object({}), outputSchema: z.object({ ok: z.boolean() }) };
const act = step$({ id: "act", name: "act", toolId: "act-tool", ...io });
const alice: PrincipalChain = { actor: "alice", tenant: "acme" };

const EVENT_PATHS = [
  "principal.identity.tenant",
  "principal.identity.actor",
  "principal.identity.onBehalfOf",
];
const STATE_PATHS = EVENT_PATHS.map((p) => `variables._${p}`);

function boot(
  shared?: {
    raw: InMemoryAsyncEventStore;
    rawSnaps: InMemoryAsyncSnapshotStore;
    keys: InMemoryKeyStore;
  },
  tolerant = false
) {
  const raw = shared?.raw ?? new InMemoryAsyncEventStore();
  const rawSnaps = shared?.rawSnaps ?? new InMemoryAsyncSnapshotStore();
  const keys = shared?.keys ?? new InMemoryKeyStore();
  const events = new EncryptingEventStore(raw, keys, {
    sensitive: {},
    ...(tolerant && { onShredded: "tolerate" as const }),
  });
  const snaps = new EncryptingSnapshotStore(rawSnaps, keys, { sensitive: [], events: raw });
  events.registerSensitive("EXECUTION_STARTED", EVENT_PATHS);
  snaps.registerSensitive(STATE_PATHS);
  const seen: Array<PrincipalChain | undefined> = [];
  const effects = new EffectRuntime([], {
    authorizer: {
      authorize: (r) => {
        seen.push(r.principal);
        return { allowed: true };
      },
    },
  });
  const ran: string[] = [];
  effects.register(
    "act-tool",
    new ToolEffect(async () => {
      ran.push("act");
      return { ok: true };
    })
  );
  const runtime = new WorkflowRuntime({
    eventStore: events,
    snapshotStore: snaps,
    effectRuntime: effects,
    principalIdentity: "encrypted",
    snapshotEvery: 1,
  });
  const runner: FlowRunner<unknown, { ok: boolean }> = async (ctx) => {
    await ctx.suspend({ on: "Go" });
    return ctx.run(act, {});
  };
  const definition: FlowDefinition = {
    _tag: "FlowDefinition",
    id: "enc",
    name: "enc",
    version: "1.0.0",
    ...io,
    steps: [act],
  };
  const flow: RegisteredFlow = { definition, runner: runner as FlowRunner<unknown, unknown> };
  runtime.registerFlow(definition, flow.runner);
  return { runtime, flow, seen, ran, raw, rawSnaps, keys };
}

describe("identity under crypto", () => {
  it("is encrypted at rest in the log AND in the snapshot, and a restart still acts as the owner", async () => {
    const a = boot();
    const run = await a.runtime.start(a.flow, {}, { executionId: "e1", principal: alice });
    await run.waitForSuspend();
    const rawLog = JSON.stringify(await a.raw.read("e1"));
    expect(rawLog).not.toContain("alice");
    expect(rawLog).not.toContain("acme");
    expect(rawLog).toContain("__loomEnc");
    const rawSnap = JSON.stringify(await a.rawSnaps.loadLatest("e1"));
    expect(rawSnap).not.toContain("alice");
    expect(rawSnap).not.toContain("acme");

    // another process, same stores + keys: decrypts the record and resumes as alice
    const b = boot(a);
    const resumed = await b.runtime.resume("e1", { eventType: "Go", payload: {} });
    await resumed.waitForCompletion();
    expect(b.seen.at(-1)).toEqual({ tenant: "acme", actor: "alice" });
  });

  it("shredded with its subject: every effect is denied and never runs as the resumer", async () => {
    const a = boot(undefined, true);
    const run = await a.runtime.start(a.flow, {}, { executionId: "e2", principal: alice });
    await run.waitForSuspend();
    // erasure = key destruction plus its tombstone (what shredSubject does; a key that is merely
    // absent, with no tombstone, is "key-unavailable" since ADR 0130 residuals D7)
    await shredSubject(a.keys, a.raw, "e2", { snapshotStore: a.rawSnaps });

    const b = boot({ raw: a.raw, rawSnaps: a.rawSnaps, keys: a.keys }, true);
    const resumed = await b.runtime
      .resume(
        "e2",
        { eventType: "Go", payload: {} },
        { principal: { actor: "carol", tenant: "acme" } }
      )
      .catch((e: unknown) => e);
    // The encrypting SNAPSHOT store reads strictly, so the resume itself fails loudly with
    // PayloadShreddedError (replay must never diverge). A tolerant read of the log alone hands back
    // `$shredded` placeholders — covered in durablePrincipal.test.ts: the principal is then the
    // shredded marker and every effect is denied. Either way nothing runs as the resumer.
    expect(resumed).toBeInstanceOf(Error);
    expect(String(resumed)).toMatch(/shredded/);
    expect(b.ran).toEqual([]);
    expect(b.seen).toEqual([]); // the kernel refused before any authorizer was asked
  });
});

describe("a fork under crypto without a codec", () => {
  it("refuses an identified forker (envelope metadata is not encrypted) and writes nothing", async () => {
    const a = boot();
    const run = await a.runtime.start(a.flow, {}, { executionId: "e3", principal: alice });
    await run.waitForSuspend();
    const seq = (await a.runtime.loadState("e3"))!.sequence;
    await expect(
      a.runtime.fork("e3", seq, {
        executionId: "e3-fk",
        principal: { actor: "dave", tenant: "acme" },
      })
    ).rejects.toThrow(/metadata, which the crypto plugin does not encrypt/);
    expect(await a.raw.read("e3-fk")).toHaveLength(0);
    // an anonymous forker names no identity, so there is nothing to leak
    await expect(a.runtime.fork("e3", seq, { executionId: "e3-fk2" })).resolves.toBeDefined();
  });
});
