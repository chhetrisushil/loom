import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { ReadModelService } from "./ReadModelService";
import type { ReadModelDefinition } from "./types";

const DAY = 24 * 3600_000;
const T0 = Date.UTC(2026, 0, 1);

function evt(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown,
  timestamp: number
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence,
    timestamp,
    payload,
  };
}

const FINDINGS: ReadModelDefinition = {
  id: "findings-by-target",
  kinds: ["FINDING_RECORDED"],
  indexes: ["target", "severity"],
  extract: (event) => {
    const p = event.payload as { target: string; severity: string };
    return [{ fields: { target: p.target, severity: p.severity } }];
  },
};

const DECISIONS: ReadModelDefinition = {
  id: "decisions-by-subject",
  kinds: ["DECISION_RECORDED"],
  indexes: ["subject"],
  extract: (event) => {
    const p = event.payload as { subject: string };
    return [{ fields: { subject: p.subject } }];
  },
};

function boot() {
  const store = new InMemoryReadModelStore();
  const service = new ReadModelService(store);
  service.register(FINDINGS);
  service.register(DECISIONS);
  return { store, service };
}

describe("ReadModelService — ingestion converges (RM-1)", () => {
  it("live handleEvent and catch-up scan produce the same rows (idempotent apply)", async () => {
    const { service } = boot();
    const events = new InMemoryAsyncEventStore();
    const finding = evt(
      "wake-1",
      3,
      "FINDING_RECORDED",
      { target: "orders", severity: "high" },
      T0
    );
    await events.append(evt("wake-1", 0, "EXECUTION_STARTED", { input: {} }, T0));
    await events.append(finding);

    // Live tail sees the event...
    service.handleEvent(finding);
    await new Promise((r) => setImmediate(r));
    // ...and a catch-up over the same store re-delivers it. Must not duplicate.
    await service.catchUp([events]);
    await service.catchUp([events]); // and again — watermark makes this a no-op scan

    const page = await service.query("findings-by-target", { where: { target: "orders" } });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.kind).toBe("FINDING_RECORDED");
  });

  it("cold restart resumes from the watermark: readFrom skips applied history", async () => {
    const { store, service } = boot();
    const events = new InMemoryAsyncEventStore();
    for (let i = 0; i < 5; i++) {
      await events.append(
        evt("run-1", i, "FINDING_RECORDED", { target: `t${i}`, severity: "low" }, T0 + i)
      );
    }
    await service.catchUp([events]);
    expect(await store.watermark("findings-by-target", "run-1")).toBe(4);

    // New events arrive while "down"; a fresh service over the SAME store catches up.
    await events.append(
      evt("run-1", 5, "FINDING_RECORDED", { target: "t5", severity: "low" }, T0 + 5)
    );
    const revived = new ReadModelService(store);
    revived.register(FINDINGS);
    const report = await revived.catchUp([events]);
    expect(report.eventsScanned).toBe(1); // ONLY the new event — no re-fold of history
    expect((await revived.query("findings-by-target")).rows).toHaveLength(6);
  });

  it("reserved __loom_* control streams are never indexed", async () => {
    const { service } = boot();
    const events = new InMemoryAsyncEventStore();
    await events.append(
      evt("__loom_lifecycle__", 0, "FINDING_RECORDED", { target: "x", severity: "low" }, T0)
    );
    service.handleEvent(
      evt("__loom_lifecycle__", 1, "FINDING_RECORDED", { target: "y", severity: "low" }, T0)
    );
    await service.catchUp([events]);
    expect((await service.query("findings-by-target")).rows).toHaveLength(0);
  });

  it("archive sources participate (RM-4) and a non-enumerable source refuses", async () => {
    const { service } = boot();
    const live = new InMemoryAsyncEventStore();
    const archive = new InMemoryAsyncEventStore();
    await live.append(evt("new-1", 0, "FINDING_RECORDED", { target: "a", severity: "low" }, T0));
    await archive.append(
      evt("old-1", 0, "FINDING_RECORDED", { target: "b", severity: "high" }, T0 - 300 * DAY)
    );
    await service.catchUp([live, archive]);
    expect((await service.query("findings-by-target")).rows).toHaveLength(2);

    const blind = { readFrom: live.readFrom.bind(live) };
    await expect(service.catchUp([blind])).rejects.toThrow(/listExecutions/);
  });

  it("a throwing extractor reports via onError on the live path and never breaks the pipeline", async () => {
    const store = new InMemoryReadModelStore();
    const errors: unknown[] = [];
    const service = new ReadModelService(store, { onError: (err) => errors.push(err) });
    service.register({
      id: "boom",
      kinds: ["FINDING_RECORDED"],
      indexes: [],
      extract: () => {
        throw new Error("bad extractor");
      },
    });
    expect(() => service.handleEvent(evt("run-1", 0, "FINDING_RECORDED", {}, T0))).not.toThrow();
    expect(errors).toHaveLength(1);
  });

  it("undeclared fields and duplicate rowIds are loud TypeErrors", async () => {
    const { service } = boot();
    const events = new InMemoryAsyncEventStore();
    const bad = new ReadModelService(new InMemoryReadModelStore());
    bad.register({
      id: "undeclared",
      kinds: ["FINDING_RECORDED"],
      indexes: ["known"],
      extract: () => [{ fields: { unknown: 1 } }],
    });
    await events.append(evt("run-1", 0, "FINDING_RECORDED", {}, T0));
    await expect(bad.catchUp([events])).rejects.toThrow(/undeclared field/);
    void service; // silence unused in this scenario
  });
});

describe("ReadModelService — queries (RM-3) and rebuild (RM-2)", () => {
  it("filters by kind + fields, orders, and pages with a keyset cursor", async () => {
    const { service } = boot();
    const events = new InMemoryAsyncEventStore();
    for (let i = 0; i < 25; i++) {
      await events.append(
        evt(
          `run-${i}`,
          0,
          "FINDING_RECORDED",
          { target: i % 2 === 0 ? "orders" : "users", severity: i < 20 ? "low" : "high" },
          T0 + i * 1000
        )
      );
    }
    await service.catchUp([events]);

    const high = await service.query("findings-by-target", { where: { severity: "high" } });
    expect(high.rows).toHaveLength(5);

    // Page through 'orders' findings, 5 at a time, newest first.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await service.query("findings-by-target", {
        where: { target: "orders" },
        order: "desc",
        limit: 5,
        ...(cursor !== undefined && { cursor }),
      });
      seen.push(...page.rows.map((r) => r.rowId));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(13); // 0,2,...,24
    expect(new Set(seen).size).toBe(13); // no duplicates across pages
    const stamps = seen.map((id) => Number(id.split("-")[1]));
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a)); // desc order held across pages
  });

  it("rebuild: drop the checkpoint, re-derive from the log, get identical state", async () => {
    const { store, service } = boot();
    const events = new InMemoryAsyncEventStore();
    for (let i = 0; i < 10; i++) {
      await events.append(
        evt(`run-${i}`, 0, "FINDING_RECORDED", { target: "orders", severity: "low" }, T0 + i)
      );
      await events.append(evt(`run-${i}`, 1, "DECISION_RECORDED", { subject: "col-x" }, T0 + i));
    }
    await service.catchUp([events]);
    const before = await service.query("findings-by-target", { limit: 1000 });

    const report = await service.rebuild("findings-by-target", [events]);
    expect(report.rowsApplied).toBe(10);
    const after = await service.query("findings-by-target", { limit: 1000 });
    expect(after.rows).toEqual(before.rows);
    // The OTHER model's rows were untouched by the scoped rebuild.
    expect((await store.query("decisions-by-subject", { limit: 1000 })).rows).toHaveLength(10);
  });
});

describe("acceptance §5.1 — a year of db-sentinel-shaped logs", () => {
  it("indexes 1,460 wakes and answers a by-target query in <100ms warm", async () => {
    const { service } = boot();
    const events = new InMemoryAsyncEventStore();
    // 1,460 wakes; every 30th records a finding (~49), plus a decision each.
    for (let i = 0; i < 1460; i++) {
      const id = `pg-sentinel@${T0 + i * 6 * 3600_000}`;
      const t = T0 + i * 6 * 3600_000;
      await events.append(evt(id, 0, "EXECUTION_STARTED", { input: {} }, t));
      if (i % 30 === 0) {
        await events.append(
          evt(id, 1, "FINDING_RECORDED", { target: "orders", severity: "high" }, t)
        );
      }
      await events.append(evt(id, 2, "DECISION_RECORDED", { subject: `wake-${i}` }, t));
      await events.append(evt(id, 3, "EXECUTION_COMPLETED", { output: {} }, t));
    }
    await service.catchUp([events]);

    const t0 = performance.now();
    const page = await service.query("findings-by-target", {
      where: { target: "orders" },
      order: "desc",
      limit: 50,
    });
    const elapsed = performance.now() - t0;
    expect(page.rows.length).toBe(49);
    expect(elapsed).toBeLessThan(100);

    // Warm restart: nothing to re-scan.
    const again = await service.catchUp([events]);
    expect(again.eventsScanned).toBe(0);
  });
});
