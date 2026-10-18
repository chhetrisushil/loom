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
import type { SensitiveMap } from "./types";

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
/** Folds who did what. A shredded placeholder is skipped, not stored (ADR 0092 D6 / 0132 D12). */
const VIEW = projection$<OperatorView>({
  id: ID,
  name: ID,
  version: "1",
  initialState: { actions: 0 },
  handlers: {
    OPERATOR_ACTION: (s, e) => {
      const p = e.payload as { operator: unknown; tool: string };
      return {
        ...s,
        actions: s.actions + 1,
        tool: p.tool,
        operator: isShredded(p.operator) ? undefined : (p.operator as string),
      };
    },
  },
});

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
  const service = new ReadModelService(store, sensitive === undefined ? {} : { sensitive });
  await service.registerFolded({ projection: VIEW, scopeOf: (id) => id.split(":")[0] });
  const shredAna = () =>
    shredSubject(keys, raw, "ana:1", {
      subjectId: "ana",
      executionIds: ["ana:1", "ana:2"],
      snapshotStore: NO_SNAPSHOTS,
    });
  return { encrypting, store, service, events, shredAna };
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
    const { encrypting, service, events, shredAna } = await boot("tolerate");
    for (const e of events) service.handleEvent(e); // the runtime's plaintext events: no seal marker, no map
    await service.drain();
    expect(await operators(service)).toEqual({ "ana:1": "ana", "ana:2": "ana", "bo:1": "bo" });

    await shredAna();
    // The erasure took (so the next assertion is not vacuous): the LOG can no longer produce the name.
    const logged = await encrypting.read("ana:1");
    expect(isShredded((logged[0]?.payload as { operator: unknown }).operator)).toBe(true);
    // ...and the folded state still can. Nothing failed, nothing warned.
    expect(await operators(service)).toEqual({ "ana:1": "ana", "ana:2": "ana", "bo:1": "bo" });

    expect(await service.purgeFolded(ID, { scope: "ana" })).toBe(2);
    expect(await operators(service)).toEqual({ "bo:1": "bo" }); // ana's states are absent, bo's untouched
  });

  it("a rebuild through a STRICT source throws; through a tolerant one it completes with no trace of the subject", async () => {
    const strict = await boot("throw");
    await strict.service.catchUp([strict.encrypting]);
    await strict.shredAna();
    // A rebuild is a read of the whole log, and a strict source fails loudly on shredded payloads (K10-R4).
    await expect(strict.service.rebuild(ID, [strict.encrypting])).rejects.toBeInstanceOf(
      PayloadShreddedError
    );

    const tolerant = await boot("tolerate");
    await tolerant.service.catchUp([tolerant.encrypting]);
    await tolerant.shredAna();
    const report = await tolerant.service.rebuild(ID, [tolerant.encrypting]);
    expect(report.executionsScanned).toBe(3); // the cost: every execution is re-scanned, not only ana's
    expect(await tolerant.service.getMany(ID, EXECS)).toHaveProperty("size", 3);
    // the handler skipped the placeholder (or saw the masked value): the name is not in any state
    expect(await everything(tolerant.service)).not.toContain("ana");
  });

  it("a tombstone sticks: neither a later catch-up nor a later live event resurrects the purged state", async () => {
    const { encrypting, store, service, shredAna } = await boot("tolerate");
    await service.catchUp([encrypting]);
    await shredAna();
    expect(await service.purgeFolded(ID, { scope: "ana" })).toBe(2);

    // The shred appended ERASURE_PENDING + PAYLOAD_SHREDDED to each of ana's two logs: four unhandled
    // events. Scanning them must not resurrect the purged rows, and the watermark moves past them.
    expect((await service.catchUp([encrypting])).eventsScanned).toBe(4);
    expect(await service.getMany(ID, ["ana:1", "ana:2"])).toHaveProperty("size", 0);
    expect((await service.catchUp([encrypting])).eventsScanned).toBe(0);
    service.handleEvent(action("ana:1", 3, "ana", "late")); // a live event after the purge
    await service.drain();
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
