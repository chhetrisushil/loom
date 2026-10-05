import { runExecutionAuthorizerConformance } from "@loom/conformance";
import { describe, expect, it } from "vitest";
import { executionAccessPolicy } from "./executionAccessPolicy";
import type { ExecutionAuthzRequest, ExecutionOp } from "./types";

runExecutionAuthorizerConformance(() => executionAccessPolicy(), "executionAccessPolicy");
runExecutionAuthorizerConformance(
  () => executionAccessPolicy({ allowAnonymous: true }),
  "executionAccessPolicy(allowAnonymous)"
);

const req = (
  op: ExecutionOp,
  principal: ExecutionAuthzRequest["principal"],
  executionId = "e1",
  workflowId = "wf"
): ExecutionAuthzRequest => ({ op, executionId, workflowId, ...(principal && { principal }) });

/** A start the runtime committed: authorize, then the durable-start notification. */
const startOf = (
  p: ReturnType<typeof executionAccessPolicy>,
  principal: ExecutionAuthzRequest["principal"],
  id = "e1"
): void => {
  const r = req("start", principal, id);
  if (p.authorize(r).allowed) p.committed?.(r);
};

const alice = { actor: "alice", tenant: "t1" };
const alice2 = { actor: "alice2", tenant: "t1" };
const eve = { actor: "eve", tenant: "t2" };

describe("executionAccessPolicy", () => {
  it("denies anonymous (principal-less, or an empty principal) by default; allowAnonymous opts in", () => {
    const p = executionAccessPolicy();
    for (const op of ["start", "resume", "cancel", "query"] as const) {
      expect(p.authorize(req(op, undefined)).allowed).toBe(false);
      expect(p.authorize(req(op, {})).allowed).toBe(false);
    }
    expect(
      executionAccessPolicy({ allowAnonymous: true }).authorize(req("start", undefined)).allowed
    ).toBe(true);
  });

  it("a principal without a non-empty string actor can never match another such principal (R12 review)", () => {
    const p = executionAccessPolicy({ rules: { query: "owner", cancel: "tenant" } });
    for (const bad of [{ actor: "", tenant: "t1" }, { tenant: "t1" }, { sub: "a" }]) {
      const r = req("start", bad as never);
      expect(p.authorize(r).allowed).toBe(false);
      p.committed?.(r);
      for (const op of ["resume", "cancel", "query"] as const) {
        expect(p.authorize(req(op, bad as never)).allowed).toBe(false);
      }
    }
    expect(p.tracked).toBe(0);
  });

  it("tenant isolation: same tenant allowed, another tenant denied (resume/cancel/query)", () => {
    const p = executionAccessPolicy();
    startOf(p, alice);
    for (const op of ["resume", "cancel", "query"] as const) {
      expect(p.authorize(req(op, alice2)).allowed).toBe(true);
      const d = p.authorize(req(op, eve));
      expect(d.allowed).toBe(false);
    }
  });

  it("owner scope: only the starting actor", () => {
    const p = executionAccessPolicy({
      rules: { cancel: "owner", resume: "owner", query: "owner" },
    });
    startOf(p, alice);
    expect(p.authorize(req("cancel", alice)).allowed).toBe(true);
    expect(p.authorize(req("cancel", alice2)).allowed).toBe(false);
  });

  it("op-specific rules: deny closes an op; any skips ownership", () => {
    const p = executionAccessPolicy({ rules: { cancel: "deny", query: "any" } });
    startOf(p, alice);
    expect(p.authorize(req("cancel", alice)).allowed).toBe(false);
    expect(p.authorize(req("query", eve)).allowed).toBe(true);
  });

  it("an execution whose owner is unknown is refused (fail-closed) unless unknownOwner:'allow'; resolveOwner answers first", () => {
    expect(executionAccessPolicy().authorize(req("resume", alice, "ghost")).allowed).toBe(false);
    expect(
      executionAccessPolicy({ unknownOwner: "allow" }).authorize(req("resume", alice, "ghost"))
        .allowed
    ).toBe(true);
    const p = executionAccessPolicy({
      resolveOwner: (id) => (id === "durable" ? { actor: "alice", tenant: "t1" } : undefined),
    });
    expect(p.authorize(req("resume", alice2, "durable")).allowed).toBe(true);
    expect(p.authorize(req("resume", eve, "durable")).allowed).toBe(false);
  });

  it("first writer wins: a later start naming a known id cannot re-assign its owner", () => {
    const p = executionAccessPolicy();
    startOf(p, alice, "e9");
    startOf(p, eve, "e9");
    expect(p.ownerOf("e9")).toEqual({ actor: "alice", tenant: "t1" });
    expect(p.authorize(req("resume", eve, "e9")).allowed).toBe(false);
  });

  it("workflow allow-list and requireTenant", () => {
    const p = executionAccessPolicy({ allowWorkflows: ["wf"], requireTenant: true });
    expect(p.authorize(req("start", alice, "a", "wf")).allowed).toBe(true);
    expect(p.authorize(req("start", alice, "b", "other")).allowed).toBe(false);
    expect(p.authorize(req("start", { actor: "x" }, "c", "wf")).allowed).toBe(false);
  });

  it("tracked owners are bounded and NEVER evicted: a full table refuses the next start", () => {
    const p = executionAccessPolicy({ maxTracked: 2 });
    for (const id of ["a", "b"]) startOf(p, alice, id);
    expect(p.authorize(req("start", alice, "c")).allowed).toBe(false);
    startOf(p, alice, "c");
    expect(p.tracked).toBe(2);
    expect(p.ownerOf("a")).toEqual({ actor: "alice", tenant: "t1" });
    expect(p.ownerOf("c")).toBeUndefined();
    expect(() => executionAccessPolicy({ maxTracked: 0 })).toThrow();
  });
});
