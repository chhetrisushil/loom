import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { ReadModelService } from "./ReadModelService";
import type { ReadModelDefinition } from "./types";

// ADR 0095 — the second consumer of the binding-semantics pin, and the one where the defect
// is already live: an edited `extract` leaves the rows it wrote in place, with the watermark
// already past the events that produced them.

const T0 = Date.UTC(2026, 0, 1);

function finding(sequence: number, target: string, severity: string): EventEnvelope {
  return {
    id: `run-1-${sequence}`,
    workflowId: "wf",
    executionId: "run-1",
    eventType: "FINDING_RECORDED",
    sequence,
    timestamp: T0 + sequence,
    payload: { target, severity },
  };
}

/** v1 stores the severity as the row's value. */
const FINDINGS_V1: ReadModelDefinition = {
  id: "findings-by-target",
  version: "1",
  kinds: ["FINDING_RECORDED"],
  indexes: ["target"],
  extract: (event) => {
    const p = event.payload as { target: string; severity: string };
    return [{ fields: { target: p.target }, value: p.severity }];
  },
};

/** v2 stores a normalized object instead — same rows, different meaning. */
const FINDINGS_V2: ReadModelDefinition = {
  ...FINDINGS_V1,
  version: "2",
  extract: (event) => {
    const p = event.payload as { target: string; severity: string };
    return [{ fields: { target: p.target }, value: { severity: p.severity, normalized: true } }];
  },
};

describe("the defect the pin exists to detect", () => {
  it("an edited extractor leaves the old rows in place and one query answers from both", async () => {
    const store = new InMemoryReadModelStore();
    const events = new InMemoryAsyncEventStore();

    const before = new ReadModelService(store);
    before.register(FINDINGS_V1);
    await events.append(finding(0, "orders", "high"));
    await before.catchUp([events]);

    // A deploy: the same model id, a changed extractor. Nothing clears anything.
    const after = new ReadModelService(store);
    after.register(FINDINGS_V2);
    await events.append(finding(1, "checkout", "low"));
    const report = await after.catchUp([events]);

    // The watermark is already past the first event, so catch-up never revisits it...
    expect(report.eventsScanned).toBe(1);
    const page = await after.query("findings-by-target");
    // ...and the model now holds one row of each shape, under one id, with no signal.
    expect(page.rows.map((r) => r.value)).toEqual(["high", { severity: "low", normalized: true }]);
  });
});

describe("ReadModelService.checkPins — the signal", () => {
  it("reports drift when the artifact was built against a different extractor", () => {
    const service = new ReadModelService(new InMemoryReadModelStore());
    service.register(FINDINGS_V2);

    // What the caller wrote down when it produced a report from these rows.
    const report = service.checkPins({ "findings-by-target": "1" });

    expect(report.ok).toBe(false);
    expect(report.compared).toBe(1);
    expect(report.findings[0]).toMatchObject({
      code: "drift",
      severity: "error",
      id: "findings-by-target",
      recorded: "1",
      current: "2",
    });
  });

  it("is a query: it clears nothing, rebuilds nothing, applies nothing", async () => {
    const store = new InMemoryReadModelStore();
    const events = new InMemoryAsyncEventStore();
    const service = new ReadModelService(store);
    service.register(FINDINGS_V1);
    await events.append(finding(0, "orders", "high"));
    await service.catchUp([events]);

    service.checkPins({ "findings-by-target": "0" });

    expect((await service.query("findings-by-target")).rows).toHaveLength(1);
    expect(await store.watermark("findings-by-target", "run-1")).toBe(0);
  });

  it("rebuild is the exit, and the pin is clean once the artifact records the new version", async () => {
    const store = new InMemoryReadModelStore();
    const events = new InMemoryAsyncEventStore();

    const before = new ReadModelService(store);
    before.register(FINDINGS_V1);
    await events.append(finding(0, "orders", "high"));
    await before.catchUp([events]);

    const after = new ReadModelService(store);
    after.register(FINDINGS_V2);
    await events.append(finding(1, "checkout", "low"));
    await after.catchUp([events]);
    expect(after.checkPins({ "findings-by-target": "1" }).ok).toBe(false);

    await after.rebuild("findings-by-target", [events]);

    // Every row is now the new extractor's, and an artifact recorded against v2 agrees.
    const page = await after.query("findings-by-target");
    expect(page.rows.map((r) => r.value)).toEqual([
      { severity: "high", normalized: true },
      { severity: "low", normalized: true },
    ]);
    expect(after.checkPins({ "findings-by-target": "2" })).toEqual({
      ok: true,
      findings: [],
      compared: 1,
    });
  });

  it("a model that declares no version cannot verify anything, and says so", () => {
    // The vacuous case: without this, `{}` vs `{}` would return a clean report and a caller
    // would read "unchanged" from a comparison that never happened.
    const { version: _dropped, ...unversioned } = FINDINGS_V1;
    const service = new ReadModelService(new InMemoryReadModelStore());
    service.register(unversioned);

    expect(service.pins()).toEqual({});
    const report = service.checkPins({ "findings-by-target": "1" });
    expect(report.compared).toBe(0);
    expect(report.findings[0]).toMatchObject({ code: "unpinned", severity: "warn" });
  });

  it("another model's version drifting says nothing about this artifact", () => {
    const service = new ReadModelService(new InMemoryReadModelStore());
    service.register(FINDINGS_V2);
    service.register({ ...FINDINGS_V1, id: "decisions-by-subject", version: "9" });

    expect(service.pins()).toEqual({ "findings-by-target": "2", "decisions-by-subject": "9" });
    expect(service.checkPins({ "findings-by-target": "2" })).toEqual({
      ok: true,
      findings: [],
      compared: 1,
    });
  });
});
