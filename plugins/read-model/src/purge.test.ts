import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { ReadModelService } from "./ReadModelService";
import { PurgeUnsupportedError } from "./types";
import type { ReadModelDefinition, ReadModelStore } from "./types";

// ── Row-granular purge (ADR 0093) ────────────────────────────────────────────
//
// `clear` + rebuild was the only removal verb, which makes erasing one subject cost the
// whole log. Purge deletes by indexed-field equality instead. Everything here is about
// the ways a purge can LIE: deleting nothing and reporting success, deleting more than
// asked, or deleting rows a later catch-up quietly puts back.

const ACTIONS: ReadModelDefinition = {
  id: "actions",
  kinds: ["OPERATOR_ACTION"],
  indexes: ["operator", "tool"],
  extract: (event) => {
    const p = event.payload as { operator: string; tool: string };
    return [{ fields: { operator: p.operator, tool: p.tool } }];
  },
};

function evt(
  executionId: string,
  sequence: number,
  operator: string,
  tool: string,
  timestamp: number
) {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType: "OPERATOR_ACTION",
    sequence,
    timestamp,
    payload: { operator, tool },
  } satisfies EventEnvelope;
}

async function boot() {
  const store = new InMemoryReadModelStore();
  const service = new ReadModelService(store);
  service.register(ACTIONS);
  const events = new InMemoryAsyncEventStore();
  // Distinct timestamps: rows come back ordered by (timestamp, sequence, rowId), so
  // sharing one would interleave the operators and make every expectation below a puzzle.
  for (const e of [
    evt("x-1", 0, "ana", "read-rows", 1_000),
    evt("x-1", 1, "ana", "explain-plan", 1_100),
    evt("x-2", 0, "bo", "read-rows", 1_200),
  ]) {
    await events.append(e);
  }
  await service.catchUp([events]);
  return { store, service, events };
}

const operators = async (service: ReadModelService) =>
  (await service.query(ACTIONS.id)).rows.map((r) => r.fields.operator);

describe("ReadModelService.purge (ADR 0093)", () => {
  it("deletes one subject's rows and leaves the rest", async () => {
    const { service } = await boot();
    expect(await service.purge(ACTIONS.id, { operator: "ana" })).toBe(2);
    expect(await operators(service)).toEqual(["bo"]);
  });

  it("erased rows stay erased: a later catch-up does not resurrect them", async () => {
    // The property that makes purge an ERASURE rather than a cache eviction. Watermarks
    // are untouched, so the incremental scan has nothing left to re-read — even though
    // the source events are still sitting in the log, undisturbed.
    const { service, events } = await boot();
    await service.purge(ACTIONS.id, { operator: "ana" });

    const report = await service.catchUp([events]);

    expect(await operators(service)).toEqual(["bo"]);
    expect(report.rowsApplied).toBe(0);
  });

  it("refuses a filter naming a field the model never declared", async () => {
    const { service } = await boot();
    // The row only ever stored declared fields, so this filter matches nothing — and a
    // purge that matched nothing would report a successful erasure of zero rows.
    await expect(service.purge(ACTIONS.id, { tenant: "acme" })).rejects.toThrow(/undeclared field/);
    expect(await operators(service)).toEqual(["ana", "ana", "bo"]);
  });

  it("refuses an empty filter rather than reading it as every row", async () => {
    const { service } = await boot();
    await expect(service.purge(ACTIONS.id, {})).rejects.toThrow(/at least one field/);
    expect(await operators(service)).toEqual(["ana", "ana", "bo"]);
  });

  it("refuses an unregistered model", async () => {
    const { service } = await boot();
    await expect(service.purge("ghost", { operator: "ana" })).rejects.toThrow(/not registered/);
  });

  it("refuses loudly on a backend that cannot purge, naming the fallback", async () => {
    // The whole point of the typed error. A backend predating SPI 1.1.0 has no way to
    // delete a row, and the tempting default — resolve, having deleted nothing — would
    // report an erasure that did not happen to a caller who is legally obliged to
    // perform one.
    // Delegation, not `delete`: `purge` lives on InMemoryReadModelStore's PROTOTYPE, so
    // deleting the own property removes nothing and the service happily finds it — a stub
    // that silently keeps the method under test would make this whole case vacuous.
    const inner = new InMemoryReadModelStore();
    const legacy: ReadModelStore = {
      apply: (...args) => inner.apply(...args),
      watermark: (...args) => inner.watermark(...args),
      watermarkedExecutions: (...args) => inner.watermarkedExecutions(...args),
      query: (...args) => inner.query(...args),
      clear: (...args) => inner.clear(...args),
    };
    expect(legacy.purge).toBeUndefined();
    const service = new ReadModelService(legacy);
    service.register(ACTIONS);

    const failure = service.purge(ACTIONS.id, { operator: "ana" });
    await expect(failure).rejects.toBeInstanceOf(PurgeUnsupportedError);
    await expect(failure).rejects.toThrow(/clear\(modelId\) \+ rebuild/);
  });
});
