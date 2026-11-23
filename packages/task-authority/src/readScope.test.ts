import { type CapabilityRequest, EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import { describe, expect, it } from "vitest";
import { TASK_GRANT_DENIAL, TaskGrantAuthorizer } from "./authorizer";
import { type UnsignedTaskGrant, signTaskGrant } from "./grant";

// ADR 0150 D8: the authorizer's `reads` check for an effect that declares `capabilities.read`.
const SECRET = "rs";
const NOW = 1_000;
const grant = (reads?: string[]) =>
  signTaskGrant(SECRET, {
    taskId: "t",
    rootId: "t",
    issuedTo: "a",
    effects: ["mem.recall", "plain"],
    leases: {},
    exp: NOW + 1000,
    epoch: 0,
    ...(reads !== undefined && { reads }),
  } as UnsignedTaskGrant);
const authz = new TaskGrantAuthorizer({
  secret: SECRET,
  base: { authorize: () => ({ allowed: true }) },
  now: () => NOW,
});
const req = (reads: string[] | undefined, over: Record<string, unknown> = {}) =>
  authz.authorize({
    toolId: "mem.recall",
    resource: "user/1",
    read: true,
    executionId: "e",
    workflowId: "w",
    stepId: "s",
    principal: { actor: "a", taskGrant: grant(reads) },
    ...over,
  } as CapabilityRequest);

describe("TaskGrantAuthorizer reads (D8)", () => {
  // kills: a check that never runs, or one that inverts the match
  it("a read covered by a glob over <toolId>:<resource> is allowed", () => {
    expect(req(["mem.recall:user/*"])).toEqual({ allowed: true });
    expect(req(["mem.recall:user/1"])).toEqual({ allowed: true });
  });

  // kills: absent reads meaning allow-all (the ruling: own-lineage reads are not exempt either)
  it("absent or empty reads covers nothing", () => {
    for (const r of [undefined, []]) {
      const d = req(r);
      expect(d.allowed).toBe(false);
      expect(d.reason).toMatch(new RegExp(`^${TASK_GRANT_DENIAL.readScope}:`));
    }
  });

  // kills: matching the bare toolId, another tool's entry, or a prefix without the glob
  it("a read outside every entry is denied", () => {
    for (const r of [["mem.recall:other/*"], ["other:user/1"], ["mem.recall:user"]])
      expect(req(r).reason).toMatch(/^task-grant:read-scope:/);
  });

  // kills: a resource-less read slipping through an `x:*` entry
  it("a read with no resource is not covered by a resource glob", () => {
    expect(req(["mem.recall:*"], { resource: undefined }).allowed).toBe(false);
  });

  // kills: applying the check to every effect (writes and plain tools have no reads to be covered by)
  it("an effect that is not declared a read is not checked (documented residual)", () => {
    expect(req(undefined, { toolId: "plain", resource: undefined, read: undefined })).toEqual({
      allowed: true,
    });
  });

  // kills: a runtime that lets the caller or an unmarked effect decide the flag
  it("the runtime sets `read` from the registered effect's capabilities, never from the caller", async () => {
    const seen: CapabilityRequest[] = [];
    const rt = new EffectRuntime([], {
      authorizer: {
        authorize: (r) => {
          seen.push(r);
          return { allowed: true };
        },
      },
    });
    rt.register("r", new ToolEffect(async () => 1, { capabilities: { read: true } }));
    rt.register("w", new ToolEffect(async () => 1));
    const ctx = { executionId: "e", workflowId: "w", stepId: "s", emit: () => {} } as never;
    await rt.execute("r", {}, ctx);
    await rt.execute("w", {}, ctx);
    expect(seen.map((r) => r.read)).toEqual([true, undefined]);
  });
});
