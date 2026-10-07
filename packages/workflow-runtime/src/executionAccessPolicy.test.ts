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
  workflowId = "wf",
  owner?: ExecutionAuthzRequest["owner"]
): ExecutionAuthzRequest => ({
  op,
  executionId,
  workflowId,
  ...(principal && { principal }),
  ...(owner && { owner }),
});

const alice = { actor: "alice", tenant: "t1" };
const alice2 = { actor: "alice2", tenant: "t1" };
const ownerAlice = { actor: "alice", tenant: "t1" };
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

  it("a principal without a non-empty string actor can never match an owner (R12 review)", () => {
    const p = executionAccessPolicy({ rules: { query: "owner", cancel: "tenant" } });
    for (const bad of [{ actor: "", tenant: "t1" }, { tenant: "t1" }, { sub: "a" }]) {
      expect(p.authorize(req("start", bad as never)).allowed).toBe(false);
      for (const op of ["resume", "cancel", "query"] as const) {
        expect(p.authorize(req(op, bad as never, "e1", "wf", ownerAlice)).allowed).toBe(false);
      }
    }
  });

  it("tenant isolation: same tenant allowed, another tenant denied (resume/cancel/query)", () => {
    const p = executionAccessPolicy();
    for (const op of ["resume", "cancel", "query"] as const) {
      expect(p.authorize(req(op, alice2, "e1", "wf", ownerAlice)).allowed).toBe(true);
      expect(p.authorize(req(op, eve, "e1", "wf", ownerAlice)).allowed).toBe(false);
    }
  });

  it("owner scope: only the starting actor", () => {
    const p = executionAccessPolicy({
      rules: { cancel: "owner", resume: "owner", query: "owner" },
    });
    expect(p.authorize(req("cancel", alice, "e1", "wf", ownerAlice)).allowed).toBe(true);
    expect(p.authorize(req("cancel", alice2, "e1", "wf", ownerAlice)).allowed).toBe(false);
  });

  it("op-specific rules: deny closes an op; any skips ownership", () => {
    const p = executionAccessPolicy({ rules: { cancel: "deny", query: "any" } });
    expect(p.authorize(req("cancel", alice, "e1", "wf", ownerAlice)).allowed).toBe(false);
    expect(p.authorize(req("query", eve, "e1", "wf", ownerAlice)).allowed).toBe(true);
  });

  it("an execution whose owner is unknown is refused (fail-closed) unless unknownOwner:'allow'; resolveOwner answers only when the kernel supplied no owner", () => {
    expect(executionAccessPolicy().authorize(req("resume", alice, "ghost")).allowed).toBe(false);
    expect(
      executionAccessPolicy({ unknownOwner: "allow" }).authorize(req("resume", alice, "ghost"))
        .allowed
    ).toBe(true);
    const p = executionAccessPolicy({
      resolveOwner: (id) => (id === "legacy" ? { actor: "alice", tenant: "t1" } : undefined),
    });
    expect(p.authorize(req("resume", alice2, "legacy")).allowed).toBe(true);
    expect(p.authorize(req("resume", eve, "legacy")).allowed).toBe(false);
    // ADR 0111 D5 — the RECORDED owner wins over a resolver (a stale table must not override the log).
    expect(
      p.authorize(req("resume", eve, "legacy", "wf", { actor: "eve", tenant: "t2" })).allowed
    ).toBe(true);
  });

  it("actAsOwner is denied by default (a fork acts as the forker unless this op is opened), ADR 0111 D7", () => {
    const p = executionAccessPolicy();
    expect(p.authorize(req("actAsOwner", alice, "e1", "wf", ownerAlice)).allowed).toBe(false);
    const open = executionAccessPolicy({ rules: { actAsOwner: "owner" } });
    expect(open.authorize(req("actAsOwner", alice, "e1", "wf", ownerAlice)).allowed).toBe(true);
    expect(open.authorize(req("actAsOwner", alice2, "e1", "wf", ownerAlice)).allowed).toBe(false);
  });

  it("annotate (ADR 0116) is tenant-scoped by default against the recorded owner; rules can narrow it", () => {
    const p = executionAccessPolicy();
    expect(p.authorize(req("annotate", alice2, "e1", "wf", ownerAlice)).allowed).toBe(true);
    expect(p.authorize(req("annotate", eve, "e1", "wf", ownerAlice)).allowed).toBe(false);
    const own = executionAccessPolicy({ rules: { annotate: "owner" } });
    expect(own.authorize(req("annotate", alice2, "e1", "wf", ownerAlice)).allowed).toBe(false);
    expect(own.authorize(req("annotate", alice, "e1", "wf", ownerAlice)).allowed).toBe(true);
  });

  it("workflow allow-list and requireTenant", () => {
    const p = executionAccessPolicy({ allowWorkflows: ["wf"], requireTenant: true });
    expect(p.authorize(req("start", alice, "a", "wf")).allowed).toBe(true);
    expect(p.authorize(req("start", alice, "b", "other")).allowed).toBe(false);
    expect(p.authorize(req("start", { actor: "x" }, "c", "wf")).allowed).toBe(false);
  });
});
