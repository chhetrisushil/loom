import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { bench, describe } from "vitest";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { ReadModelService } from "./ReadModelService";
import type { ReadModelDefinition } from "./types";

// ── The measurement ADR 0092 D6 deferred the purge behind ────────────────────
//
// The gate was "reopen when a measured rebuild cost at production log size exceeds the
// erasure SLA". This is that measurement, in the only form a repo can carry honestly: the
// two erasure paths, over the same corpus, at a size a single machine can hold.
//
// Both bars erase ONE subject out of `OPERATORS`:
//   • purge          — delete the subject's rows. Work is O(rows of that subject).
//   • clear+rebuild  — drop the model and re-derive it from the log. Work is O(whole log),
//                      no matter how few rows the subject had.
//
// The shape is the point, not the absolute numbers: the gap widens with the log, and the
// erased subject's share of it is what a real deployment gets wrong — one operator out of
// a thousand still costs a full re-scan under rebuild.

const EVENTS = 20_000;
const OPERATORS = 50;

const ACTIONS: ReadModelDefinition = {
  id: "actions",
  kinds: ["OPERATOR_ACTION"],
  indexes: ["operator", "tool"],
  extract: (event) => {
    const p = event.payload as { operator: string; tool: string };
    return [{ fields: { operator: p.operator, tool: p.tool } }];
  },
};

function corpus(): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  for (let i = 0; i < EVENTS; i++) {
    const operator = `op-${i % OPERATORS}`;
    events.push({
      id: `e-${i}`,
      workflowId: "wf",
      // One execution per operator: the catch-up scan is per execution, so spreading the
      // corpus this way is what a rebuild actually has to walk.
      executionId: `x-${i % OPERATORS}`,
      eventType: "OPERATOR_ACTION",
      sequence: Math.floor(i / OPERATORS),
      timestamp: 1_000 + i,
      payload: { operator, tool: `t-${i % 7}` },
    });
  }
  return events;
}

async function seed() {
  const events = new InMemoryAsyncEventStore();
  for (const e of corpus()) await events.append(e);
  const store = new InMemoryReadModelStore();
  const service = new ReadModelService(store);
  service.register(ACTIONS);
  await service.catchUp([events]);
  return { service, events };
}

// Seeding is per-iteration but must NOT be timed: both paths need a freshly populated
// model (each is destructive), and leaving the catch-up inside the measured function makes
// the shared setup dominate both bars and understate the difference — the first draft of
// this bench read 2.08x for exactly that reason.
let ready: Awaited<ReturnType<typeof seed>>;

describe(`erasing 1 of ${OPERATORS} subjects from a ${EVENTS}-event corpus`, () => {
  bench(
    "purge — O(subject rows)",
    async () => {
      await ready.service.purge(ACTIONS.id, { operator: "op-7" });
    },
    {
      setup: async () => {
        ready = await seed();
      },
    }
  );

  bench(
    "clear + rebuild — O(log)",
    async () => {
      await ready.service.rebuild(ACTIONS.id, [ready.events]);
    },
    {
      setup: async () => {
        ready = await seed();
      },
    }
  );
});
