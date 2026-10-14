import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { ReplayVM } from "@loom/replay-vm";
import { describe, expect, it } from "vitest";
import { ExecutionJournal } from "./ExecutionJournal";
import { UNKNOWN_OWNER_REASON, executionAccessPolicy } from "./executionAccessPolicy";
import type { ExecutionOp } from "./types";
import { guardUserspaceEmit } from "./userspaceEmit";

// ADR 0130 residuals, slice S1 (EVENT_SCHEMA 1.25.0, EventStore SPI 2.5.0) - what the runtime does with
// the RESERVED shapes while NO writer exists. Nothing here may change behaviour for an existing app.

const NEW_KINDS = ["INBOX_QUARANTINED", "INBOX_RELEASED"] as const;

describe("userspace cannot write the reserved kinds", () => {
  it("guardUserspaceEmit refuses both new kinds by name, with any payload", () => {
    for (const kind of NEW_KINDS) {
      expect(() => guardUserspaceEmit(kind, { topic: "t" })).toThrow(/kernel event type/);
      expect(() => guardUserspaceEmit(kind, null)).toThrow(/kernel event type/);
    }
  });
});

describe("the journal stamps metadata.kernel on exactly the kinds whose fold requires it", () => {
  const build = (eventType: string) =>
    ExecutionJournal.bootstrapEnvelope(
      { executionId: "x", workflowId: "f" },
      eventType,
      {},
      { fence: 2 }
    );

  it("stamps both new kinds, alongside the fence (the stamp the fold's gate reads)", () => {
    for (const kind of NEW_KINDS) expect(build(kind).metadata).toEqual({ fence: 2, kernel: true });
  });

  it("commit() stamps too, and the stamped fact folds (the path the S5 writer will use)", async () => {
    const store = new InMemoryAsyncEventStore();
    const vm = new ReplayVM([], { executionId: "x", workflowId: "f", workflowVersion: "1" });
    const journal = new ExecutionJournal(
      store,
      { executionId: "x", workflowId: "f" },
      vm,
      undefined,
      () => {}
    );
    journal.commit("EXECUTION_STARTED", { input: {} });
    journal.commit("INBOX_QUARANTINED", {
      topic: "chat",
      inboxSeq: 3,
      key: "k3",
      messageId: "m3",
      heldAt: 0,
      operator: { actor: "op" },
    });
    await journal.drain();
    const log = await store.read("x");
    expect(log[1]?.metadata).toEqual({ kernel: true });
    expect(vm.peekState().variables._quarantined).toEqual({
      chat: [{ key: "k3", inboxSeq: 3, heldAt: 0, state: "held" }],
    });
  });
});

describe("ExecutionOp gains quarantine / release (type only)", () => {
  const ops: ExecutionOp[] = ["quarantine", "release"];

  it("the default policy denies both, like discard, whoever asks", () => {
    const policy = executionAccessPolicy();
    const owner = { actor: "alice", tenant: "t1" };
    for (const op of [...ops, "discard"] as ExecutionOp[]) {
      expect(policy.scopes[op]).toBe("deny");
      const verdict = policy.authorize({
        op,
        executionId: "e",
        workflowId: "wf",
        principal: owner,
        owner,
      });
      expect(verdict.allowed).toBe(false);
    }
  });

  it("an integrator can open them per op, exactly as for discard", () => {
    const owner = { actor: "alice", tenant: "t1" };
    const policy = executionAccessPolicy({ rules: { quarantine: "owner", release: "tenant" } });
    const req = (op: ExecutionOp, actor: string) => ({
      op,
      executionId: "e",
      workflowId: "wf",
      principal: { actor, tenant: "t1" },
      owner,
    });
    expect(policy.authorize(req("quarantine", "alice")).allowed).toBe(true);
    expect(policy.authorize(req("quarantine", "bob")).allowed).toBe(false);
    expect(policy.authorize(req("release", "bob")).allowed).toBe(true);
  });
});

describe("UNKNOWN_OWNER_REASON", () => {
  it("is the exact string the default policy gives an execution whose owner it cannot establish", () => {
    const verdict = executionAccessPolicy().authorize({
      op: "query",
      executionId: "e",
      workflowId: "wf",
      principal: { actor: "alice", tenant: "t1" },
    });
    expect(verdict).toEqual({ allowed: false, reason: UNKNOWN_OWNER_REASON });
    expect(UNKNOWN_OWNER_REASON).toBe("the execution's owner is unknown to this policy");
  });
});
