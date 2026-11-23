import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { ReplayVM } from "@loomwork/replay-vm";
import { describe, expect, it } from "vitest";
import { ExecutionJournal } from "./ExecutionJournal";

// ADR 0152 R11 - the journal is the one committer: a TRACKED run's channel value is scanned once at commit and
// recorded in the envelope metadata; the caller cannot set the record; an untracked run records nothing.

const T = (origin: string, value: unknown = 1) => ({ __loomTainted: { origin }, value });
const STAMP = { maxOrigins: 8, maxScanNodes: 1000 };

function rig(stamped: boolean) {
  const store = new InMemoryAsyncEventStore();
  const vm = new ReplayVM([]);
  const journal = new ExecutionJournal(
    store,
    { executionId: "e", workflowId: "f" },
    vm,
    undefined,
    () => {}
  );
  journal.commit("EXECUTION_STARTED", {
    input: T("in"),
    ...(stamped && { seenOriginsLimits: STAMP }),
  });
  return { store, journal, vm };
}
const keyOf = (vm: ReplayVM) =>
  vm.peekState().variables._seenOrigins as { origins: string[]; overflow?: true; through: number };

describe("ExecutionJournal records seen origins at commit", () => {
  it("commit: a tracked run records the origins of a channel value, once, and the fold unions them", () => {
    const { journal, vm } = rig(true);
    const e = journal.commit("STEP_COMPLETED", {
      stepId: "s",
      output: { a: T("tool:x"), b: T("tool:a") },
    });
    expect(e.metadata).toEqual({ origins: ["tool:a", "tool:x"] });
    expect(keyOf(vm)).toMatchObject({ origins: ["in", "tool:a", "tool:x"], through: 1 });
    // clean value: R13 records it EMPTY (absent would read as "not scanned" = overflow)
    expect(journal.commit("STEP_COMPLETED", { stepId: "t", output: "clean" }).metadata).toEqual({
      origins: [],
    });
  });
  it("an untracked run (no stamp) records nothing and folds no key", () => {
    const { journal, vm } = rig(false);
    const e = journal.commit("STEP_COMPLETED", { stepId: "s", output: T("tool:x") });
    expect(e.metadata).toBeUndefined();
    expect(vm.peekState().variables._seenOrigins).toBeUndefined();
  });
  it("commitAtomic: each envelope is scanned against the state after the earlier ones (dedupe window, park state)", () => {
    const { journal, vm } = rig(true);
    const mc = (id: string, p: unknown) => ({
      eventType: "MESSAGE_CONSUMED",
      payload: { waitId: "w", topic: "t", messageId: id, inboxSeq: 0, payload: p },
    });
    const out = journal.commitAtomic([
      mc("m1", T("lineage:A")),
      mc("m1", T("lineage:B")), // duplicate of the first: delivered nothing
      { eventType: "EXECUTION_RESUMED", payload: T("human") },
    ]);
    expect(out[0]?.metadata).toMatchObject({ kernel: true, origins: ["inbox:t", "lineage:A"] });
    expect(out[1]?.metadata).toEqual({ kernel: true, origins: [] });
    expect(out[2]?.metadata).toEqual({ origins: ["human"] });
    expect(keyOf(vm).origins).toEqual(["in", "inbox:t", "lineage:A", "human"]);
  });
  it("a caller-supplied origins / originsOverflow in metadata never reaches the log", () => {
    const { journal, vm } = rig(true);
    const e = journal.commit(
      "DECISION_RECORDED",
      { decisionId: "d", choice: "clean" },
      {
        metadata: { origins: ["forged"], originsOverflow: true },
      }
    );
    expect(e.metadata).toEqual({ origins: [] });
    expect(keyOf(vm).overflow).toBeUndefined();
    const u = rig(false).journal.commit("APP", {}, { metadata: { origins: ["forged"] } });
    expect(u.metadata).toEqual({});
  });
  it("an exceeded scan records originsOverflow only; a payload key named origins is plain data", () => {
    const { journal, vm } = rig(true);
    const big = Array.from({ length: 2000 }, (_, i) => i);
    expect(
      journal.commit("STEP_COMPLETED", { stepId: "s", output: [T("p"), ...big] }).metadata
    ).toEqual({
      originsOverflow: true,
    });
    expect(keyOf(vm)).toMatchObject({ overflow: true, origins: ["in"] });
    const r = rig(true);
    r.journal.commit("STEP_COMPLETED", { stepId: "s", output: { origins: ["x"] }, origins: ["y"] });
    expect(keyOf(r.vm).origins).toEqual(["in"]);
  });
  it("the start envelope of a stamped run records its own input (bootstrapEnvelope has no vm)", () => {
    const e = ExecutionJournal.bootstrapEnvelope(
      { executionId: "e", workflowId: "f" },
      "EXECUTION_STARTED",
      {
        input: T("peer"),
        seenOriginsLimits: STAMP,
      }
    );
    expect(e.metadata).toEqual({ origins: ["peer"] });
    const plain = ExecutionJournal.bootstrapEnvelope(
      { executionId: "e", workflowId: "f" },
      "EXECUTION_STARTED",
      { input: T("peer") }
    );
    expect(plain.metadata).toBeUndefined();
  });
});
