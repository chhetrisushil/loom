import {
  type CapabilityAuthorizer,
  type CapabilityRequest,
  EffectRuntime,
  GrantTable,
  ToolEffect,
} from "@loomwork/effect-runtime";
import { describe, expect, it } from "vitest";
import { TASK_GRANT_DENIAL, TaskGrantAuthorizer } from "./authorizer";
import { type TaskGrant, type UnsignedTaskGrant, signTaskGrant } from "./grant";

const SECRET = "s3cret";
const NOW = 1_000_000;
const unsigned = (over: Partial<UnsignedTaskGrant> = {}): UnsignedTaskGrant => ({
  taskId: "t1",
  rootId: "t1",
  issuedTo: "agent-a",
  effects: ["db.read"],
  leases: {},
  exp: NOW + 1000,
  epoch: 0,
  ...over,
});
const grant = (over: Partial<UnsignedTaskGrant> = {}, secret = SECRET): TaskGrant =>
  signTaskGrant(secret, unsigned(over));
const base = new GrantTable({ wf: ["db.read", "db.write", "mcp.invoke:srv/a"] });
const authz = (b: CapabilityAuthorizer = base) =>
  new TaskGrantAuthorizer({ secret: SECRET, base: b, now: () => NOW });
const req = (
  taskGrant?: unknown,
  over: Partial<CapabilityRequest> = {},
  actor: string | null = "agent-a"
): CapabilityRequest => ({
  toolId: "db.read",
  executionId: "e",
  workflowId: "wf",
  stepId: "s",
  principal: { ...(actor !== null && { actor }), ...(taskGrant !== undefined && { taskGrant }) },
  ...over,
});

describe("TaskGrantAuthorizer", () => {
  it("throws without a base or a secret", () => {
    // biome-ignore lint/suspicious/noExplicitAny: JS callers bypass the type
    expect(() => new TaskGrantAuthorizer({ secret: SECRET } as any)).toThrow(/base/);
    // biome-ignore lint/suspicious/noExplicitAny: JS callers bypass the type
    expect(() => new TaskGrantAuthorizer({ secret: SECRET, base: null } as any)).toThrow(/base/);
    expect(() => new TaskGrantAuthorizer({ secret: "", base })).toThrow(/secret/);
  });

  it("allows an in-scope, held, unexpired grant that base also allows", () => {
    expect(authz().authorize(req(grant()))).toEqual({ allowed: true });
  });

  it("no grant: base decides, allowed and denied", () => {
    expect(authz().authorize(req())).toEqual({ allowed: true });
    const d = authz().authorize(req(undefined, { workflowId: "other" }));
    expect(d.allowed).toBe(false);
    expect(d.reason).not.toMatch(/^task-grant:/);
    const { principal: _p, ...noPrincipal } = req();
    expect(authz().authorize(noPrincipal).allowed).toBe(true);
  });

  it("denies a self-minted grant whose effects are outside base", () => {
    const g = grant({ effects: ["db.drop"] });
    const d = authz().authorize(req(g, { toolId: "db.drop" }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(new RegExp(`^${TASK_GRANT_DENIAL.base}`));
  });

  it("denies a blocked principal before looking at the grant", () => {
    for (const flag of [{ delegationUnresolved: "d" }, { principalShredded: true as const }]) {
      const r = req(grant());
      r.principal = { ...r.principal, ...flag };
      const d = authz().authorize(r);
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(new RegExp(`^${TASK_GRANT_DENIAL.blocked}`));
    }
    const r = req("garbage");
    r.principal = { ...r.principal, principalShredded: true };
    expect(authz().authorize(r).reason).toMatch(/^task-grant:blocked/);
  });

  it("denies malformed taskGrant values without throwing, never falling through to base", () => {
    const thrower = {};
    Object.defineProperty(thrower, "taskId", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    for (const bad of [null, "x", 7, [], {}, thrower, { ...grant(), effects: "*" }]) {
      const r = req(bad);
      r.principal = { actor: "agent-a", taskGrant: bad };
      const d = authz().authorize(r);
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/^task-grant:shape/);
    }
  });

  it("decides from the verified snapshot: a getter widening effects after the first read gains nothing", () => {
    const g = grant();
    let reads = 0;
    const sneaky = { ...g };
    Object.defineProperty(sneaky, "effects", {
      enumerable: true,
      get: () => (++reads === 1 ? ["db.read"] : ["db.read", "db.write"]),
    });
    const d = authz().authorize(req(sneaky, { toolId: "db.write" }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/^task-grant:scope/);
  });

  it("snapshot wins over getters on issuedTo and exp", () => {
    const flip = (field: string, first: unknown, later: unknown): TaskGrant => {
      const sneaky = { ...grant() } as Record<string, unknown>;
      let reads = 0;
      Object.defineProperty(sneaky, field, {
        enumerable: true,
        get: () => (++reads === 1 ? first : later),
      });
      return sneaky as unknown as TaskGrant;
    };
    // issuedTo: signed value first, "mallory" afterwards; the actor is the signed holder
    expect(authz().authorize(req(flip("issuedTo", "agent-a", "mallory"))).allowed).toBe(true);
    // ... and the reverse cannot let mallory in
    expect(
      authz().authorize(req(flip("issuedTo", "agent-a", "mallory"), {}, "mallory")).allowed
    ).toBe(false);
    // exp: signed (expired) value first, far future afterwards: still expired or signature-denied
    const exp = authz().authorize(req(flip("exp", NOW, NOW + 1e9)));
    expect(exp.allowed).toBe(false);
  });

  it("an actor getter that changes between reads cannot pass the check with one value and show base another", () => {
    let reads = 0;
    const seen: unknown[] = [];
    const spy: CapabilityAuthorizer = {
      authorize: (r) => {
        seen.push(r.principal?.actor, r.principal?.actor);
        return { allowed: true };
      },
    };
    const r = req(grant());
    const principal = { taskGrant: grant() } as Record<string, unknown>;
    Object.defineProperty(principal, "actor", {
      enumerable: true,
      get: () => (++reads === 1 ? "agent-a" : "mallory"),
    });
    r.principal = principal;
    const d = authz(spy).authorize(r);
    if (d.allowed) expect(seen).toEqual(["agent-a", "agent-a"]);
    expect(d.allowed).toBe(true);
  });

  it("is total: base throwing (no grant and grant paths) is task-grant:error, no throw", () => {
    const boom: CapabilityAuthorizer = {
      authorize: () => {
        throw new Error("secret detail ".repeat(10000));
      },
    };
    for (const r of [req(), req(grant())]) {
      const d = authz(boom).authorize(r);
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/^task-grant:error/);
      expect(d.reason).not.toMatch(/secret detail/);
    }
    const nullProto: CapabilityAuthorizer = {
      authorize: () => {
        throw Object.create(null);
      },
    };
    expect(authz(nullProto).authorize(req(grant())).reason).toMatch(/^task-grant:error/);
    const badDecision = { authorize: () => null } as unknown as CapabilityAuthorizer;
    expect(authz(badDecision).authorize(req(grant())).allowed).toBe(false);
  });

  it("is total: a throwing clock and a throwing Proxy principal deny", () => {
    const clock = new TaskGrantAuthorizer({
      secret: SECRET,
      base,
      now: () => {
        throw new Error("clock");
      },
    });
    expect(clock.authorize(req(grant())).reason).toMatch(/^task-grant:error/);
    const r = req(grant());
    r.principal = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
      }
    );
    const d = authz().authorize(r);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/^task-grant:error/);
  });

  it("a NaN or non-numeric clock denies as expired", () => {
    for (const t of [Number.NaN, "5", undefined, Number.POSITIVE_INFINITY] as unknown[]) {
      const a = new TaskGrantAuthorizer({ secret: SECRET, base, now: () => t as number });
      const d = a.authorize(req(grant({ exp: 1 })));
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/^task-grant:expired/);
      expect(a.authorize(req(grant({ exp: 2 ** 52 }))).allowed).toBe(false);
    }
  });

  it("bounds live values in a denial reason (1 MB actor)", () => {
    const d = authz().authorize(req(grant(), {}, "x".repeat(1_000_000)));
    expect(d.reason).toMatch(/^task-grant:holder/);
    expect((d.reason ?? "").length).toBeLessThanOrEqual(400);
    expect(d.reason).toContain("…");
    const deny = { authorize: () => ({ allowed: false, reason: "y".repeat(1_000_000) }) };
    expect((authz(deny).authorize(req(grant())).reason ?? "").length).toBeLessThanOrEqual(400);
  });

  it("copies its options: later mutation does not swap base or secret", () => {
    const opts: { secret: string; base: CapabilityAuthorizer; now: () => number } = {
      secret: SECRET,
      base,
      now: () => NOW,
    };
    const a = new TaskGrantAuthorizer(opts);
    opts.secret = "other";
    opts.base = { authorize: () => ({ allowed: false, reason: "swapped" }) };
    expect(a.authorize(req(grant())).allowed).toBe(true);
  });

  it("denies a bad signature (tampered field, wrong secret)", () => {
    const g = grant();
    for (const bad of [{ ...g, effects: ["db.read", "db.write"] }, grant({}, "other")]) {
      const d = authz().authorize(req(bad));
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(/^task-grant:signature/);
    }
  });

  it("denies at exactly exp and allows one ms before", () => {
    const g = grant({ exp: NOW });
    const d = authz().authorize(req(g));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/^task-grant:expired/);
    expect(authz().authorize(req(grant({ exp: NOW + 1 }))).allowed).toBe(true);
  });

  it("denies a holder mismatch, including a missing actor", () => {
    expect(authz().authorize(req(grant(), {}, "mallory")).reason).toMatch(/^task-grant:holder/);
    const d = authz().authorize(req(grant(), {}, null));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/^task-grant:holder/);
  });

  it("denies an effect outside the grant scope, exact match only", () => {
    const d = authz().authorize(req(grant(), { toolId: "db.write" }));
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/^task-grant:scope/);
    const prefix = authz().authorize(req(grant({ effects: ["db.*"] }), { toolId: "db.read" }));
    expect(prefix.reason).toMatch(/^task-grant:scope/);
  });

  it("scopes <toolId>:<resource> to that resource; a bare toolId covers every resource", () => {
    const narrow = grant({ effects: ["mcp.invoke:srv/a"] });
    const call = (g: TaskGrant, resource: string) =>
      authz().authorize(req(g, { toolId: "mcp.invoke", resource }));
    expect(call(narrow, "srv/a").allowed).toBe(true);
    expect(call(narrow, "srv/b").reason).toMatch(/^task-grant:scope/);
    const bare = grant({ effects: ["mcp.invoke"] });
    expect(call(bare, "srv/a").allowed).toBe(true);
    // base still bounds: srv/b is in the grant's bare scope but not in base
    expect(call(bare, "srv/b").reason).toMatch(/^task-grant:base/);
  });

  it("never throws, even when base throws-free denies", () => {
    const deny: CapabilityAuthorizer = { authorize: () => ({ allowed: false, reason: "no" }) };
    const d = authz(deny).authorize(req(grant()));
    expect(d).toEqual({ allowed: false, reason: expect.stringMatching(/^task-grant:base.*no/) });
  });
});

describe("TaskGrantAuthorizer identity (R34)", () => {
  const byTenant = (t: string): CapabilityAuthorizer => ({
    authorize: (r) => ({ allowed: r.principal?.tenant === t }),
  });
  const withId = (g: TaskGrant, id: { tenant?: string; onBehalfOf?: string }) => {
    const r = req(g);
    r.principal = { ...r.principal, ...id };
    return r;
  };
  const acme = (): TaskGrant => grant({ tenant: "acme", onBehalfOf: "u1" });
  it("denies a chain naming another tenant, though the base would allow that tenant", () => {
    const d = authz(byTenant("globex")).authorize(
      withId(acme(), { tenant: "globex", onBehalfOf: "u1" })
    );
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(new RegExp(`^${TASK_GRANT_DENIAL.identity}`));
  });
  it("denies a different onBehalfOf, a missing identity, and an identity on an identity-free grant", () => {
    const a = authz(byTenant("acme"));
    for (const r of [
      withId(acme(), { tenant: "acme", onBehalfOf: "u2" }),
      withId(acme(), { tenant: "acme" }),
      withId(acme(), {}),
      withId(grant(), { tenant: "acme" }),
    ])
      expect(a.authorize(r).reason).toMatch(/^task-grant:identity/);
  });
  it("allows the honest chain", () => {
    expect(
      authz(byTenant("acme")).authorize(withId(acme(), { tenant: "acme", onBehalfOf: "u1" }))
        .allowed
    ).toBe(true);
    expect(authz().authorize(req(grant())).allowed).toBe(true); // both absent
  });
  it("is enforced on the transient path too (invokeTransient skips the codec)", async () => {
    const effects = new EffectRuntime([], { authorizer: authz(byTenant("globex")) });
    effects.register("db.read", new ToolEffect(async () => ({ ok: true })));
    const g = acme();
    await expect(
      effects.invokeTransient(
        "db.read",
        {},
        { principal: { actor: "agent-a", taskGrant: g, tenant: "globex", onBehalfOf: "u1" } }
      )
    ).rejects.toThrow(/task-grant:identity/);
    const honest = new EffectRuntime([], { authorizer: authz(byTenant("acme")) });
    honest.register("db.read", new ToolEffect(async () => ({ ok: true })));
    await expect(
      honest.invokeTransient(
        "db.read",
        {},
        { principal: { actor: "agent-a", taskGrant: g, tenant: "acme", onBehalfOf: "u1" } }
      )
    ).resolves.toEqual({ ok: true });
  });
});
