import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@loomwork/core";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { SqliteEventStore } from "@loomwork/plugin-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "./cli";
import { renderLs, scanExecutions } from "./ls";

const T0 = 1_700_000_000_000;
const INDOUBT = "EffectInDoubtResolved";

async function log(
  store: { append(e: EventEnvelope): Promise<void> },
  id: string,
  events: Array<[string, unknown, Record<string, unknown>?]>,
  at = T0
): Promise<void> {
  let sequence = 0;
  for (const [eventType, payload, metadata] of events) {
    await store.append({
      id: `${id}-${sequence}`,
      executionId: id,
      workflowId: "wf",
      eventType,
      sequence,
      timestamp: at + sequence,
      payload,
      ...(metadata !== undefined && { metadata }),
    } as EventEnvelope);
    sequence++;
  }
}

const started: [string, unknown] = ["EXECUTION_STARTED", { input: {} }];
const stepStarted = (stepId: string): [string, unknown] => ["STEP_STARTED", { stepId, input: {} }];
const inDoubt = (stepId: string): [string, unknown] => [
  "EFFECT_INDOUBT",
  { stepId, toolId: `${stepId}-tool`, attempts: 1 },
];
const parkedOn = (stepId: string): [string, unknown] => [
  "EXECUTION_SUSPENDED",
  { condition: { on: INDOUBT, correlationKey: stepId } },
];
const twoInDoubt: Array<[string, unknown]> = [
  started,
  stepStarted("refund"),
  stepStarted("cancel-sub"),
  ["EXECUTION_RECOVERED", {}],
  inDoubt("refund"),
  inDoubt("cancel-sub"),
  parkedOn("refund"),
];

async function seeded(): Promise<InMemoryAsyncEventStore> {
  const store = new InMemoryAsyncEventStore();
  await log(store, "two", twoInDoubt);
  await log(store, "gate", [
    started,
    ["EXECUTION_SUSPENDED", { condition: { on: "ApprovalGranted" } }],
  ]);
  await log(store, "timer", [
    started,
    ["EXECUTION_SUSPENDED", { condition: { on: "timer", wakeAt: T0 + 60_000 } }],
  ]);
  await log(store, "done", [started, ["EXECUTION_COMPLETED", { output: 1 }]]);
  return store;
}

const ids = (r: { rows: Array<{ executionId: string }> }) => r.rows.map((row) => row.executionId);

describe("loom ls --waiting-on", () => {
  it("keeps only executions waiting on that event", async () => {
    const store = await seeded();
    expect(ids(await scanExecutions(store, { waitingOn: INDOUBT, now: T0 }))).toEqual(["two"]);
    expect(ids(await scanExecutions(store, { waitingOn: "ApprovalGranted", now: T0 }))).toEqual([
      "gate",
    ]);
    expect(ids(await scanExecutions(store, { waitingOn: "nothing", now: T0 }))).toEqual([]);
  });

  it("timer matches any park with a timer", async () => {
    const store = await seeded();
    await log(store, "gate-with-timeout", [
      started,
      ["EXECUTION_SUSPENDED", { condition: { on: "Go", wakeAt: T0 + 1 } }],
    ]);
    const matched = ids(await scanExecutions(store, { waitingOn: "timer", now: T0 }));
    expect(matched.sort()).toEqual(["gate-with-timeout", "timer"]);
  });

  it("matches a multi-wait park's gate and inbox arms", async () => {
    const store = new InMemoryAsyncEventStore();
    await log(store, "select", [
      started,
      [
        "EXECUTION_SUSPENDED",
        {
          condition: {
            on: "first",
            waits: [
              { waitId: "#0", kind: "gate", on: "first" },
              { waitId: "#1", kind: "gate", on: "second" },
              { waitId: "#2", kind: "inbox", topic: "mail" },
            ],
          },
        },
        // The fold only honours `waits` on a kernel-stamped park.
        { kernel: true },
      ],
    ]);
    for (const name of ["first", "second", "mail"]) {
      expect(ids(await scanExecutions(store, { waitingOn: name, now: T0 }))).toEqual(["select"]);
    }
  });

  it("filters before --limit, so a newer run cannot hide an older match", async () => {
    const store = new InMemoryAsyncEventStore();
    await log(store, "old-in-doubt", twoInDoubt, T0);
    for (let i = 0; i < 5; i++) {
      await log(
        store,
        `newer-${i}`,
        [started, ["EXECUTION_SUSPENDED", { condition: { on: "Go" } }]],
        T0 + 1_000 * (i + 1)
      );
    }
    const unfiltered = await scanExecutions(store, { status: "suspended", limit: 2, now: T0 });
    expect(ids(unfiltered)).not.toContain("old-in-doubt");
    const filtered = await scanExecutions(store, { waitingOn: INDOUBT, limit: 2, now: T0 });
    expect(ids(filtered)).toEqual(["old-in-doubt"]);
  });

  it("a terminal execution never matches, even if it once waited", async () => {
    const store = new InMemoryAsyncEventStore();
    await log(store, "finished", [
      started,
      ["EXECUTION_SUSPENDED", { condition: { on: "Go" } }],
      ["EXECUTION_RESUMED", null],
      ["EXECUTION_COMPLETED", { output: 1 }],
    ]);
    expect(ids(await scanExecutions(store, { waitingOn: "Go", now: T0 }))).toEqual([]);
  });
});

describe("loom ls in-doubt steps", () => {
  it("lists every step awaiting a verdict, not only the one the park names", async () => {
    const result = await scanExecutions(await seeded(), { waitingOn: INDOUBT, now: T0 });
    expect(result.rows[0]?.waiting?.inDoubtSteps).toEqual(["refund", "cancel-sub"]);
    expect(renderLs(result, { limit: 50, now: T0 })).toContain("in doubt: refund, cancel-sub");
  });

  it("drops a step once it has a verdict and has settled", async () => {
    const store = new InMemoryAsyncEventStore();
    await log(store, "x", [
      ...twoInDoubt,
      [INDOUBT, { stepId: "refund", resolution: "completed-with-result", output: {} }],
      [
        "DECISION_RECORDED",
        {
          decisionId: "__loom_indoubt__:refund:1",
          choice: { stepId: "refund", resolution: "completed-with-result" },
          source: "operator",
        },
      ],
      ["EXECUTION_RESUMED", null],
      ["STEP_COMPLETED", { stepId: "refund", output: {} }],
      parkedOn("cancel-sub"),
    ]);
    const result = await scanExecutions(store, { now: T0 });
    expect(result.rows[0]?.waiting?.inDoubtSteps).toEqual(["cancel-sub"]);
  });

  it("drops a step whose latest attempt has a verdict, before the step settles", async () => {
    const store = new InMemoryAsyncEventStore();
    await log(store, "x", [
      ...twoInDoubt,
      [
        "DECISION_RECORDED",
        {
          decisionId: "__loom_indoubt__:refund:1",
          choice: { stepId: "refund", resolution: "retry-fresh" },
          source: "operator",
        },
      ],
      parkedOn("cancel-sub"),
    ]);
    const result = await scanExecutions(store, { now: T0 });
    expect(result.rows[0]?.waiting?.inDoubtSteps).toEqual(["cancel-sub"]);
  });

  it("an ordinary gate park has no in-doubt list", async () => {
    const result = await scanExecutions(await seeded(), { waitingOn: "ApprovalGranted", now: T0 });
    expect(result.rows[0]?.waiting?.inDoubtSteps).toBeUndefined();
  });
});

describe("loom ls --waiting-on through the CLI", () => {
  let dir: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("filters and reports in JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-ls-waiting-"));
    const db = join(dir, "events.db");
    const store = new SqliteEventStore(db);
    await log(store, "two", twoInDoubt);
    await log(store, "gate", [
      started,
      ["EXECUTION_SUSPENDED", { condition: { on: "ApprovalGranted" } }],
    ]);
    await store.close();
    const printed: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      printed.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      printed.push(`${args.join(" ")}\n`);
    });
    expect(await run(["ls", "--db", db, "--waiting-on", INDOUBT, "--json"])).toBe(0);
    const out = JSON.parse(printed.join(""));
    expect(out.executions).toHaveLength(1);
    expect(out.executions[0].executionId).toBe("two");
    expect(out.executions[0].waiting.inDoubtSteps).toEqual(["refund", "cancel-sub"]);
  });
});
