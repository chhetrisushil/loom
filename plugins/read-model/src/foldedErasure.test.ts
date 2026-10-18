import { projection$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  EncryptingEventStore,
  InMemoryKeyStore,
  PayloadShreddedError,
  isShredded,
  shredSubject,
} from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { ReadModelService } from "./ReadModelService";
import type { ReadModelEventSource, SensitiveMap } from "./types";

// Copied from erasure.test.ts (file-local there): the sealed field, the subject, the event shape.
const SENSITIVE = { OPERATOR_ACTION: ["operator"] } as const;
const subjectOf = (e: { executionId: string }) => e.executionId.split(":")[0] as string;
const NO_SNAPSHOTS = { loadLatest: async () => null };

function action(executionId: string, sequence: number, operator: string, tool: string) {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType: "OPERATOR_ACTION",
    sequence,
    timestamp: Date.UTC(2026, 8, 10) + sequence,
    payload: { operator, tool },
  } satisfies EventEnvelope;
}

const ID = "operator-view";
const EXECS = ["ana:1", "ana:2", "bo:1"];

interface OperatorView {
  actions: number;
  tool?: string | undefined;
  operator?: string | undefined;
}
/**
 * Folds who did what. A shredded placeholder is skipped, not stored (ADR 0092 D6 / 0132 D12).
 * `calls` counts handler invocations; `seen` records the operator value each invocation was handed.
 */
function makeView() {
  const calls: string[] = [];
  const seen: Record<string, unknown> = {};
  const view = projection$<OperatorView>({
    id: ID,
    name: ID,
    version: "1",
    initialState: { actions: 0 },
    handlers: {
      OPERATOR_ACTION: (s, e) => {
        const p = e.payload as { operator: unknown; tool: string };
        calls.push(e.executionId);
        seen[e.executionId] = p.operator;
        return {
          ...s,
          actions: s.actions + 1,
          tool: p.tool,
          operator: isShredded(p.operator) ? undefined : (p.operator as string),
        };
      },
    },
  });
  return { view, calls, seen };
}

/** A source that hands events over without the `metadata.seal` marker, so only the shred protects. */
function unsealed(src: ReadModelEventSource): ReadModelEventSource {
  return {
    listExecutions: () => src.listExecutions?.() as Promise<string[]>,
    readFrom: async (id, from) =>
      (await src.readFrom(id, from)).map(
        ({ metadata: _dropped, ...rest }) => rest as EventEnvelope
      ),
  };
}

async function boot(onShredded: "throw" | "tolerate", sensitive?: SensitiveMap) {
  const keys = new InMemoryKeyStore();
  const raw = new InMemoryAsyncEventStore();
  const encrypting = new EncryptingEventStore(raw, keys, {
    sensitive: SENSITIVE,
    subjectOf,
    onShredded,
  });
  // Two executions for "ana", one for "bo"; only "ana" is erased below.
  const events = [
    action("ana:1", 0, "ana", "read-rows"),
    action("ana:2", 0, "ana", "explain-plan"),
    action("bo:1", 0, "bo", "read-rows"),
  ];
  for (const e of events) await encrypting.append(e);
  const store = new InMemoryReadModelStore();
  const errors: unknown[] = [];
  const service = new ReadModelService(store, {
    onError: (err) => errors.push(err),
    ...(sensitive === undefined ? {} : { sensitive }),
  });
  const { view, calls, seen } = makeView();
  await service.registerFolded({ projection: view, scopeOf: (id) => id.split(":")[0] });
  const shredAna = () =>
    shredSubject(keys, raw, "ana:1", {
      subjectId: "ana",
      executionIds: ["ana:1", "ana:2"],
      snapshotStore: NO_SNAPSHOTS,
    });
  return { encrypting, store, service, events, shredAna, calls, seen, errors };
}

const operators = async (service: ReadModelService) =>
  Object.fromEntries(
    [...(await service.getMany<OperatorView>(ID, EXECS))].map(([id, s]) => [id, s.state.operator])
  );
// States only: execution ids ("ana:1") legitimately contain the subject's name.
const everything = async (service: ReadModelService) =>
  JSON.stringify([...(await service.getMany<OperatorView>(ID, EXECS))].map(([, s]) => s.state));

describe("subject erasure and folded read-model state (ADR 0132 D11/D12)", () => {
  it("the hazard: a live-fed fold with no declared map holds the value, and purgeFolded removes exactly the subject's states", async () => {
    const { encrypting, store, service, events, shredAna, calls, errors } = await boot("tolerate");
    for (const e of events) service.handleEvent(e); // the runtime's plaintext events: no seal marker, no map
    await service.drain();
    expect(await operators(service)).toEqual({ "ana:1": "ana", "ana:2": "ana", "bo:1": "bo" });

    await shredAna();
    // The erasure took (so the next assertion is not vacuous): the LOG can no longer produce the name.
    const logged = await encrypting.read("ana:1");
    expect(isShredded((logged[0]?.payload as { operator: unknown }).operator)).toBe(true);
    // ...and the folded state still can. Nothing failed (onError never fired).
    expect(errors).toEqual([]);
    expect(await operators(service)).toEqual({ "ana:1": "ana", "ana:2": "ana", "bo:1": "bo" });

    expect(await service.purgeFolded(ID, { scope: "ana" })).toBe(2);
    expect(await operators(service)).toEqual({ "bo:1": "bo" }); // ana's states are absent, bo's untouched

    // End to end: a live event for the purged execution never reaches the handler, and this node's
    // cache does not hold the erased state (or anything for it) again.
    const before = calls.length;
    service.handleEvent(action("ana:1", 1, "ana", "late")); // contiguous with the tombstone (live-fed only)
    await service.drain();
    expect(calls.length).toBe(before);
    // At most the erased marker is cached for it: never a state.
    const cache = (
      service as unknown as { folded: { cache?: { take(m: string, e: string): unknown } } }
    ).folded.cache;
    expect(cache?.take(ID, "ana:1")).toMatchObject({ erased: true, state: null });
    expect((await store.getFolded(ID, ["ana:1"]))[0]).toMatchObject({ erased: true, state: null });
    expect(errors).toEqual([]);
  });

  it("a rebuild through a STRICT source throws and leaves the model cleared; a tolerant one re-derives without the subject", async () => {
    const strict = await boot("throw");
    await strict.service.catchUp([strict.encrypting]);
    await strict.shredAna();
    await strict.service.purgeFolded(ID, { scope: "ana" });
    // A rebuild is a read of the whole log, and a strict source fails loudly on shredded payloads (K10-R4).
    await expect(strict.service.rebuild(ID, [strict.encrypting])).rejects.toBeInstanceOf(
      PayloadShreddedError
    );
    // A failed rebuild is an unfinished rebuild: the model was cleared first, so tombstones and
    // watermarks are gone too. Re-run it through a tolerant source.
    expect(await strict.store.getFolded(ID, EXECS)).toEqual([]);

    // Sealed source: the marker masks the operator before the handler runs, so it never sees the placeholder.
    const sealed = await boot("tolerate");
    await sealed.service.catchUp([sealed.encrypting]);
    await sealed.shredAna();
    const report = await sealed.service.rebuild(ID, [sealed.encrypting]);
    expect(report.executionsScanned).toBe(3); // the cost: every execution is re-scanned, not only ana's
    expect(await sealed.service.getMany(ID, EXECS)).toHaveProperty("size", 3);
    // This case proves MASKING only (the handler was handed "[redacted]", never a value or a placeholder).
    expect(sealed.seen).toEqual({
      "ana:1": "[redacted]",
      "ana:2": "[redacted]",
      "bo:1": "[redacted]",
    });
    expect(await everything(sealed.service)).not.toContain("ana");
  });

  it("purge then a tolerant rebuild un-tombstones with the shred as the only protection (control: same rebuild without the shred keeps the name)", async () => {
    // Control: without the shred the marker-less source yields the name, so the assertions below depend on it.
    const control = await boot("tolerate");
    await control.service.catchUp([control.encrypting]);
    await control.service.rebuild(ID, [unsealed(control.encrypting)]);
    expect(await operators(control.service)).toEqual({
      "ana:1": "ana",
      "ana:2": "ana",
      "bo:1": "bo",
    });

    const t = await boot("tolerate");
    for (const e of t.events) t.service.handleEvent(e);
    await t.service.drain();
    await t.shredAna();
    expect(await t.service.purgeFolded(ID, { scope: "ana" })).toBe(2);
    await t.service.rebuild(ID, [unsealed(t.encrypting)]);
    // The handler was handed the placeholder (the skip branch ran), not a value.
    expect(isShredded(t.seen["ana:1"])).toBe(true);
    expect(isShredded(t.seen["ana:2"])).toBe(true);
    // Rebuild UN-tombstoned ana's records at the log tip (ERASURE_PENDING 1, PAYLOAD_SHREDDED 2).
    const records = await t.store.getFolded(ID, EXECS);
    expect(records.map((r) => [r?.executionId, r?.erased, r?.sequence])).toEqual([
      ["ana:1", false, 2],
      ["ana:2", false, 2],
      ["bo:1", false, 0],
    ]);
    expect(await operators(t.service)).toEqual({
      "ana:1": undefined,
      "ana:2": undefined,
      "bo:1": "bo",
    });
    expect(await everything(t.service)).not.toContain('"ana"');
  });

  it("a tombstone sticks: neither a later catch-up nor a later live event resurrects the purged state", async () => {
    const { encrypting, store, service, shredAna, calls } = await boot("tolerate");
    await service.catchUp([encrypting]);
    await shredAna();
    expect(await service.purgeFolded(ID, { scope: "ana" })).toBe(2);

    // The shred appended ERASURE_PENDING + PAYLOAD_SHREDDED to each of ana's two logs: four unhandled
    // events. Scanning them must not resurrect the purged rows, and the watermark moves past them.
    expect((await service.catchUp([encrypting])).eventsScanned).toBe(4);
    expect(await service.getMany(ID, ["ana:1", "ana:2"])).toHaveProperty("size", 0);
    expect((await service.catchUp([encrypting])).eventsScanned).toBe(0);
    const before = calls.length;
    service.handleEvent(action("ana:1", 3, "ana", "late")); // a live event after the purge
    await service.drain();
    expect(calls.length).toBe(before); // the handler never ran for the tombstoned execution
    expect(await service.getMany(ID, ["ana:1", "ana:2"])).toHaveProperty("size", 0);
    expect((await store.getFolded(ID, ["ana:1"]))[0]).toMatchObject({
      erased: true,
      state: null,
      sequence: 3,
    });
    expect(await operators(service)).toEqual({ "bo:1": "[redacted]" });
  });

  it("with the sensitive map declared the fold never held the value, so the purge is only a backstop", async () => {
    const { service, events, shredAna } = await boot("tolerate", SENSITIVE);
    for (const e of events) service.handleEvent(e);
    await service.drain();
    expect(await operators(service)).toEqual({
      "ana:1": "[redacted]",
      "ana:2": "[redacted]",
      "bo:1": "[redacted]",
    });
    expect(await everything(service)).not.toContain("ana");

    await shredAna();
    expect(await everything(service)).not.toContain("ana"); // nothing for the shred to miss
    expect(await service.purgeFolded(ID, { scope: "ana" })).toBe(2); // still the erasure of the subject's states
    expect(await operators(service)).toEqual({ "bo:1": "[redacted]" });
  });
});
