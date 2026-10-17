import {
  type EventStore,
  InMemoryAsyncEventStore,
  InMemoryTimerStore,
  brandPayloadShredded,
  isPayloadShredded,
} from "@loom/event-runtime";
import {
  EncryptingEventStore,
  InMemoryKeyStore,
  PayloadShreddedError,
  shredSubject,
} from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { syntheticShredded } from "./WorkflowRuntime";
import { build, echo, flow } from "./__tests__/r2Harness";
import { executionAccessPolicy } from "./executionAccessPolicy";

// ADR 0039 (amendment 2026-10-17 (c)): a shredded payload is recognised by a realm-safe BRAND
// (`Symbol.for("loom.payloadShredded")`), never by the error's `name` alone. On the authorization
// path "erasure" means "unknown owner", which `unknownOwner: "allow"` ADMITS a stranger on, so an
// Error that merely NAMES itself `PayloadShreddedError` (a store decorator, a third-party store) must
// be a FAULT (retryable, nobody admitted), while the real class, and a branded instance from a SECOND
// copy of the package, stay an erasure.

const OWNER = { actor: "alice", tenant: "t1" };
const STRANGER = { actor: "mallory", tenant: "t9" };
const E = "brand-1";

const parked = () =>
  flow("brand", async (ctx) => {
    await ctx.run(echo, { v: 1 });
    await ctx.suspend({ on: "Go" });
    return null;
  });

/** A "second copy" of the real error class: same name, same Symbol.for brand, NOT instanceof ours. */
class SecondCopyShredded extends Error {
  constructor() {
    super("shredded (second copy)");
    this.name = "PayloadShreddedError";
    Object.defineProperty(this, Symbol.for("loom.payloadShredded"), { value: true });
  }
}
const plainNamed = () =>
  Object.assign(new Error("forged erasure"), { name: "PayloadShreddedError" });

const denyAll = { rules: {} };

function node(store: EventStore, unknownOwner: "allow" | "deny", reports?: unknown[]) {
  const f = parked();
  const h = build(
    {
      executionAuthorizer: executionAccessPolicy({ ...denyAll, unknownOwner }),
      executionAuthz: { requirePrincipal: true },
      ...(reports !== undefined && {
        onStorageError: (_id: string, e: unknown) => reports.push(e),
      }),
    } as never,
    { eventStore: store, timers: new InMemoryTimerStore() }
  );
  h.rt.registerFlow(f.definition, f.runner);
  return { h, f };
}

/** A store that throws `make()` from the sequence-0 anchor read of E while `fault.on`. */
function faulting(inner: EventStore, fault: { on: boolean; make: () => unknown }): EventStore {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        if (prop === "readRange" && fault.on && args[0] === E && args[1] === 0 && args[2] === 0) {
          throw fault.make();
        }
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as EventStore;
}

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => ({ ok: true }) as const,
    (e: unknown) => e
  );
const nameOf = (e: unknown): unknown => (e as { name?: unknown } | null)?.name;

async function seeded() {
  const inner = new InMemoryAsyncEventStore();
  const fault = { on: false, make: plainNamed as () => unknown };
  const store = faulting(inner, fault);
  // another node wrote the execution, so the node under test has no in-memory start record
  const writer = node(inner, "deny");
  await (
    await writer.h.rt.start(writer.f, {}, { executionId: E, principal: OWNER })
  ).waitForSuspend();
  return { inner, store, fault };
}

describe("the predicate", () => {
  it("requires the brand: a name alone is not enough, the real class and a second copy are", () => {
    expect(isPayloadShredded(plainNamed())).toBe(false);
    expect(isPayloadShredded({ name: "PayloadShreddedError" })).toBe(false);
    expect(isPayloadShredded(JSON.parse(JSON.stringify(new PayloadShreddedError("s", "e"))))).toBe(
      false
    );
    expect(isPayloadShredded(null)).toBe(false);
    expect(isPayloadShredded("PayloadShreddedError")).toBe(false);
    expect(isPayloadShredded(new PayloadShreddedError("s", "e"))).toBe(true);
    expect(isPayloadShredded(new SecondCopyShredded())).toBe(true);
    expect(isPayloadShredded(brandPayloadShredded(plainNamed()))).toBe(true);
  });

  it("keeps the error name and serialized shape unchanged (the brand is a non-enumerable symbol)", () => {
    const e = new PayloadShreddedError("s", "e");
    expect(e.name).toBe("PayloadShreddedError");
    expect(Object.keys(e).sort()).toEqual(["executionId", "name", "redacted", "subjectId"]);
    expect(Object.getOwnPropertySymbols(e)).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(e))).toEqual({
      name: "PayloadShreddedError",
      subjectId: "s",
      executionId: "e",
    });
  });
});

describe("the sequence-0 anchor read (ownerForAuthz / recordedPrincipal)", () => {
  for (const unknownOwner of ["allow", "deny"] as const) {
    it(`an Error only NAMED PayloadShreddedError is a FAULT under unknownOwner '${unknownOwner}': owner and stranger get the retryable error, nobody is admitted`, async () => {
      const w = await seeded();
      const reports: unknown[] = [];
      const n = node(w.store, unknownOwner, reports);
      w.fault.on = true;
      w.fault.make = plainNamed;
      for (const who of [OWNER, STRANGER]) {
        const err = await rejection(n.h.rt.loadState(E, { principal: who }));
        expect(nameOf(err), who.actor).toBe("ExecutionStoreUnavailableError");
      }
      expect(reports.length).toBeGreaterThan(0);
    });
  }

  for (const [label, make] of [
    ["the real PayloadShreddedError", () => new PayloadShreddedError("alice", E)],
    ["a branded instance from a SECOND copy of the class", () => new SecondCopyShredded()],
  ] as const) {
    it(`${label} IS an erasure: unknown owner, so the policy decides (allow admits, deny refuses)`, async () => {
      const w = await seeded();
      w.fault.on = true;
      w.fault.make = make;
      const allow = node(w.store, "allow");
      const admitted = await rejection(allow.h.rt.loadState(E, { principal: STRANGER }));
      expect(nameOf(admitted)).not.toBe("ExecutionStoreUnavailableError");
      expect(nameOf(admitted)).not.toBe("ExecutionDeniedError");
      const deny = node(w.store, "deny");
      const denied = await rejection(deny.h.rt.loadState(E, { principal: STRANGER }));
      expect(nameOf(denied)).toBe("ExecutionDeniedError");
    });
  }
});

describe("the cancel redacted fold", () => {
  // An erased owner (sealed principal) under `unknownOwner: "allow"`: cancel is authorized, then folds
  // the REDACTED view the erasure error carries. The full fold (`read`) is where the error is
  // reclassified here, so the anchor read stays the real, branded one.
  async function erased(convert: (e: PayloadShreddedError) => unknown) {
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const events = new EncryptingEventStore(inner, keys, {
      sensitive: {
        EXECUTION_STARTED: ["principal.identity.tenant", "principal.identity.actor"],
        STEP_COMPLETED: ["output"],
      },
    });
    const opts = { principalIdentity: "encrypted" };
    const mk = (store: EventStore) => {
      const f = parked();
      const h = build(
        {
          ...opts,
          executionAuthorizer: executionAccessPolicy({ ...denyAll, unknownOwner: "allow" }),
          executionAuthz: { requirePrincipal: true },
        } as never,
        { eventStore: store, timers: new InMemoryTimerStore() }
      );
      h.rt.registerFlow(f.definition, f.runner);
      return { h, f };
    };
    const w = mk(events);
    await (await w.h.rt.start(w.f, {}, { executionId: E, principal: OWNER })).waitForSuspend();
    await shredSubject(keys, inner, E, { snapshotStore: { loadLatest: async () => null } });
    const converting = new Proxy(events, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (prop !== "read" || typeof v !== "function") return v;
        return async (...args: unknown[]) => {
          try {
            return await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          } catch (err) {
            throw err instanceof PayloadShreddedError ? convert(err) : err;
          }
        };
      },
    }) as unknown as EventStore;
    return mk(converting);
  }

  it("works for the real erasure error and for a branded second-copy instance carrying the view", async () => {
    for (const convert of [
      (e: PayloadShreddedError) => e,
      (e: PayloadShreddedError) =>
        Object.assign(new SecondCopyShredded(), { subjectId: e.subjectId, redacted: e.redacted }),
    ]) {
      const n = await erased(convert);
      const res = await rejection(n.h.rt.cancel(E, "operator", { principal: STRANGER }));
      expect(res, String(nameOf(res))).toEqual({ ok: true });
    }
  });

  it("an Error only NAMED PayloadShreddedError is NOT folded as a redacted view: cancel rethrows it", async () => {
    const n = await erased((e) =>
      Object.assign(plainNamed(), { subjectId: e.subjectId, redacted: e.redacted })
    );
    const res = await rejection(n.h.rt.cancel(E, "operator", { principal: STRANGER }));
    expect(nameOf(res)).toBe("PayloadShreddedError");
    expect(isPayloadShredded(res)).toBe(false);
  });
});

describe("brandPayloadShredded / isPayloadShredded hardening", () => {
  it("a frozen error does not throw: a branded wrapper (same name/message/fields, cause = original) is returned", () => {
    const frozen = Object.freeze(
      Object.assign(new Error("gone"), { name: "PayloadShreddedError", subjectId: "s" })
    );
    const out = brandPayloadShredded(frozen);
    expect(isPayloadShredded(out)).toBe(true);
    expect(out).not.toBe(frozen);
    expect(out.name).toBe("PayloadShreddedError");
    expect(out.message).toBe("gone");
    expect((out as unknown as { subjectId: string }).subjectId).toBe("s");
    expect((out as Error & { cause?: unknown }).cause).toBe(frozen);
    expect(isPayloadShredded(frozen)).toBe(false);
  });

  it("an extensible error is branded in place", () => {
    const e = new Error("x");
    expect(brandPayloadShredded(e)).toBe(e);
    expect(isPayloadShredded(e)).toBe(true);
  });

  it("a prototype-inherited brand is NOT recognised; non-objects are false", () => {
    const proto = brandPayloadShredded({});
    expect(isPayloadShredded(proto)).toBe(true);
    expect(isPayloadShredded(Object.create(proto))).toBe(false);
    for (const v of [undefined, null, 1, true, "x", Symbol("s")])
      expect(isPayloadShredded(v)).toBe(false);
  });
});

describe("the kernel's own synthetic erasure error (built from a PAYLOAD_SHREDDED tombstone)", () => {
  it("syntheticShredded output is branded, keeps the name and fields", () => {
    const e = syntheticShredded("boom", "subj", "ex-1") as Error & {
      subjectId?: unknown;
      executionId?: unknown;
    };
    expect(isPayloadShredded(e)).toBe(true);
    expect(e.name).toBe("PayloadShreddedError");
    expect(e.subjectId).toBe("subj");
    expect(e.executionId).toBe("ex-1");
  });
});

describe("a real crypto shred surfaces as an erasure", () => {
  it("the real crypto shred, end to end, is recognised by the kernel and by the predicate", async () => {
    const inner = new InMemoryAsyncEventStore();
    const keys = new InMemoryKeyStore();
    const events = new EncryptingEventStore(inner, keys, {
      sensitive: { STEP_COMPLETED: ["output"] },
    });
    const n = node(events, "deny");
    await (await n.h.rt.start(n.f, {}, { executionId: E, principal: OWNER })).waitForSuspend();
    await shredSubject(keys, inner, E, { snapshotStore: { loadLatest: async () => null } });
    const err = await rejection(n.h.rt.loadState(E, { principal: OWNER }));
    expect(nameOf(err)).toBe("PayloadShreddedError");
    expect(isPayloadShredded(err)).toBe(true);
  });
});
