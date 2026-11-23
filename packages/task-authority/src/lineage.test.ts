import { isTainted, tainted } from "@loomwork/classify";
import { describe, expect, it } from "vitest";
import { SECRET, chainOf, until, world } from "./__tests__/lineageHarness";
import { type TaskGrant, signTaskGrant } from "./grant";
import { lineageOrigin, lineageSend, lineageTainter, wrapLineage } from "./lineage";

// ADR 0150 D7 / S-R1, slice-2 S5a: the writer's lineage, from a VERIFIED grant only.
describe("lineageOrigin: the rootId comes from a verified grant, never from the caller", () => {
  it("a verified grant gives lineage:<rootId>; a child grant gives its ROOT's id", async () => {
    const w = world();
    const g = await w.grant("A");
    expect(lineageOrigin(SECRET)(chainOf(g))).toBe("lineage:A");
  });

  // kills: an implementation that trusts `taskGrant.rootId` without verifying the signature (a forged tag)
  it("a forged or tampered grant yields no origin", async () => {
    const w = world();
    const g = await w.grant("A");
    const tampered = { ...g, rootId: "B", taskId: "B" } as TaskGrant;
    expect(lineageOrigin(SECRET)(chainOf(tampered))).toBeUndefined();
    const wrongKey = signTaskGrant("not-the-secret", { ...g, sig: undefined } as never);
    expect(lineageOrigin(SECRET)(chainOf(wrongKey))).toBeUndefined();
  });

  // kills: an implementation that ignores the holder (a stolen, validly signed grant presented by someone else)
  it("a valid grant presented by a different actor yields no origin", async () => {
    const w = world();
    const g = await w.grant("A");
    expect(lineageOrigin(SECRET)({ actor: "mallory", taskGrant: g })).toBeUndefined();
  });

  it("no grant, or a throwing principal, yields no origin", () => {
    expect(lineageOrigin(SECRET)(undefined)).toBeUndefined();
    expect(lineageOrigin(SECRET)({ actor: "x" })).toBeUndefined();
    const evil = {
      get taskGrant(): never {
        throw new Error("boom");
      },
    };
    expect(lineageOrigin(SECRET)(evil)).toBeUndefined();
  });
});

describe("lineageOrigin: bounds and tenant", () => {
  const signed = (taskId: string, extra: Record<string, unknown> = {}) =>
    signTaskGrant(SECRET, {
      taskId,
      rootId: taskId,
      issuedTo: "x",
      effects: ["act"],
      leases: {},
      exp: 9e9,
      epoch: 0,
      ...extra,
    } as never);

  // kills: tagging a rootId the kernel truncates into `unknown:truncated:...` (which is not a comparable lineage)
  it("refuses to tag a rootId whose origin would exceed 256 chars, and the broker refuses to mint one", async () => {
    const long = "A".repeat(250);
    expect(lineageOrigin(SECRET)({ actor: "x", taskGrant: signed(long) })).toBeUndefined();
    expect(lineageOrigin(SECRET)({ actor: "x", taskGrant: signed("A".repeat(248)) })).toBe(
      `lineage:${"A".repeat(248)}`
    );
    await expect(world().grant(long)).rejects.toThrow(/lineage origin/);
  });

  // kills: a tenant-blind lineageOrigin (a grant presented under another tenant)
  it("a grant of tenant t1 presented by a principal of another tenant yields no origin", () => {
    const g = signed("T", { tenant: "t1" });
    expect(lineageOrigin(SECRET)({ actor: "x", tenant: "t1", taskGrant: g })).toBe("lineage:T");
    expect(lineageOrigin(SECRET)({ actor: "x", tenant: "t2", taskGrant: g })).toBeUndefined();
    expect(lineageOrigin(SECRET)({ actor: "x", taskGrant: g })).toBeUndefined();
  });
});

describe("wrapLineage / lineageTainter", () => {
  // kills: tainted(), which keeps ONLY the original origin and so drops the lineage of already-tainted content
  it("keeps an inner taint INSIDE the lineage wrapper", () => {
    const w = wrapLineage(tainted("x", "mcp:srv"), "lineage:A");
    expect(w.__loomTainted.origin).toBe("lineage:A");
    expect(isTainted(w.value) && w.value.__loomTainted.origin).toBe("mcp:srv");
  });

  it("is idempotent per origin", () => {
    const once = wrapLineage("x", "lineage:A");
    expect(wrapLineage(once, "lineage:A")).toBe(once);
  });

  // kills: a tainter that invents a tag for a writer without a verified grant
  it("leaves content untouched for a writer without a verified grant", async () => {
    const tag = lineageTainter(SECRET);
    expect(tag({ actor: "nobody" }, "hello")).toBe("hello");
    const g = await world().grant("A");
    expect(isTainted(tag(chainOf(g), "hello"))).toBe(true);
  });
});

describe("lineageSend: a real inbox delivery carries the SENDER's lineage into the reader's seen origins", () => {
  it("B receives A's message and its next effect sees lineage:A and inbox:t", async () => {
    const w = world();
    const [gA, gB] = [await w.grant("A"), await w.grant("B")];
    await w.runtime.start(w.reader, {}, { executionId: "rB", principal: chainOf(gB) });
    await lineageSend(w.runtime, SECRET)(
      "rB",
      { topic: "t", payload: "do it" },
      { principal: chainOf(gA) }
    );
    await until(() => w.acts.length === 1, "B's act");
    expect(w.acts[0]?.seen).toEqual(expect.arrayContaining(["lineage:A", "inbox:t"]));
  });

  // kills: a send helper that tags with a caller-supplied rootId, or one that tags grantless senders as someone
  it("a sender with no verified grant adds inbox:t only, no lineage origin", async () => {
    const w = world();
    const gB = await w.grant("B");
    await w.runtime.start(w.reader, {}, { executionId: "rB", principal: chainOf(gB) });
    await lineageSend(w.runtime, SECRET)(
      "rB",
      { topic: "t", payload: "x" },
      { principal: { actor: "anon" } }
    );
    await until(() => w.acts.length === 1, "B's act");
    expect(w.acts[0]?.seen).toEqual(["inbox:t"]);
  });
});
