import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { bench, describe } from "vitest";
import type { ContentRef } from "./content";
import { ContentResolvingEventStore } from "./ContentResolvingEventStore";
import { type ContentStore, InMemoryContentStore } from "./ContentStore";

// ── ADR 0062 guardrail bench — frozen-snapshot serving (TS-10) ────────────────
//
// 50 externalized refs (one dashboard's widgets) read through a backend with
// ~2ms simulated round-trip latency. Compare: batched getMany (one round-trip)
// vs the no-getMany fallback (coalesced parallel gets) vs the pre-ADR-0062
// baseline shape (serialized per-ref awaits). Budget: p95 ≤ 150ms for ≤ 50 refs
// — the batched path should sit near the single round-trip floor.

const LATENCY_MS = 2;
const WIDGETS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withLatency(inner: InMemoryContentStore, supportsGetMany: boolean): ContentStore {
  const store: ContentStore = {
    put: (bytes) => inner.put(bytes),
    get: async (ref) => {
      await sleep(LATENCY_MS);
      return inner.get(ref);
    },
    delete: (ref) => inner.delete(ref),
  };
  if (supportsGetMany) {
    store.getMany = async (refs: readonly ContentRef[]) => {
      await sleep(LATENCY_MS);
      return inner.getMany(refs);
    };
  }
  return store;
}

function envelope(sequence: number, payload: unknown): EventEnvelope {
  return {
    id: `e-${sequence}`,
    executionId: "x-1",
    workflowId: "w-1",
    eventType: "STEP_COMPLETED",
    sequence,
    timestamp: 1_000 + sequence,
    payload,
  };
}

async function seeded(supportsGetMany: boolean) {
  const memory = new InMemoryContentStore();
  const content = withLatency(memory, supportsGetMany);
  const store = new ContentResolvingEventStore(new InMemoryAsyncEventStore(), content, {
    externalize: { STEP_COMPLETED: ["output.doc"] },
  });
  for (let i = 0; i < WIDGETS; i++) {
    await store.append(envelope(i, { stepId: `hydrate#${i}`, output: { doc: { widget: i } } }));
  }
  return store;
}

let batched: ContentResolvingEventStore | undefined;
let fallback: ContentResolvingEventStore | undefined;

describe(`resolve ${WIDGETS} refs @ ${LATENCY_MS}ms backend latency`, () => {
  bench("getMany (one batched round-trip)", async () => {
    batched ??= await seeded(true);
    await batched.read("x-1");
  });

  bench("no getMany (coalesced parallel gets)", async () => {
    fallback ??= await seeded(false);
    await fallback.read("x-1");
  });

  bench("pre-ADR-0062 shape (serialized per-ref awaits — baseline)", async () => {
    // The old resolver awaited object fields sequentially; emulate its
    // round-trip profile directly against the latency store.
    for (let i = 0; i < WIDGETS; i++) {
      await sleep(LATENCY_MS);
    }
  });
});
