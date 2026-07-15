import { virtualClock } from "@loom/dst";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { isClaimCheck, resolveClaimCheck } from "@loom/middleware";
import type { ClaimCheckEnvelope } from "@loom/middleware";
import { contentAddress, sweepUnpinnedContent } from "@loom/plugin-content";
import { foldEvents } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { InputValidationError, LogLifecycle, TimerService } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { FINDING_RECORDED, type Finding, migrations } from "../src/domain";
import { deploySentinel, fireOccurrence, newWorld } from "../src/harness";
import { INLINE_CAP_BYTES, SENTINEL_SCHEDULE, occurrenceId } from "../src/sentinel";
import { DAY, HOUR, SIM_START, isAnomalyTime } from "../src/substrate";

// ── The requirements-doc §7 acceptance criteria, run as one simulated year ────
//
// 6-hour cadence (CADENCE below) keeps CI fast; the properties are cadence-
// independent and the constants are the only knob. Everything is a pure
// function of simulated time, so the year replays bit-identically.

const CADENCE = 6 * HOUR;
const WAKES = (365 * DAY) / CADENCE; // 1460
const MID = SIM_START + 182 * DAY; // the v1 → v2 deploy boundary (early July)
const OUTAGE = { from: SIM_START + 73 * DAY, to: SIM_START + 74 * DAY }; // Mar 15, 24h
const YEAR_END = SIM_START + 365 * DAY;

interface YearRun {
  world: ReturnType<typeof newWorld>;
  ids: string[];
  expected: { findings: number; staleWakes: number };
}

async function runYear(): Promise<YearRun> {
  const world = newWorld();
  const clock = virtualClock(SIM_START); // event timestamps carry SIMULATED time
  const now = (): number => clock.now();
  let deploy = deploySentinel(world, 1, { outages: [OUTAGE] }, now);
  const ids: string[] = [];
  let expectedFindings = 0;
  let expectedStale = 0;
  let migrated = false;

  for (let i = 0; i < WAKES; i++) {
    const t = SIM_START + i * CADENCE;
    clock.advanceTo(t);
    if (!migrated && t >= MID) {
      deploy = deploySentinel(world, 2, { outages: [OUTAGE] }, now); // mid-chain contract deploy
      migrated = true;
    }
    const { outcome, state } = await fireOccurrence(deploy, t);
    expect(outcome).toBe("started");
    expect(state.status).toBe("completed"); // zero stuck or failed wakes, outage included
    ids.push(occurrenceId(t));
    const stale = t >= OUTAGE.from && t < OUTAGE.to;
    if (stale) expectedStale++;
    if (!stale && isAnomalyTime(t)) expectedFindings++;
  }
  return { world, ids, expected: { findings: expectedFindings, staleWakes: expectedStale } };
}

// One shared year for the suite — building it once keeps the file fast.
const yearPromise = runYear();

describe("db-sentinel — 12 simulated months (requirements §7)", () => {
  it("1. every wake is its own bounded execution: event budget + no over-cap payloads in the log", async () => {
    const { world, ids } = await yearPromise;
    expect(ids.length).toBe(WAKES);
    let offloaded = 0;
    for (const id of ids) {
      const events = await world.eventStore.read(id);
      expect(events.length).toBeLessThanOrEqual(12); // wake, state load/save, read, finding, terminal
      for (const e of events) {
        expect(JSON.stringify(e.payload).length).toBeLessThanOrEqual(INLINE_CAP_BYTES + 1024);
      }
      const read = events.find(
        (e) =>
          e.eventType === "STEP_COMPLETED" &&
          (e.payload as { stepId: string }).stepId === "read-telemetry"
      );
      const output = (read?.payload as { output: unknown }).output;
      if (isClaimCheck(output)) offloaded++;
    }
    expect(offloaded).toBe(WAKES - 4); // every non-stale read went by reference
  });

  it("2. findings match the anomaly model exactly, across the mid-year deploy", async () => {
    const { world, ids, expected } = await yearPromise;
    const findings: { id: string; finding: Finding }[] = [];
    for (const id of ids) {
      for (const e of await world.eventStore.read(id)) {
        if (e.eventType === FINDING_RECORDED) findings.push({ id, finding: e.payload as Finding });
      }
    }
    expect(findings.length).toBe(expected.findings);
    expect(findings.length).toBeGreaterThan(10);
    expect(findings.some((f) => f.finding.actingVersion === 1)).toBe(true);
    expect(findings.some((f) => f.finding.actingVersion === 2)).toBe(true); // continued after the deploy
    for (const { finding } of findings) expect(finding.evidence.length).toBe(1);
  });

  it("3. carry state: one CAS revision per wake; the v1→v2 migration was applied, recorded, and needed no intervention", async () => {
    const { world, ids } = await yearPromise;
    const record = await world.stateStore.load("sentinel:pg-sentinel");
    expect(record?.revision).toBe(WAKES);
    expect(record?.contractVersion).toBe(2);
    expect((record?.payload as { wakes: number }).wakes).toBe(WAKES);

    // The first v2 wake's recorded load output carries the migration fact.
    const firstV2 = ids.find((id) => Number(id.slice(id.indexOf("@") + 1)) >= MID)!;
    const load = (await world.eventStore.read(firstV2)).find(
      (e) =>
        e.eventType === "STEP_COMPLETED" &&
        (e.payload as { stepId: string }).stepId === "pg-sentinel.state.load"
    );
    expect((load?.payload as { output: { migrated: unknown } }).output.migrated).toEqual({
      from: 1,
      to: 2,
    });
  });

  it("4. ingestion outage: stale-marked, recorded, completed wakes — never a hang", async () => {
    const { world, expected } = await yearPromise;
    expect(expected.staleWakes).toBe(4);
    const outageId = occurrenceId(OUTAGE.from);
    const events = await world.eventStore.read(outageId);
    const read = events.find(
      (e) =>
        e.eventType === "STEP_COMPLETED" &&
        (e.payload as { stepId: string }).stepId === "read-telemetry"
    );
    // Stale reads are small and honest: recorded INLINE with the staleness marker.
    const output = (read?.payload as { output: { stale: boolean; asOf: number } }).output;
    expect(isClaimCheck(output)).toBe(false);
    expect(output.stale).toBe(true);
    expect(output.asOf).toBe(OUTAGE.from);
    expect(foldEvents([...events]).status).toBe("completed");
  });

  it("5. T1 idempotent starts: re-firing an occurrence is a no-op", async () => {
    const { world, ids } = await yearPromise;
    const deploy = deploySentinel(world, 2, { outages: [OUTAGE] });
    const before = await world.eventStore.read(ids[100]!);
    const refire = await fireOccurrence(deploy, SIM_START + 100 * CADENCE);
    expect(refire.outcome).toBe("skipped");
    expect(await world.eventStore.read(ids[100]!)).toEqual(before);
  });

  it("6. retention (K10.1 + K10.5): archive runs 60d+, reclaim telemetry blobs 30d+ — every finding's evidence survives, hash-verifiable", async () => {
    const { world, ids } = await yearPromise;

    // Collect evidence + a couple of telemetry refs BEFORE pruning.
    const evidence: string[] = [];
    let earlyTelemetry: string | undefined;
    let recentTelemetry: string | undefined;
    for (const id of ids) {
      const t = Number(id.slice(id.indexOf("@") + 1));
      for (const e of await world.eventStore.read(id)) {
        if (e.eventType === FINDING_RECORDED) {
          for (const ref of (e.payload as Finding).evidence) evidence.push(ref.__loomContent);
        }
        if (e.eventType === "STEP_COMPLETED") {
          const output = (e.payload as { output: unknown }).output;
          if (isClaimCheck(output) && !isAnomalyTime(t)) {
            if (t < SIM_START + 7 * DAY) earlyTelemetry ??= output.ref.__loomContent;
            if (t >= YEAR_END - 7 * DAY) recentTelemetry ??= output.ref.__loomContent;
          }
        }
      }
    }
    expect(evidence.length).toBeGreaterThan(10);

    // K10.1 — archive-before-delete for everything older than 60 days.
    const archive = {
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
    };
    const lifecycle = new LogLifecycle(world.eventStore, world.snapshotStore, { archive });
    let reclaimed = 0;
    for (const id of ids) {
      if (
        (await lifecycle.applyRetention(id, { terminalTtlMs: 60 * DAY }, YEAR_END)) === "reclaimed"
      ) {
        reclaimed++;
      }
    }
    expect(reclaimed).toBeGreaterThan(1000); // ~10 months of runs archived + deleted

    // K10.5 — pinned mark-and-sweep across LIVE + ARCHIVE stores.
    const report = await sweepUnpinnedContent({
      eventStores: [world.eventStore, archive.eventStore],
      contentStore: world.contentStore,
      pinnedEventTypes: [FINDING_RECORDED],
      olderThanMs: 30 * DAY,
      now: YEAR_END,
    });
    expect(report.refsPinned).toBe(new Set(evidence).size);
    expect(report.reclaimed.length).toBeGreaterThan(1000);

    // The acceptance criterion: month-1 findings' evidence — in ARCHIVED runs —
    // resolves byte-for-byte against its recorded hash; disposable telemetry is gone.
    for (const address of evidence) {
      const bytes = await world.contentStore.get({ __loomContent: address });
      expect(bytes).not.toBeNull();
      expect(contentAddress(bytes as Uint8Array)).toBe(address);
    }
    expect(await world.contentStore.get({ __loomContent: earlyTelemetry! })).toBeNull();
    expect(await world.contentStore.get({ __loomContent: recentTelemetry! })).not.toBeNull();
  });

  it("7. replay is scoped, fast, and never touches the content store", async () => {
    const { world, ids } = await yearPromise;
    const id = ids[ids.length - 3]!; // a recent wake still in the live store
    const events = await world.eventStore.read(id);
    const t0 = performance.now();
    const folded = foldEvents([...events]);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(folded.status).toBe("completed");
    // The fold consumed envelopes as VALUES — the content store is not involved.
    const read = events.find(
      (e) =>
        e.eventType === "STEP_COMPLETED" &&
        (e.payload as { stepId: string }).stepId === "read-telemetry"
    );
    expect(isClaimCheck((read?.payload as { output: unknown }).output)).toBe(true);
  });
});

describe("db-sentinel — contract stall + recovery (DS-3) and boundary validation", () => {
  it("a deploy WITHOUT a migration path stalls loudly; registering it resumes cleanly", async () => {
    const world = newWorld();
    const v2 = deploySentinel(world, 2);
    await fireOccurrence(v2, SIM_START); // seeds v2 state at revision 1

    // v3 deployed with NO 2→3 migration: the next wake FAILS, visibly.
    const broken = deploySentinel(world, 3, { migrationsOverride: { 1: migrations[1] } });
    const bad = await fireOccurrence(broken, SIM_START + CADENCE);
    expect(bad.state.status).toBe("failed");
    const failed = (await world.eventStore.read(occurrenceId(SIM_START + CADENCE))).find(
      (e) => e.eventType === "STEP_FAILED"
    );
    expect(String((failed?.payload as { error: string }).error)).toMatch(/no-migration-path/);

    // Register the migration (the "manual intervention" is a code fix, not surgery):
    const fixed = deploySentinel(world, 3);
    const good = await fireOccurrence(fixed, SIM_START + 2 * CADENCE);
    expect(good.state.status).toBe("completed");
    const record = await world.stateStore.load("sentinel:pg-sentinel");
    expect(record?.contractVersion).toBe(3);
    expect((record?.payload as { lastFindingAt: number | null }).lastFindingAt).toBeNull();
  });

  it("validateInput (ADR 0051 D7): a malformed start refuses before anything is appended", async () => {
    const world = newWorld();
    const deploy = deploySentinel(world, 1);
    const err = await deploy.runtime
      .start(deploy.sentinel.flow, { thresholdLagMs: -5 }, { executionId: "bad-input" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InputValidationError);
    expect(await world.eventStore.read("bad-input")).toEqual([]);
  });
});

describe("db-sentinel — the schedule really drives it (T1 under virtual time)", () => {
  it("TimerService fires cron occurrences deterministically and idempotently", async () => {
    const world = newWorld();
    const clock = virtualClock(SIM_START + 1); // just past a boundary
    const now = (): number => clock.now();
    const deploy = deploySentinel(world, 1, {}, now);
    const timers = new TimerService(deploy.runtime, new InMemoryTimerStore(), {
      schedules: [SENTINEL_SCHEDULE],
      now, // cron cursors anchor at SIMULATED construction time
    });

    clock.advanceTo(SIM_START + 6 * HOUR);
    await timers.tick(clock.now());
    await timers.tick(clock.now()); // idempotent re-tick
    clock.advanceTo(SIM_START + 12 * HOUR);
    await timers.tick(clock.now());

    const first = await deploy.runtime.loadState(occurrenceId(SIM_START + 6 * HOUR));
    const second = await deploy.runtime.loadState(occurrenceId(SIM_START + 12 * HOUR));
    expect(first?.status).toBe("completed");
    expect(second?.status).toBe("completed");
    expect((await world.stateStore.load("sentinel:pg-sentinel"))?.revision).toBe(2); // exactly two wakes
  });
});

describe("db-sentinel — evidence is readable OUTSIDE the determinism boundary (CC-4)", () => {
  it("resolveClaimCheck renders a finding's evidence; erased telemetry reads null", async () => {
    const { world, ids } = await yearPromise;
    // (Runs after test 6's pruning thanks to suite order — evidence is pinned.)
    for (const id of ids.slice(-40)) {
      for (const e of await world.eventStore.read(id)) {
        if (e.eventType !== "STEP_COMPLETED") continue;
        const output = (e.payload as { output: unknown }).output;
        if (isClaimCheck(output)) {
          const payload = await resolveClaimCheck<{ rows: unknown[] }>(
            world.contentStore,
            output as ClaimCheckEnvelope
          );
          if (payload !== null) {
            expect(payload.rows.length).toBe(120);
            return;
          }
        }
      }
    }
    throw new Error("expected at least one resolvable recent telemetry payload");
  });
});
