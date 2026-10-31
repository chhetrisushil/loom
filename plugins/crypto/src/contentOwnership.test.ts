import { EraseCoordinator, SubjectIndex, exportSubject } from "@loom/compliance";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryContentStore } from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { EncryptingContentStore } from "./EncryptingContentStore";
import { InMemoryKeyStore } from "./keystore";

// ADR 0143 D5/D8 - a CITATION is not OWNERSHIP. An execution's log can cite an address it never put (a
// resume payload, an input, an awaitChild result, a carried envelope). Erasing or exporting the CITER must
// never touch a blob sealed under another subject. Real stores end to end.

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const ev = (id: string, seq: number, eventType: string, payload: unknown): EventEnvelope =>
  ({
    id: `${id}-${seq}`,
    workflowId: "wf",
    executionId: id,
    eventType,
    sequence: seq,
    timestamp: 1000 + seq,
    payload,
  }) as EventEnvelope;
const env = (address: string, size = 5): unknown => ({
  __loomClaimCheck: true,
  ref: { __loomContent: address },
  size,
});
const subjectOf = (e: { eventType: string; payload: unknown }): string | undefined =>
  e.eventType === "EXECUTION_STARTED"
    ? (e.payload as { input?: { userId?: string } }).input?.userId
    : undefined;

async function world() {
  const keys = new InMemoryKeyStore();
  const inner = new InMemoryContentStore();
  const sealed = new EncryptingContentStore(inner, keys);
  const a1 = { executionId: "a1", workflowId: "wf" };
  const b1 = { executionId: "b1", workflowId: "wf" };
  const annRef = await sealed.put(enc('"ann-secret-tool-output"'), a1);
  const bobRef = await sealed.put(enc('"bob-own-tool-output"'), b1);
  const store = new InMemoryAsyncEventStore();
  await store.append(ev("a1", 0, "EXECUTION_STARTED", { input: { userId: "ann" } }));
  await store.append(
    ev("a1", 1, "STEP_COMPLETED", { stepId: "s", output: env(annRef.__loomContent) })
  );
  await store.append(ev("a1", 2, "EXECUTION_COMPLETED", { output: null }));
  // bob's execution: his OWN blob at a trusted position, and ann's address merely CITED in an input.
  await store.append(
    ev("b1", 0, "EXECUTION_STARTED", {
      input: { userId: "bob", carried: env(annRef.__loomContent) },
    })
  );
  await store.append(
    ev("b1", 1, "STEP_COMPLETED", { stepId: "s", output: env(bobRef.__loomContent) })
  );
  await store.append(ev("b1", 2, "EXECUTION_COMPLETED", { output: null }));
  const index = SubjectIndex.fromEvents(
    [...(await store.read("a1")), ...(await store.read("b1"))],
    subjectOf
  );
  return { keys, inner, sealed, store, index, annRef, bobRef, a1, b1 };
}

describe("a citation is not ownership (ADR 0143)", () => {
  it("erasing bob does NOT delete ann's blob that bob merely cited; bob's own blob is deleted; the journal says foreign", async () => {
    const w = await world();
    const coord = new EraseCoordinator({
      index: w.index,
      eventStore: w.store,
      shred: async (_s, execs) => {
        for (const x of execs)
          await w.keys.destroy(w.sealed.subjectOf({ executionId: x, workflowId: "wf" }));
      },
      content: w.sealed,
    });
    const r = await coord.eraseSubject("bob");
    expect(r.outcome).toBe("erased");
    expect(r.contentDeleted).toMatchObject({ deleted: 1, sealed: 1, retained: 1, foreign: 1 });
    // ann's blob survives, still readable by ann
    expect(new TextDecoder().decode((await w.sealed.get(w.annRef, w.a1)) as Uint8Array)).toBe(
      '"ann-secret-tool-output"'
    );
    // bob's own blob is physically gone
    expect(await w.inner.get(w.bobRef)).toBeNull();
    const journal = (await w.store.read("__loom_erasure__")).filter(
      (e) => e.eventType === "ERASURE_CONTENT_DELETED"
    );
    expect(journal).toHaveLength(1);
    expect(journal[0]?.payload).toMatchObject({ deleted: 1, retained: 1, foreign: 1, sealed: 1 });
  });

  it("exporting bob does not throw on ann's blob: it is reported foreign, never as bob's data", async () => {
    const w = await world();
    const out = await exportSubject("bob", {
      index: w.index,
      eventStore: w.store,
      content: w.sealed,
    });
    const claimChecked = out.executions[0]?.claimChecked ?? [];
    expect(claimChecked).toContainEqual({ address: w.annRef.__loomContent, foreign: true });
    expect(claimChecked.find((c) => c.address === w.bobRef.__loomContent)).toMatchObject({
      value: "bob-own-tool-output",
    });
  });
});
