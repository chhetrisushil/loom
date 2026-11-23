import { isTainted, scanTaint, tainted } from "@loomwork/classify";
import type { EffectContext } from "@loomwork/effect-runtime";
import { InMemoryMemoryStore, TieredMemory } from "@loomwork/memory";
import { InMemoryGrantBroker, lineageOrigin } from "@loomwork/task-authority";
import { describe, expect, it } from "vitest";
import { memoryWriteBackEffect } from "./agentLoop$";

// ADR 0150 D7 / S-R1: the write-back effect tags what it writes with the writer's VERIFIED lineage.
const SECRET = "wb-secret";
const mem = () =>
  new TieredMemory({ store: new InMemoryMemoryStore(), tiers: { working: { maxEntries: 100 } } });
const req = (content: unknown) => ({
  tier: "working",
  scope: "shared",
  entries: [{ id: "e1", role: "assistant", content }],
});
const ctxOf = (principal: unknown) => ({ principal }) as unknown as EffectContext;
const grantOf = async (taskId: string) => {
  const b = new InMemoryGrantBroker({ secret: SECRET, now: () => 1 });
  return b.mint({ taskId, issuedTo: "a", effects: ["w"], leases: {}, ttlMs: 1000 });
};

describe("memoryWriteBackEffect originOf", () => {
  it("writes lineage:<rootId> from the verified grant; a reader's recall scan sees it", async () => {
    const m = mem();
    const g = await grantOf("A");
    const eff = memoryWriteBackEffect(m, {
      originOf: (ctx) => lineageOrigin(SECRET)(ctx.principal as never),
    });
    await eff.execute(req("secret plan") as never, ctxOf({ actor: "a", taskGrant: g }));
    const [e] = await m.recall("working", "shared");
    expect(scanTaint(e?.content).origins).toContain("lineage:A");
  });

  // kills: tainted() semantics (an already-tainted answer would lose its lineage and read as plain mcp: taint)
  it("keeps an inner taint and still adds the lineage", async () => {
    const m = mem();
    const g = await grantOf("A");
    const eff = memoryWriteBackEffect(m, {
      originOf: (c) => lineageOrigin(SECRET)(c.principal as never),
    });
    await eff.execute(req(tainted("x", "mcp:srv")) as never, ctxOf({ actor: "a", taskGrant: g }));
    const [e] = await m.recall("working", "shared");
    expect(scanTaint(e?.content).origins).toEqual(expect.arrayContaining(["lineage:A", "mcp:srv"]));
  });

  // kills: an implementation that takes the lineage from the effect INPUT (flow-supplied) or tags without verifying
  it("a forged grant, or none, writes the content untagged (no invented lineage)", async () => {
    const m = mem();
    const g = await grantOf("A");
    const eff = memoryWriteBackEffect(m, {
      originOf: (c) => lineageOrigin(SECRET)(c.principal as never),
    });
    await eff.execute(
      req("a") as never,
      ctxOf({ actor: "a", taskGrant: { ...g, rootId: "VICTIM" } })
    );
    await eff.execute(
      { ...req("b"), entries: [{ id: "e2", role: "user", content: "b" }] } as never,
      ctxOf(undefined)
    );
    for (const e of await m.recall("working", "shared")) expect(isTainted(e.content)).toBe(false);
  });

  it("without originOf nothing changes", async () => {
    const m = mem();
    await memoryWriteBackEffect(m).execute(req("p") as never, ctxOf(undefined));
    expect((await m.recall("working", "shared"))[0]?.content).toBe("p");
  });
});
