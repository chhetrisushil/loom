import { unwrapTainted } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import {
  type EventStore,
  INBOX_TOPIC_SEQ_BASE,
  headOf,
  inboxTopicStreamId,
  quarantineStreamId,
} from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore, type KeyStore } from "@loom/plugin-crypto";
import type { WorkflowRuntimeDeps } from "../WorkflowRuntime";
import { dedupeKeyOf, inboxStreamId, registerInboxTopic } from "../inbox";
import type { Backend } from "./r2Backends";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { type Harness, build, flow, sealedSnapshots } from "./r2Harness";

// Shared fixtures for the ADR 0130 residuals S5 (quarantine) tests: a FLEET of runtimes over ONE set
// of raw stores, a capable node (an EncryptingEventStore that seals and opens the inbox) and an
// incapable one (no crypto at all). Sealed messages are written straight into the inbox stream
// through the sealing store (no `send`, so no wake and no early delivery by the capable node).

export const SECRET = "123-45-6789";
export const OP = { actor: "ops", tenant: "t1" };
export const SENSITIVE = { MESSAGE_CONSUMED: ["payload"], INBOX_MESSAGE: ["payload"] } as const;

export type Raw = ReturnType<Backend["make"]>;

export function sealingStore(raw: EventStore, keys: KeyStore, subjectOf?: (e: never) => string) {
  return new EncryptingEventStore(raw, keys, {
    sensitive: { ...SENSITIVE },
    subjectOf: (subjectOf as never) ?? ((e: { executionId: string }) => e.executionId),
  });
}

export interface Fleet {
  raw: Raw;
  keys: KeyStore;
  /** A capable node: seals and opens. */
  a: Harness;
  /** An INCAPABLE node: no crypto at all. */
  b: Harness;
  /** A second capable node over the same stores. */
  a2(deps?: Partial<WorkflowRuntimeDeps>): Harness;
}

export function fleet(
  raw: Raw,
  opts: {
    a?: Partial<WorkflowRuntimeDeps>;
    b?: Partial<WorkflowRuntimeDeps>;
    keys?: KeyStore;
    subjectOf?: (e: never) => string;
  } = {}
): Fleet {
  const keys = opts.keys ?? new InMemoryKeyStore();
  const sealing = sealingStore(raw.eventStore, keys, opts.subjectOf);
  const a = build(opts.a ?? {}, {
    ...raw,
    eventStore: sealing,
    // ADR 0130 D8: the capable node checkpoints through a sealState store on the same keys
    snapshotStore: sealedSnapshots(sealing, raw.snapshotStore),
  });
  // The INCAPABLE node cannot open a sealed checkpoint (it holds no keys), so it gets its OWN empty
  // snapshot store and folds from the log: a sealed checkpoint it shared with `a` would refuse every
  // operator op it runs (`foldState` reads the snapshot first). Finding reported with ADR 0130 D8: a
  // key-less node sharing a snapshot table with sealed checkpoints cannot fold an execution.
  const b = build(opts.b ?? {}, { ...raw, snapshotStore: new InMemoryAsyncSnapshotStore() });
  return {
    raw,
    keys,
    a,
    b,
    a2: (deps) => {
      const es = sealingStore(raw.eventStore, keys, opts.subjectOf);
      return build(deps ?? opts.a ?? {}, {
        ...raw,
        eventStore: es,
        snapshotStore: sealedSnapshots(es, raw.snapshotStore),
      });
    },
  };
}

/** A node whose key store LACKS the owner's key: a wrong-key node (reads the inbox as REDACTED). */
export function wrongKeyNode(raw: Raw, deps: Partial<WorkflowRuntimeDeps> = {}): Harness {
  const es = sealingStore(raw.eventStore, new InMemoryKeyStore());
  return build(deps, {
    ...raw,
    eventStore: es,
    // its own wrong keys: it can checkpoint, but cannot open the owner's sealed checkpoints
    snapshotStore: sealedSnapshots(es, raw.snapshotStore),
  });
}

/**
 * Append one inbox message at the stream head + 1 through `store`: the capable node's sealing store
 * for a SEALED message, any store for a plain one. `perTopic` writes the topic's own stream.
 */
export async function put(
  store: EventStore,
  executionId: string,
  m: { topic: string; messageId: string; payload: unknown; sender?: object },
  opts: { perTopic?: boolean; timestamp?: number } = {}
): Promise<number> {
  const stream = opts.perTopic
    ? inboxTopicStreamId(executionId, m.topic)
    : inboxStreamId(executionId);
  if (opts.perTopic) await registerInboxTopic(store, executionId, m.topic, 64, () => Date.now());
  const head = await headOf(store, stream);
  const sequence = head === null ? (opts.perTopic ? INBOX_TOPIC_SEQ_BASE : 0) : head + 1;
  await store.append({
    id: `${stream}-${sequence}`,
    executionId: stream,
    workflowId: "__loom_inbox__",
    sequence,
    eventType: "INBOX_MESSAGE",
    timestamp: opts.timestamp ?? Date.now(),
    payload: { topic: m.topic, messageId: m.messageId, payload: m.payload, sender: m.sender ?? {} },
  } as EventEnvelope);
  return sequence;
}

export const keyOf = (messageId: string): string => dedupeKeyOf({ messageId, sender: {} });

/** A flow that selects over topics `a` and `b` `n` times and returns what it received, in order. */
export function collector(n: number, topics: readonly string[] = ["a", "b"]) {
  return flow("collector", async (ctx) => {
    const got: Array<[string, unknown]> = [];
    while (got.length < n) {
      const r = await ctx.select<unknown>(topics.map((t) => ({ inbox: t })));
      got.push([topics[r.arm] as string, unwrapTainted(r.value)]);
    }
    return got;
  });
}

export async function eventsByKind(store: EventStore, id: string, kind: string) {
  return (await store.read(id)).filter((e) => e.eventType === kind);
}

/** Every event kind of the owner's log, in order. */
export async function kindsOf(store: EventStore, id: string): Promise<string[]> {
  return (await store.read(id)).map((e) => e.eventType);
}

export async function quarantineHead(raw: EventStore, chainId: string): Promise<number | null> {
  return headOf(raw, quarantineStreamId(chainId));
}

/** The delivered (non-discard, non-duplicate) payload sequence per topic from the owner's raw log. */
export function consumedOf(events: readonly EventEnvelope[]) {
  return events
    .filter((e) => e.eventType === "MESSAGE_CONSUMED")
    .map(
      (e) =>
        e.payload as {
          topic: string;
          messageId: string;
          inboxSeq: number;
          payload: unknown;
          discarded?: boolean;
          waitId?: string;
        }
    );
}

/** One injected crash: the append (or batch) whose envelopes satisfy `match`, before or after it lands. */
export interface Fault {
  match: (events: readonly EventEnvelope[]) => boolean;
  when: "before" | "after";
  /** Fire this many times (default 1). */
  times?: number;
}

export class SimulatedCrash extends Error {
  constructor() {
    super("simulated crash");
    this.name = "SimulatedCrash";
  }
}

/**
 * A store view that injects crashes at chosen appends and records every write as
 * `append:KIND` / `batch:KIND,KIND` (so a test can assert two facts were never written separately).
 */
export function faultStore(inner: EventStore, faults: Fault[] = []) {
  const view = Object.create(inner) as EventStore;
  const writes: string[] = [];
  const fired = new Map<Fault, number>();
  const check = (events: readonly EventEnvelope[], when: "before" | "after"): boolean => {
    for (const f of faults) {
      if (f.when !== when || !f.match(events)) continue;
      const n = fired.get(f) ?? 0;
      if (n >= (f.times ?? 1)) continue;
      fired.set(f, n + 1);
      return true;
    }
    return false;
  };
  view.append = async (e) => {
    writes.push(`append:${e.eventType}`);
    if (check([e], "before")) throw new SimulatedCrash();
    await inner.append(e);
    if (check([e], "after")) throw new SimulatedCrash();
  };
  view.appendBatch = async (es) => {
    writes.push(`batch:${es.map((e) => e.eventType).join(",")}`);
    if (check(es, "before")) throw new SimulatedCrash();
    await inner.appendBatch?.(es);
    if (check(es, "after")) throw new SimulatedCrash();
  };
  return {
    store: view,
    writes,
    arm: (f: Fault) => faults.push(f),
    /** Stop injecting (pending faults are dropped). */
    disarm: () => {
      faults.length = 0;
    },
    firedCount: () => [...fired.values()].reduce((a, b) => a + b, 0),
  };
}

export const hasKind =
  (kind: string, pred: (e: EventEnvelope) => boolean = () => true) =>
  (events: readonly EventEnvelope[]): boolean =>
    events.some((e) => e.eventType === kind && pred(e));
