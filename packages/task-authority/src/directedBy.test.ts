import { tainted } from "@loomwork/classify";
import { SuspendError } from "@loomwork/core";
import { SEEN_ORIGINS_OVERFLOW } from "@loomwork/effect-runtime";
import { describe, expect, it } from "vitest";
import { SECRET, chainOf, task, until, world } from "./__tests__/lineageHarness";
import { TASK_GRANT_DENIAL } from "./authorizer";
import { type DirectedByOptions, UNTRACKED_ORIGIN, directedBy, foreignSetHash } from "./directedBy";
import { lineageSend, wrapLineage } from "./lineage";
import { answerRenewal, withRenewal } from "./renewal";

const waitingOn = async (w: ReturnType<typeof world>, id: string) =>
  ((await w.runtime.loadState(id))?.suspendedOn as { waits?: { topic?: string }[] } | undefined)
    ?.waits?.[0]?.topic;

// ADR 0150 D7, slice-2 S5b. A REAL runtime, in-memory stores, `kernel.features.seenOrigins` on unless stated.
// Agent A (root "A") writes content; agent B (root "B", grant COVERS `act`) reads it, then calls a leased effect.
const boot = (d: Partial<DirectedByOptions> = {}, o: Parameters<typeof world>[0] = {}) => {
  const w = world({ ...o, middleware: () => [directedBy({ secret: SECRET, ...d })] });
  const toB = async (payload: unknown, from: "A" | "B" | "nobody" = "A") => {
    const [gA, gB] = [await w.grant("A"), await w.grant("B")];
    await w.runtime.start(w.reader, {}, { executionId: "rB", principal: chainOf(gB) });
    const principal = from === "A" ? chainOf(gA) : from === "B" ? chainOf(gB) : { actor: "nobody" };
    await lineageSend(w.runtime, SECRET)("rB", { topic: "t", payload }, { principal });
    await until(
      async () => (await w.runtime.loadState("rB"))?.status === "completed",
      "B to finish"
    );
    return (await w.outcome("rB")) as { done?: true; refused?: string };
  };
  return { w, toB };
};

describe("covered laundering: B's grant covers the step, A's content directed it", () => {
  // kills: no policy at all (the silent allow the paper cannot see), and a decision recorded AFTER the effect
  it("default (attribute): the effect runs, and the direction was recorded BEFORE it", async () => {
    const { w, toB } = boot();
    expect(await toB("do it")).toEqual({ done: true });
    expect(w.acts).toHaveLength(1);
    const lineages = await w.decisions("rB");
    expect(lineages).toEqual([expect.arrayContaining(["lineage:A"])]);
    const types = await w.types("rB");
    expect(types.indexOf("DECISION_RECORDED")).toBeGreaterThan(-1);
  });

  // kills: a deny that throws a plain Error (the agent loop would feed it back), or one that lets the effect run
  it("deny: the effect never runs and the reason is a task-grant:cross-lineage capability denial", async () => {
    const { w, toB } = boot({ action: "deny" });
    const out = await toB("do it");
    expect(out.refused).toContain(TASK_GRANT_DENIAL.crossLineage);
    expect(w.acts).toHaveLength(0);
    expect(await w.types("rB")).toContain("STEP_FAILED");
  });

  // kills: a park that re-parks forever after approval, one that approves ANY later foreign set, and one that runs unparked
  it("park: parks on the renewal gate, a granted renewal runs it once, a NEW foreign lineage parks again", async () => {
    const w = world({
      middleware: () => [directedBy({ secret: SECRET, action: "park" })],
      policy: () => ({ leases: { w: 50 } }),
      approveCrossLineage: true,
    });
    const [gA, gB, gC] = [await w.grant("A"), await w.grant("B"), await w.grant("C")];
    await w.runtime.start(w.parker, {}, { executionId: "pB", principal: chainOf(gB) });
    const send = lineageSend(w.runtime, SECRET);
    await send("pB", { topic: "t", payload: "x" }, { principal: chainOf(gA) });
    const parkedOn = async () =>
      (await w.runtime.loadState("pB"))?.suspendedOn as
        | { on?: string; correlationKey?: string }
        | undefined;
    await until(async () => (await parkedOn())?.on === "task-authority:renew", "first park");
    expect(w.acts).toHaveLength(0);
    await answerRenewal(w.runtime, w.broker, "pB");
    await until(async () => (await parkedOn())?.on === "inbox" || w.acts.length === 1, "first act");
    expect(w.acts).toHaveLength(1);
    await send("pB", { topic: "u", payload: "y" }, { principal: chainOf(gC) });
    await until(async () => (await parkedOn())?.on === "task-authority:renew", "second park");
    expect(w.acts).toHaveLength(1);
    await answerRenewal(w.runtime, w.broker, "pB");
    await until(
      async () => (await w.runtime.loadState("pB"))?.status === "completed",
      "completion"
    );
    expect(w.acts).toHaveLength(2);
  });

  const parkWorld = (o: Parameters<typeof world>[0] = {}) =>
    world({ middleware: () => [directedBy({ secret: SECRET, action: "park" })], ...o });
  const parkedOn = async (w: ReturnType<typeof world>, id: string) =>
    ((await w.runtime.loadState(id))?.suspendedOn as { on?: string } | undefined)?.on;

  // kills (P1): a default reference broker that approves a cross-lineage park like any lease top-up
  it("the DEFAULT broker does not approve a cross-lineage park; the approver is shown the foreign set", async () => {
    const w = parkWorld();
    const [gA, gB] = [await w.grant("A"), await w.grant("B")];
    await w.runtime.start(w.parker, {}, { executionId: "pB", principal: chainOf(gB) });
    await lineageSend(w.runtime, SECRET)(
      "pB",
      { topic: "t", payload: "x" },
      { principal: chainOf(gA) }
    );
    await until(async () => (await parkedOn(w, "pB")) === "task-authority:renew", "park");
    const dec = Object.values(
      ((await w.runtime.loadState("pB"))?.variables._decisions ?? {}) as Record<
        string,
        { choice?: unknown }
      >
    ).map((d) => d.choice) as {
      request?: { reason?: string; lineages?: string[]; hash?: string };
    }[];
    const req = dec.find((c) => c?.request?.reason !== undefined)?.request;
    expect(req).toEqual({
      taskId: "B",
      epoch: 0,
      spent: {},
      renewals: 0,
      reason: "cross-lineage",
      lineages: ["lineage:A"],
      hash: foreignSetHash(["lineage:A"]),
    });
    await answerRenewal(w.runtime, w.broker, "pB").catch(() => undefined);
    await until(
      async () => (await w.runtime.loadState("pB"))?.status === "failed",
      "refused run fails"
    );
    expect(w.acts).toHaveLength(0);
  });

  // kills (P2): approval = any renewal (the meter design): an unrelated renewal followed by a retry ran the act
  it("an UNRELATED renewal plus a retry still parks, and the act never runs", async () => {
    const w = parkWorld();
    const f = w.flowOf("catcher", async (ctx) => {
      await ctx.receive("t");
      try {
        await ctx.run(task("s1"), {});
      } catch (e) {
        if (e instanceof SuspendError) throw e;
      }
      await ctx.receive("go");
      await ctx.run(task("s2"), {});
      return { done: true };
    });
    const [gA, gB] = [await w.grant("A"), await w.grant("B")];
    await w.runtime.start(f, {}, { executionId: "cB", principal: chainOf(gB) });
    await lineageSend(w.runtime, SECRET)(
      "cB",
      { topic: "t", payload: "x" },
      { principal: chainOf(gA) }
    );
    await until(async () => (await waitingOn(w, "cB")) === "go", "waiting go");
    expect((await w.broker.renew({ taskId: "B", epoch: 0, spent: {}, renewals: 0 })).granted).toBe(
      true
    );
    await w.send("cB", "go", 1);
    await until(
      async () => (await w.runtime.loadState("cB"))?.status === "failed",
      "retry parks, flow ends"
    );
    expect(w.acts).toHaveLength(0);
    expect((await w.broker.current("B"))?.approvedLineages).toBeUndefined();
  });

  // kills: dropping the approval on a later unrelated renewal (M-2), and approving a set by an approval of another
  it("an approval of set X survives an unrelated later renewal and does not approve set Y", async () => {
    const w = parkWorld({ approveCrossLineage: true });
    const f = w.flowOf("two", async (ctx) => {
      await ctx.receive("t");
      await withRenewal(ctx as never, "a", (id) => ctx.run(task(id), {}));
      await ctx.receive("go");
      await withRenewal(ctx as never, "b", (id) => ctx.run(task(id), {}));
      await ctx.receive("other");
      await withRenewal(ctx as never, "c", (id) => ctx.run(task(id), {}));
      return { done: true };
    });
    const [gA, gB, gC] = [await w.grant("A"), await w.grant("B"), await w.grant("C")];
    await w.runtime.start(f, {}, { executionId: "xB", principal: chainOf(gB) });
    const send = lineageSend(w.runtime, SECRET);
    await send("xB", { topic: "t", payload: "x" }, { principal: chainOf(gA) });
    await until(async () => (await parkedOn(w, "xB")) === "task-authority:renew", "park for A");
    await answerRenewal(w.runtime, w.broker, "xB");
    await until(async () => w.acts.length === 1, "A approved");
    await until(async () => (await waitingOn(w, "xB")) === "go", "waiting go");
    const cur = await w.broker.current("B");
    expect(
      (await w.broker.renew({ taskId: "B", epoch: cur?.epoch ?? 0, spent: {}, renewals: 1 }))
        .granted
    ).toBe(true);
    expect((await w.broker.current("B"))?.approvedLineages).toEqual([
      foreignSetHash(["lineage:A"]),
    ]);
    await w.send("xB", "go", 1);
    await until(
      async () => w.acts.length === 2,
      "same set still approved after the unrelated renewal"
    );
    await until(async () => (await waitingOn(w, "xB")) === "other", "waiting other");
    await send("xB", { topic: "other", payload: "y" }, { principal: chainOf(gC) });
    await until(async () => (await parkedOn(w, "xB")) === "task-authority:renew", "Y parks");
    expect(w.acts).toHaveLength(2);
  });

  // kills (R22): a broker that trusts `hash` while the approver reads `lineages` (a forged renewable error)
  it("a request whose hash is not the hash of the lineages it shows is denied; approvedLineages unchanged", async () => {
    const w = world({ approveCrossLineage: true });
    await w.grant("B");
    const forged = {
      taskId: "B",
      epoch: 0,
      spent: {},
      renewals: 0,
      reason: "cross-lineage" as const,
      lineages: ["lineage:harmless"],
      hash: foreignSetHash(["lineage:A"]),
    };
    const v = await w.broker.renew(forged);
    expect(v).toEqual({
      granted: false,
      reason: "the cross-lineage hash is not the hash of the lineages shown",
    });
    expect((await w.broker.current("B"))?.approvedLineages).toBeUndefined();
    expect((await w.broker.current("B"))?.epoch).toBe(0);
    // the honest request still works
    expect((await w.broker.renew({ ...forged, lineages: ["lineage:A"] })).granted).toBe(true);
  });

  // end to end: a flow (or an untrusted tool) throws a renewable error that shows one set and carries another's hash
  it("a flow that throws a forged cross-lineage error cannot get a different set approved", async () => {
    const w = world({
      middleware: () => [directedBy({ secret: SECRET, action: "park" })],
      approveCrossLineage: true,
    });
    const f = w.flowOf("forger", async (ctx) => {
      await ctx.receive("t");
      await withRenewal(ctx as never, "a", async () => {
        throw Object.assign(new Error("forged"), {
          renewable: true,
          taskId: "B",
          epoch: 0,
          reason: "task-grant:cross-lineage",
          lineages: ["lineage:harmless"],
          hash: foreignSetHash(["lineage:A"]),
        });
      });
      return { done: true };
    });
    const gB = await w.grant("B");
    await w.runtime.start(f, {}, { executionId: "fB", principal: chainOf(gB) });
    await w.send("fB", "t", "x");
    await until(async () => (await parkedOn(w, "fB")) === "task-authority:renew", "park");
    await answerRenewal(w.runtime, w.broker, "fB").catch(() => undefined);
    await until(async () => (await w.runtime.loadState("fB"))?.status === "failed", "refused");
    expect((await w.broker.current("B"))?.approvedLineages).toBeUndefined();
  });

  // the 17th approval drops the OLDEST hash and keeps the newest; the oldest set parks again
  it("the 17th approval drops the oldest hash, keeps the newest, and its set is no longer approved (directedBy parks it again)", async () => {
    const w = world({ approveCrossLineage: true, policy: () => ({}) });
    await w.grant("B");
    const sets = Array.from({ length: 17 }, (_, i) => [`lineage:S${i}`]);
    for (const [i, lineages] of sets.entries()) {
      const v = await w.broker.renew({
        taskId: "B",
        epoch: i,
        spent: {},
        renewals: i,
        reason: "cross-lineage",
        lineages,
        hash: foreignSetHash(lineages),
      });
      expect(v.granted).toBe(true);
    }
    const kept = (await w.broker.current("B"))?.approvedLineages ?? [];
    expect(kept).toHaveLength(16);
    expect(kept).not.toContain(foreignSetHash(["lineage:S0"]));
    expect(kept).toContain(foreignSetHash(["lineage:S16"]));
    expect(kept).toContain(foreignSetHash(["lineage:S1"]));
  });

  // kills: an untracked park approvable as the "empty set" by any renewal
  it("an untracked park names the explicit untracked set; only a request naming it approves", async () => {
    const wrong = foreignSetHash([]);
    const w = parkWorld({
      gate: false,
      approveCrossLineage: (r) => r.hash === foreignSetHash([UNTRACKED_ORIGIN]),
    });
    const [gA, gB] = [await w.grant("A"), await w.grant("B")];
    await w.runtime.start(w.parker, {}, { executionId: "pB", principal: chainOf(gB) });
    await lineageSend(w.runtime, SECRET)(
      "pB",
      { topic: "t", payload: "x" },
      { principal: chainOf(gA) }
    );
    await until(async () => (await parkedOn(w, "pB")) === "task-authority:renew", "park");
    expect(w.acts).toHaveLength(0);
    expect(foreignSetHash([UNTRACKED_ORIGIN])).not.toBe(wrong);
    await answerRenewal(w.runtime, w.broker, "pB");
    await until(async () => w.acts.length === 1, "explicitly approved");
  });

  // kills: an attribute record that is not durable before the effect body runs (M-3)
  it("the attribute record is durable before the effect body", async () => {
    const { w, toB } = boot();
    await toB("do it");
    expect(w.acts[0]?.logged).toBe(1);
  });

  // kills: an implementation that treats the kernel's truncated label as non-foreign (I-3 / P4)
  it("a lineage label over 256 chars (kernel-truncated to unknown:truncated:) is foreign", async () => {
    const { w, toB } = boot({ action: "deny" });
    const out = await toB(tainted("x", `lineage:${"A".repeat(300)}`), "nobody");
    expect(out.refused).toContain(TASK_GRANT_DENIAL.crossLineage);
    expect(w.acts).toHaveLength(0);
  });

  // kills: a default that treats an A2A peer as the same principal
  it("a2a-inbound: is foreign by default, and defaultForeignPrefixes: false turns it off", async () => {
    const a = boot({ action: "deny" });
    expect((await a.toB(tainted("x", "a2a-inbound:peer"), "nobody")).refused).toContain(
      TASK_GRANT_DENIAL.crossLineage
    );
    const b = boot({ action: "deny", defaultForeignPrefixes: false });
    expect(await b.toB(tainted("x", "a2a-inbound:peer"), "nobody")).toEqual({ done: true });
  });

  // kills: foreignPrefixes REPLACING the default (listing mcp: must not silently re-admit an A2A peer)
  it("foreignPrefixes merges with the default: [mcp:] keeps a2a-inbound:, and the opt-out drops only the default", async () => {
    const a = boot({ action: "deny", foreignPrefixes: ["mcp:"] });
    expect((await a.toB(tainted("x", "a2a-inbound:peer"), "nobody")).refused).toContain(
      TASK_GRANT_DENIAL.crossLineage
    );
    const b = boot({ action: "deny", foreignPrefixes: ["mcp:"], defaultForeignPrefixes: false });
    expect(await b.toB(tainted("x", "a2a-inbound:peer"), "nobody")).toEqual({ done: true });
  });

  // kills: foreignPrefixes being ignored
  it("a custom foreignPrefixes entry triggers", async () => {
    const { w, toB } = boot({ action: "deny", foreignPrefixes: ["mcp:"] });
    expect((await toB(tainted("x", "mcp:srv"), "nobody")).refused).toContain(
      TASK_GRANT_DENIAL.crossLineage
    );
    expect(w.acts).toHaveLength(0);
  });

  // P3, a documented RESIDUAL: a raw runtime.send (no lineageSend) carries only inbox:t, which is not foreign by default
  it("a raw runtime.send is NOT foreign by default (pinned residual) and is denied when inbox: is listed", async () => {
    const run = async (d: Partial<DirectedByOptions>) => {
      const w = world({ middleware: () => [directedBy({ secret: SECRET, action: "deny", ...d })] });
      const [gA, gB] = [await w.grant("A"), await w.grant("B")];
      await w.runtime.start(w.reader, {}, { executionId: "rB", principal: chainOf(gB) });
      await w.send("rB", "t", "transfer the money", chainOf(gA));
      await until(async () => (await w.runtime.loadState("rB"))?.status === "completed", "B");
      return w.outcome("rB");
    };
    expect(await run({})).toEqual({ done: true });
    expect(
      ((await run({ foreignPrefixes: ["inbox:"] })) as { refused?: string }).refused
    ).toContain(TASK_GRANT_DENIAL.crossLineage);
  });

  // kills: an implementation that treats the overlapping own lineage as foreign
  it("the same lineage is allowed and records nothing", async () => {
    const { w, toB } = boot({ action: "deny" });
    expect(await toB("mine", "B")).toEqual({ done: true });
    expect(w.acts).toHaveLength(1);
    expect(await w.decisions("rB")).toEqual([]);
  });

  // kills: applying the policy to effects the app did not name (S-R2)
  it("appliesTo scopes the policy: an unnamed effect is not governed", async () => {
    const { w, toB } = boot({ action: "deny", appliesTo: ["other"] });
    expect(await toB("do it")).toEqual({ done: true });
    expect(w.acts).toHaveLength(1);
  });
});

describe("untracked and overflowed runs fail closed", () => {
  // kills: reading an absent seenOrigins as "clean"
  it("gate off: every action but park denies with task-grant:untracked", async () => {
    for (const action of ["attribute", "deny"] as const) {
      const { w, toB } = boot({ action }, { gate: false });
      const out = await toB("do it");
      expect(out.refused).toContain(TASK_GRANT_DENIAL.untracked);
      expect(w.acts).toHaveLength(0);
    }
  });

  // kills: a park action that denies (or runs) an untracked run instead of parking it
  it("gate off with action park: parks on the renewal gate and runs nothing", async () => {
    const w = world({
      gate: false,
      middleware: () => [directedBy({ secret: SECRET, action: "park" })],
    });
    const [gA, gB] = [await w.grant("A"), await w.grant("B")];
    await w.runtime.start(w.parker, {}, { executionId: "pB", principal: chainOf(gB) });
    await lineageSend(w.runtime, SECRET)(
      "pB",
      { topic: "t", payload: "x" },
      { principal: chainOf(gA) }
    );
    await until(
      async () =>
        ((await w.runtime.loadState("pB"))?.suspendedOn as { on?: string } | undefined)?.on ===
        "task-authority:renew",
      "park"
    );
    expect(w.acts).toHaveLength(0);
  });

  // kills: reading .at(-1) of the list, or ignoring the marker when it is the only origin
  it("overflow counts as foreign, even for the run's own lineage", async () => {
    for (const from of ["A", "B"] as const) {
      const { w, toB } = boot({ action: "deny" }, { maxOrigins: 1 });
      const out = await toB("do it", from);
      expect(out.refused).toContain(TASK_GRANT_DENIAL.crossLineage);
      expect(w.acts).toHaveLength(0);
    }
    expect(SEEN_ORIGINS_OVERFLOW).toBeTypeOf("string");
  });
});

describe("non-lineage untrusted origins", () => {
  // kills: a policy that fires on every untrusted origin by default (S-R3)
  it("an mcp: origin and the inbox origin are ignored by default", async () => {
    const { w, toB } = boot({ action: "deny" });
    expect(await toB(tainted("x", "mcp:srv"), "nobody")).toEqual({ done: true });
    expect(w.acts).toHaveLength(1);
  });

  // kills: foreign:"any-untrusted" being a no-op
  it('foreign: "any-untrusted" denies on the same input', async () => {
    const { w, toB } = boot({ action: "deny", foreign: "any-untrusted" });
    expect((await toB(tainted("x", "mcp:srv"), "nobody")).refused).toContain(
      TASK_GRANT_DENIAL.crossLineage
    );
    expect(w.acts).toHaveLength(0);
  });
});

describe("a forged lineage: what it can and cannot do", () => {
  // The safe direction: a forged label can only ADD a foreign origin, which makes the policy stricter.
  it("a grantless caller labelling content lineage:A makes B's step foreign (cannot clear anything)", async () => {
    const { w, toB } = boot({ action: "deny" });
    expect((await toB(tainted("x", "lineage:A"), "nobody")).refused).toContain(
      TASK_GRANT_DENIAL.crossLineage
    );
    expect(w.acts).toHaveLength(0);
  });

  // The dangerous direction 1: re-wrapping A's REAL content as B's own cannot hide A (the inner wrapper is kept).
  it("re-labelling A's content as lineage:B keeps lineage:A visible", async () => {
    const { w, toB } = boot({ action: "deny" });
    const forged = wrapLineage(wrapLineage("x", "lineage:A"), "lineage:B");
    expect((await toB(forged, "nobody")).refused).toContain(TASK_GRANT_DENIAL.crossLineage);
    expect(w.acts).toHaveLength(0);
  });

  // The dangerous direction 2 (the residual, pinned): fresh content a grantless writer labels with B's OWN root reads as B's.
  // `foreign: "any-untrusted"` closes it: the inbox origin is still there.
  it("fresh content labelled lineage:<B's root> by a grantless writer is not foreign by default; any-untrusted still refuses", async () => {
    const a = boot({ action: "deny" });
    expect(await a.toB(tainted("x", "lineage:B"), "nobody")).toEqual({ done: true });
    const b = boot({ action: "deny", foreign: "any-untrusted" });
    expect((await b.toB(tainted("x", "lineage:B"), "nobody")).refused).toContain(
      TASK_GRANT_DENIAL.crossLineage
    );
    expect(b.w.acts).toHaveLength(0);
  });
});
