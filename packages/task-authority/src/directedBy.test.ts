import { tainted } from "@loomwork/classify";
import { SEEN_ORIGINS_OVERFLOW } from "@loomwork/effect-runtime";
import { describe, expect, it } from "vitest";
import { SECRET, chainOf, until, world } from "./__tests__/lineageHarness";
import { TASK_GRANT_DENIAL } from "./authorizer";
import { type DirectedByOptions, directedBy } from "./directedBy";
import { lineageSend, wrapLineage } from "./lineage";
import { answerRenewal } from "./renewal";

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
