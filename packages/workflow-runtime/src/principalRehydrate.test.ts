import type { EventEnvelope } from "@loom/core";
import type { PrincipalChain } from "@loom/effect-runtime";
import { describe, expect, it } from "vitest";
import { rehydratePrincipal, storedPrincipalOf } from "./principal";

// R3k review round 1 — P1 (a resolver's `undefined` must never mean "no principal" for a
// non-empty record) and P3-2 (the principal is read only from sequence 0's EXECUTION_STARTED).

const undef = { resolve: () => undefined };
const codecFor = (chain: PrincipalChain | undefined) => ({
  toRef: () => undefined,
  fromRef: () => chain,
});

describe("rehydratePrincipal — resolver answers are never a silent 'no principal'", () => {
  it("a ref record goes to the codec FIRST, even with a resolver configured", async () => {
    const chain = await rehydratePrincipal({ v: 1, ref: "r" }, "e", {
      codec: codecFor({ actor: "kid" }),
      resolver: undef,
    });
    expect(chain).toEqual({ actor: "kid" });
  });

  it("a ref neither the codec nor the resolver restores is principalUnresolved", async () => {
    const chain = await rehydratePrincipal({ v: 1, ref: "r" }, "e", {
      codec: codecFor(undefined),
      resolver: undef,
    });
    expect(chain?.principalUnresolved).toMatch(/could not be restored/);
  });

  it("a ref the codec cannot restore falls to the resolver, which may answer", async () => {
    const chain = await rehydratePrincipal({ v: 1, ref: "r" }, "e", {
      codec: codecFor(undefined),
      resolver: { resolve: () => ({ actor: "x" }) },
    });
    expect(chain).toEqual({ actor: "x" });
  });

  it("a resolver answering undefined for an identity record denies", async () => {
    const chain = await rehydratePrincipal({ v: 1, identity: { actor: "a" } }, "e", {
      codec: undefined,
      resolver: undef,
    });
    expect(chain?.principalUnresolved).toBeDefined();
  });

  it("a resolver answering undefined for a delegation record denies", async () => {
    const chain = await rehydratePrincipal({ v: 1, delegation: { id: "d" } }, "e", {
      codec: undefined,
      resolver: undef,
    });
    expect(chain).toMatchObject({ delegationUnresolved: "d" });
  });

  it("only the empty { v: 1 } record means no principal", async () => {
    expect(await rehydratePrincipal({ v: 1 }, "e", { codec: undefined, resolver: undef })).toBe(
      undefined
    );
  });
});

describe("storedPrincipalOf — the envelope must be sequence 0 / EXECUTION_STARTED", () => {
  const env = (over: Partial<EventEnvelope>): EventEnvelope =>
    ({
      eventId: "x",
      executionId: "e",
      sequence: 0,
      eventType: "EXECUTION_STARTED",
      payload: { principal: { v: 1 } },
      timestamp: 0,
      ...over,
    }) as EventEnvelope;

  it("a well-formed first envelope reads", () => {
    expect(storedPrincipalOf(env({})).kind).toBe("record");
  });
  it("a non-zero sequence is malformed (deny), not legacy", () => {
    expect(storedPrincipalOf(env({ sequence: 3 })).kind).toBe("malformed");
  });
  it("a different event type at sequence 0 is malformed (deny), not legacy", () => {
    expect(storedPrincipalOf(env({ eventType: "STEP_STARTED" as never })).kind).toBe("malformed");
  });
});
