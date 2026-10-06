import { flow$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { type EventStore, InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  PostgresEventStore,
  PostgresSnapshotStore,
  migratePostgresStores,
} from "@loom/plugin-postgres";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { Pool } from "pg";
import { z } from "zod";

// ── ADR 0110 acceptance: do receive / send / commit / resume stay linear? ──────────────────────────
//
//   A  send cost vs inbox stream length            (an O(1) allocation: head() + one append)
//   B  fold cost per MESSAGE_CONSUMED event         (the cursor / dedupe / answer maps are O(1)/event)
//   C  live delivery cost per message               (a drain loop: consume without parking)
//   D  wake-per-message cost at turn n              (each message arrives while parked: resume + re-run)
//
//   LOOM_BENCH_BACKEND=memory|postgres  LOOM_TEST_POSTGRES_URL=postgres://…  node dist/inbox.js
//
// A, B and C must be FLAT in n (per-event cost constant => total linear). D is the one the ADR says
// continue-as-new (R1b) bounds: a resumed run re-runs the flow from the top, so turn n is O(n) in the
// served-from-the-fold calls. It is reported to show WHERE the remaining growth is.

const PG_URL = process.env.LOOM_BENCH_POSTGRES_URL ?? process.env.LOOM_TEST_POSTGRES_URL;
const BACKEND = process.env.LOOM_BENCH_BACKEND ?? (PG_URL !== undefined ? "postgres" : "memory");
const any = z.any();

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

/** A flow that receives `n` messages; `delivered(i)` fires as the i-th reaches it (the bench's clock). */
function drainFlow(
  n: number,
  delivered: (i: number) => void = () => {}
): RegisteredFlow<unknown, unknown> {
  return {
    definition: flow$({
      id: `drain${n}`,
      name: "drain",
      version: "1.0.0",
      inputSchema: any,
      outputSchema: any,
      steps: [],
    }),
    runner: (async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.receive("q");
        delivered(i);
      }
      return n;
    }) as FlowRunner<unknown, unknown>,
  };
}

/** `waitFor(i)` resolves once `delivered(i)` has fired — without polling the log (a poll folds it). */
function turns() {
  const waiting = new Map<number, () => void>();
  const seen = new Set<number>();
  return {
    delivered: (i: number): void => {
      seen.add(i);
      waiting.get(i)?.();
      waiting.delete(i);
    },
    waitFor: (i: number): Promise<void> =>
      seen.has(i) ? Promise.resolve() : new Promise((r) => waiting.set(i, r)),
  };
}

async function main(): Promise<void> {
  let pool: Pool | undefined;
  let stores: () => {
    events: EventStore;
    snaps: PostgresSnapshotStore | InMemoryAsyncSnapshotStore;
  };
  if (BACKEND === "postgres") {
    if (PG_URL === undefined) {
      console.log("SKIP: set LOOM_TEST_POSTGRES_URL for the postgres backend");
      return;
    }
    pool = new Pool({ connectionString: PG_URL, max: 20 });
    await migratePostgresStores(pool);
    const p = pool;
    stores = () => ({ events: new PostgresEventStore(p), snaps: new PostgresSnapshotStore(p) });
  } else {
    stores = () => ({
      events: new InMemoryAsyncEventStore(),
      snaps: new InMemoryAsyncSnapshotStore(),
    });
  }
  const tag = `ib${Date.now().toString(36)}`;
  let seq = 0;
  const boot = () => {
    const s = stores();
    const runtime = new WorkflowRuntime({
      eventStore: s.events,
      snapshotStore: s.snaps,
      effectRuntime: new EffectRuntime(),
      inboxEnabled: true,
      inboxMaxBacklog: 1_000_000,
      onWarn: () => {},
    });
    return { runtime, ...s };
  };
  console.log(`backend=${BACKEND}`);

  // ── A. send vs stream length ────────────────────────────────────────────────────────────────
  {
    const { runtime } = boot();
    const f = drainFlow(1_000_000);
    runtime.registerFlow(f.definition, f.runner);
    const id = `${tag}-A`;
    await (await runtime.start(f, {}, { executionId: id })).waitForSuspend();
    console.log("\nA. send cost vs inbox stream length (owner parked on another topic)");
    console.log("| stream length | median send (us) | p99 (us) |");
    console.log("|---:|---:|---:|");
    let sent = 0;
    for (const target of [0, 1_000, 5_000, 10_000, 20_000]) {
      while (sent < target) {
        await runtime.send(id, { topic: "other", payload: sent });
        sent++;
      }
      const samples: number[] = [];
      for (let i = 0; i < 200; i++) {
        const t = process.hrtime.bigint();
        await runtime.send(id, { topic: "other", payload: i });
        samples.push(Number(process.hrtime.bigint() - t) / 1000);
        sent++;
      }
      samples.sort((a, b) => a - b);
      console.log(
        `| ${target.toLocaleString("en-US")} | ${median(samples).toFixed(0)} | ${(samples[Math.floor(samples.length * 0.99)] as number).toFixed(0)} |`
      );
    }
  }
  console.log(
    "\nB. ReplayVM fold: us per MESSAGE_CONSUMED event (cursor + dedupe window + answer)"
  );
  console.log("| events | total ms | us / event |");
  console.log("|---:|---:|---:|");
  for (const n of [1_000, 4_000, 16_000, 64_000]) {
    const events: EventEnvelope[] = [
      {
        id: "x-0",
        workflowId: "w",
        executionId: "x",
        eventType: "EXECUTION_STARTED",
        sequence: 0,
        timestamp: 0,
        payload: { input: {} },
      },
    ];
    for (let i = 0; i < n; i++) {
      events.push({
        id: `x-${i + 1}`,
        workflowId: "w",
        executionId: "x",
        eventType: "MESSAGE_CONSUMED",
        sequence: i + 1,
        timestamp: i,
        payload: {
          waitId: `#${i}`,
          topic: "q",
          messageId: `m${i}`,
          inboxSeq: i,
          sender: {},
          payload: { i },
        },
        metadata: { kernel: true },
      });
    }
    const reps: number[] = [];
    for (let r = 0; r < 3; r++) {
      const t = process.hrtime.bigint();
      new ReplayVM(events, { executionId: "x", workflowId: "w", workflowVersion: "1" }).getState();
      reps.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    const ms = median(reps);
    console.log(
      `| ${n.toLocaleString("en-US")} | ${ms.toFixed(1)} | ${((ms * 1000) / n).toFixed(2)} |`
    );
  }
  console.log(
    "\nC. send + consume, end to end (the owner drains live while the sends arrive): ms / message"
  );
  console.log("| messages | total ms | ms / message |");
  console.log("|---:|---:|---:|");
  for (const n of [500, 1_000, 2_000, 4_000]) {
    const { runtime } = boot();
    const clock = turns();
    const f = drainFlow(n, clock.delivered);
    runtime.registerFlow(f.definition, f.runner);
    const id = `${tag}-C${n}-${seq++}`;
    // park on the first wait; the first send wakes it, the resumed run consumes the rest live
    await (await runtime.start(f, {}, { executionId: id })).waitForSuspend();
    const t = Date.now();
    for (let i = 0; i < n; i++) await runtime.send(id, { topic: "q", payload: i });
    await clock.waitFor(n - 1);
    const ms = Date.now() - t;
    console.log(`| ${n.toLocaleString("en-US")} | ${ms} | ${(ms / n).toFixed(3)} |`);
  }

  // ── D. wake-per-message turn n ──────────────────────────────────────────────────────────────
  {
    console.log(
      "\nD. wake per message (each arrives while parked: acquire-if-parked resume + re-run from the top)"
    );
    console.log("| turn n | median ms, send -> delivered (turns n-49..n) |");
    console.log("|---:|---:|");
    const { runtime } = boot();
    const total = 400;
    const clock = turns();
    const f = drainFlow(total, clock.delivered);
    runtime.registerFlow(f.definition, f.runner);
    const id = `${tag}-D`;
    await (await runtime.start(f, {}, { executionId: id })).waitForSuspend();
    const lat: number[] = [];
    for (let i = 0; i < total; i++) {
      // let the owner re-park on the next wait (the previous turn fully done), then time one turn
      if (i > 0) await new Promise((r) => setTimeout(r, 2));
      const t = process.hrtime.bigint();
      await runtime.send(id, { topic: "q", payload: i });
      await clock.waitFor(i);
      lat.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    for (const n of [50, 100, 200, 400]) {
      console.log(`| ${n} | ${median(lat.slice(n - 50, n)).toFixed(2)} |`);
    }
  }

  await pool?.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
