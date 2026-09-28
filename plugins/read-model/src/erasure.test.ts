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
import type { ReadModelDefinition } from "./types";

// ── A read model is a cache of the log. Erasure destroys the log's plaintext ──
// ── and says nothing about the cache. ────────────────────────────────────────
//
// RM-2 makes a read model derivative by construction: "a CACHE of the log with a
// watermark, never an authority — drop it and rebuild by re-scanning". Crypto-shredding
// (K10.2) erases a subject by destroying the key its sensitive fields were encrypted
// under. Nothing connects the two: `@loom/compliance`'s `eraseSubject` knows the event
// store and the key store, and the only removal verb on `ReadModelStore` is
// `clear(modelId)` — the whole model.
//
// So an erasure leaves every derived row exactly as it was, holding the plaintext the
// extractor copied out before the shred. Those rows are what a console actually reads.
// The mechanism that closes it exists — clear + rebuild — and this suite pins what it
// costs and what it requires, because BOTH were assumed rather than checked:
//
//  1. the stale rows survive the shred (the hazard),
//  2. a rebuild through the DEFAULT (strict) source cannot run at all — the scan throws,
//  3. it takes a `onShredded: "tolerate"` source, and then the extractor sees `$shredded`
//     placeholders rather than values, so an extractor that indexes them writes the
//     placeholder into the cache as though it were data,
//  4. and the erasure is whole-model: an unrelated subject's rows are rebuilt too.
//
// Points 2 and 3 are the ones a design will miss, because "just rebuild it" sounds free.
//
// The last case is the one that closes it: `purge` (ADR 0093) deletes the subject's rows
// directly, so the erasure costs the rows rather than the log — and it needs no tolerant
// source, because it never reads the log at all.

const SENSITIVE = { OPERATOR_ACTION: ["operator"] } as const;

/** The erasure subject is the operator, not the execution — several runs erase together. */
const subjectOf = (e: { executionId: string }) => e.executionId.split(":")[0] as string;

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

/** Indexes who did what — the shape a profile read model has (ADR 0092 D4). */
const ACTIONS: ReadModelDefinition = {
  id: "actions-by-operator",
  kinds: ["OPERATOR_ACTION"],
  indexes: ["operator", "tool"],
  extract: (event) => {
    const p = event.payload as { operator: unknown; tool: string };
    // An extractor MUST decide what a shredded field means. Indexing it verbatim would
    // write `{ $shredded: true }` into a column typed as a scalar; skipping the row is
    // the honest answer, because the fact it indexed is precisely the erased one.
    if (isShredded(p.operator)) return [];
    return [{ fields: { operator: p.operator as string, tool: p.tool } }];
  },
};

/** Same model, but credulous about placeholders — the mistake this suite exists to name. */
const CREDULOUS: ReadModelDefinition = {
  ...ACTIONS,
  id: "actions-credulous",
  extract: (event) => {
    const p = event.payload as { operator: string; tool: string };
    return [{ fields: { operator: JSON.stringify(p.operator), tool: p.tool } }];
  },
};

/** No snapshots: these logs are never compacted, so the folded tip is the log head (ADR 0106). */
const NO_SNAPSHOTS = { loadLatest: async () => null };

async function boot(onShredded: "throw" | "tolerate") {
  const keys = new InMemoryKeyStore();
  const raw = new InMemoryAsyncEventStore();
  const encrypting = new EncryptingEventStore(raw, keys, {
    sensitive: SENSITIVE,
    subjectOf,
    onShredded,
  });

  // Two operators, two executions each; only "ana" is erased below.
  await encrypting.append(action("ana:1", 0, "ana", "read-rows"));
  await encrypting.append(action("ana:2", 0, "ana", "explain-plan"));
  await encrypting.append(action("bo:1", 0, "bo", "read-rows"));

  const store = new InMemoryReadModelStore();
  const service = new ReadModelService(store);
  service.register(ACTIONS);
  service.register(CREDULOUS);
  return { keys, raw, encrypting, store, service };
}

const operatorsIn = async (service: ReadModelService, modelId = ACTIONS.id) =>
  (await service.query(modelId)).rows.map((r) => r.fields.operator);

describe("subject erasure and derived read-model rows (ADR 0092 D6)", () => {
  it("leaves the derived rows untouched — the shred reaches the log, not the cache", async () => {
    const { keys, raw, encrypting, service } = await boot("tolerate");
    await service.catchUp([encrypting]);
    expect(await operatorsIn(service)).toEqual(["ana", "ana", "bo"]);

    await shredSubject(keys, raw, "ana:1", {
      subjectId: "ana",
      executionIds: ["ana:1", "ana:2"],
      snapshotStore: NO_SNAPSHOTS,
    });

    // The erasure took: the LOG can no longer produce the name. Asserting this is what
    // stops the next assertion passing vacuously — "the rows are unchanged" is equally
    // true of a shred that silently did nothing.
    const logged = await encrypting.read("ana:1");
    expect(isShredded((logged[0]?.payload as { operator: unknown }).operator)).toBe(true);

    // The cache still can — and the cache is what a query reads. Nothing failed,
    // nothing warned.
    expect(await operatorsIn(service)).toEqual(["ana", "ana", "bo"]);
  });

  it("cannot be rebuilt through the default source: the scan throws", async () => {
    const { keys, raw, encrypting, service } = await boot("throw");
    await service.catchUp([encrypting]);
    await shredSubject(keys, raw, "ana:1", {
      subjectId: "ana",
      executionIds: ["ana:1", "ana:2"],
      snapshotStore: NO_SNAPSHOTS,
    });

    // "Drop it and rebuild" is RM-2's whole promise, and after an erasure it is
    // unavailable on a strict source: the authoritative read fails loudly by design
    // (K10-R4), and a rebuild is a read. Rebuilding is a lifecycle operation, so it needs
    // a source configured for off-log consumers — not the one the fold uses.
    await expect(service.rebuild(ACTIONS.id, [encrypting])).rejects.toBeInstanceOf(
      PayloadShreddedError
    );
  });

  it("rebuilds through a tolerant source, and the erased rows are gone", async () => {
    const { keys, raw, encrypting, service } = await boot("tolerate");
    await service.catchUp([encrypting]);
    await shredSubject(keys, raw, "ana:1", {
      subjectId: "ana",
      executionIds: ["ana:1", "ana:2"],
      snapshotStore: NO_SNAPSHOTS,
    });

    const report = await service.rebuild(ACTIONS.id, [encrypting]);

    expect(await operatorsIn(service)).toEqual(["bo"]);
    // The cost, stated: every execution is re-scanned, not just the erased subject's.
    expect(report.executionsScanned).toBe(3);
  });

  it("purge erases the subject's rows without reading the log at all", async () => {
    const { keys, raw, encrypting, service } = await boot("throw"); // the STRICT source
    await service.catchUp([encrypting]);
    await shredSubject(keys, raw, "ana:1", {
      subjectId: "ana",
      executionIds: ["ana:1", "ana:2"],
      snapshotStore: NO_SNAPSHOTS,
    });

    // No rebuild, so no scan, so the strict source that made the rebuild impossible two
    // cases up is irrelevant here: purge works over the ROWS, and the rows are plaintext.
    expect(await service.purge(ACTIONS.id, { operator: "ana" })).toBe(2);
    expect(await operatorsIn(service)).toEqual(["bo"]);

    // And it holds: watermarks are untouched, so the next incremental catch-up has
    // nothing to re-read — which is why this is an erasure and not a cache eviction.
    // (Through the strict source that scan would throw; through a tolerant one it finds
    // every execution already watermarked.)
    const tolerant = new EncryptingEventStore(raw, keys, {
      sensitive: SENSITIVE,
      subjectOf,
      onShredded: "tolerate",
    });
    const report = await service.catchUp([tolerant]);
    expect(report.rowsApplied).toBe(0);
    expect(await operatorsIn(service)).toEqual(["bo"]);
  });

  it("a credulous extractor rebuilds the placeholder INTO the cache", async () => {
    const { keys, raw, encrypting, service } = await boot("tolerate");
    await service.catchUp([encrypting]);
    await shredSubject(keys, raw, "ana:1", {
      subjectId: "ana",
      executionIds: ["ana:1", "ana:2"],
      snapshotStore: NO_SNAPSHOTS,
    });
    await service.rebuild(CREDULOUS.id, [encrypting]);

    // Not a leak — the name is genuinely gone — but the rows survive erasure as
    // `{"$shredded":true}` in a field the app declared as an operator id, and every
    // erased subject collapses onto that one value. A model keyed on it silently
    // MERGES every erased subject into a single bucket.
    const rows = await operatorsIn(service, CREDULOUS.id);
    expect(rows).toEqual(['{"$shredded":true}', '{"$shredded":true}', '"bo"']);
  });
});
