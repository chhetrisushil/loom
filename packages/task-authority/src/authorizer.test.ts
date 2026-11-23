import {
  type CapabilityAuthorizer,
  type CapabilityRequest,
  GrantTable,
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
