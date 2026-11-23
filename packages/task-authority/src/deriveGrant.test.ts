import { describe, expect, it } from "vitest";
import { deriveGrant } from "./deriveGrant";

describe("deriveGrant (ADR 0150 D9)", () => {
  it("effects are exactly the reach: sorted, de-duplicated, nothing added", () => {
    // kills: adding a wildcard / extra effect, or keeping duplicates / input order
    const g = deriveGrant(["b", "a", "b"]);
    expect(g.effects).toEqual(["a", "b"]);
    expect(g.leases).toEqual({});
    expect(g.reads).toBeUndefined();
  });

  it("extra fields pass through but cannot replace the derived effects", () => {
    // kills: spreading extra after effects
    const g = deriveGrant(["a"], { ttlMs: 5, sandbox: "isolated", effects: ["evil"] } as never);
    expect(g).toMatchObject({ effects: ["a"], ttlMs: 5, sandbox: "isolated" });
  });

  it("an empty reach derives an empty grant (it must not widen to everything)", () => {
    expect(deriveGrant([]).effects).toEqual([]);
  });
});
