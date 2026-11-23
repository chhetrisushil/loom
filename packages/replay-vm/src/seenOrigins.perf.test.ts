import type { EventEnvelope, ExecutionState } from "@loomwork/core";
import { describe, it } from "vitest";
import { ReplayVM } from "./ReplayVM";
import { foldEvents } from "./foldEvents";
import { seenOriginsRecord } from "./seenOriginsRecord";

// PERF (ADR 0152 D1, R11): (1) the FOLD of a TRACKED run (the start carries the `seenOriginsLimits` stamp and
// channel events carry their recorded `metadata.origins`) against the same log UNTRACKED (the 1.26 path), and
// (2) the LIVE commit-time scan cost (`stampSeenOrigins`: the walk, once). Numbers are printed, not asserted:
// timing ratios never gate a merge (see foldScale.perf.test.ts).

// the journal's stamp (S2a3) is the record plus a strip of caller keys; the perf test needs only the record
const stampSeenOrigins = (
  before: ExecutionState | undefined,
  eventType: string,
  payload: unknown,
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined => {
  const rec = seenOriginsRecord(before, eventType, payload, metadata);
  return rec === undefined ? metadata : { ...metadata, ...rec };
};

const ev = (
  sequence: number,
  eventType: string,
  payload: unknown,
  metadata?: Record<string, unknown>
): EventEnvelope => ({
  id: `x-${sequence}`,
  workflowId: "wf",
  executionId: "x",
  eventType,
  sequence,
  timestamp: 1000 + sequence,
  payload,
  ...(metadata !== undefined && { metadata }),
});

const best = (runs: number, fn: () => void): number => {
  fn();
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    min = Math.min(min, performance.now() - t);
  }
  return min;
};

const STAMP = { maxOrigins: 1024, maxScanNodes: 100_000 };

/** The log as the journal would have written it: records stamped at commit when `tracked`. */
function log(n: number, tracked: boolean, out: (i: number) => unknown): EventEnvelope[] {
  const startPayload = { input: {}, ...(tracked && { seenOriginsLimits: STAMP }) };
  const evs = [ev(0, "EXECUTION_STARTED", startPayload, tracked ? { origins: [] } : undefined)];
  const vm = new ReplayVM(evs); // keeps fold ownership, so building the log stays O(n)
  for (let i = 1; i <= n; i++) {
    const payload = { stepId: `s${i}`, output: out(i) };
    const meta = stampSeenOrigins(vm.peekState(), "STEP_COMPLETED", payload, undefined);
    const e = ev(i, "STEP_COMPLETED", payload, meta);
    evs.push(e);
    vm.applyEvent(e);
  }
  return evs;
}

function report(name: string, n: number, off: EventEnvelope[], on: EventEnvelope[]): void {
  const tOff = best(7, () => foldEvents(off));
  const tOn = best(7, () => foldEvents(on));
  const pct = ((tOn - tOff) / tOff) * 100;
  console.log(
    `[seenOrigins perf] FOLD ${name}: events=${n} untracked=${tOff.toFixed(1)}ms tracked=${tOn.toFixed(1)}ms (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`
  );
}

describe("seen-origins fold cost (records on vs untracked)", { timeout: 120_000 }, () => {
  it("(a) taint-free large outputs (~2000 JSON nodes each)", () => {
    const big = (i: number) => ({
      rows: Array.from({ length: 400 }, (_, r) => ({ id: r, name: `n${r}`, tags: ["a", "b"], i })),
    });
    report("a taint-free 2000 nodes/event", 3000, log(3000, false, big), log(3000, true, big));
  });
  it("(b) many small tainted outputs", () => {
    const small = (i: number) => ({
      __loomTainted: { origin: `mcp:tool${i % 32}` },
      value: { n: i },
    });
    report("b small tainted", 30_000, log(30_000, false, small), log(30_000, true, small));
  });
  it("(c) the through advance on every event of a tracked run (cheap events)", () => {
    const cheap = (n: number, tracked: boolean) => {
      const evs = [
        ev(
          0,
          "EXECUTION_STARTED",
          { input: {}, ...(tracked && { seenOriginsLimits: STAMP }) },
          tracked ? { origins: [] } : undefined
        ),
      ];
      for (let i = 1; i <= n; i++) evs.push(ev(i, "STEP_STARTED", { stepId: `s${i % 50}` }));
      return evs;
    };
    report("c cheap events (through only)", 100_000, cheap(100_000, false), cheap(100_000, true));
  });
});

describe(
  "live commit-scan cost (the walk, once per event, tracked runs only)",
  { timeout: 120_000 },
  () => {
    it("per node and per event", () => {
      const state = foldEvents([
        ev(0, "EXECUTION_STARTED", { input: {}, seenOriginsLimits: STAMP }, { origins: [] }),
      ]);
      for (const [name, nodes] of [
        ["200 nodes", 50],
        ["2000 nodes", 500],
        ["20000 nodes", 5000],
      ] as const) {
        const payload = {
          output: {
            rows: Array.from({ length: nodes }, (_, r) => ({
              id: r,
              name: `n${r}`,
              tags: ["a", "b"],
            })),
          },
        };
        const reps = Math.max(5, Math.floor(200_000 / nodes / 4));
        const t = best(5, () => {
          for (let i = 0; i < reps; i++)
            stampSeenOrigins(state, "STEP_COMPLETED", payload, undefined);
        });
        const perEvent = (t / reps) * 1000;
        const count = nodes * 6 + 2; // each row: object + id + name + array + 2 tags
        console.log(
          `[seenOrigins perf] LIVE commit scan ${name}: ${perEvent.toFixed(1)}us/event, ~${((perEvent * 1000) / count).toFixed(0)}ns/node`
        );
      }
    });
  }
);
