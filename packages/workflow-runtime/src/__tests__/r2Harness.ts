import { step$ } from "@loom/core";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import {
  type EventStore,
  InMemoryAsyncEventStore,
  InMemoryTimerStore,
  type TimerStore,
} from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore, type SnapshotStore } from "@loom/snapshot-runtime";
import { z } from "zod";
import { WorkflowRuntime } from "../WorkflowRuntime";
import type { WorkflowRuntimeDeps } from "../WorkflowRuntime";
import type { ExecutionHandle, FlowRunner, RegisteredFlow } from "../types";

// Shared harness for the R2 (ADR 0110) tests.

const io = { inputSchema: z.any(), outputSchema: z.any() };
export const echo = step$({ id: "echo", name: "Echo", toolId: "echo", ...io });
export const slow = step$({ id: "slow", name: "Slow", toolId: "slow", ...io });

export function flow<I = unknown, O = unknown>(
  id: string,
  runner: FlowRunner<I, O>,
  version = "1.0.0"
): RegisteredFlow<I, O> {
  const definition = {
    _tag: "FlowDefinition",
    id,
    name: id,
    version,
    ...io,
    steps: [echo, slow],
  } as unknown as FlowDefinition<I, O>;
  return { definition, runner };
}

/**
 * A latch a test opens by hand: the `slow` tool awaits it. `entered` resolves once the tool is
 * blocked on it. That does NOT mean STEP_STARTED is durable (the journal writes it asynchronously),
 * so a test that snapshots the log "while the owner is running" must also wait for the event it
 * relies on (e.g. `until(() => kinds(...).includes("STEP_STARTED"))`).
 */
export class Latch {
  private open!: () => void;
  private arrive!: () => void;
  readonly promise = new Promise<void>((r) => {
    this.open = r;
  });
  readonly entered = new Promise<void>((r) => {
    this.arrive = r;
  });
  /** Called by the `slow` tool as it starts waiting. */
  enter(): void {
    this.arrive();
  }
  release(): void {
    this.open();
  }
}

export interface Harness {
  rt: WorkflowRuntime;
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  timers: TimerStore;
  effects: EffectRuntime;
  /** Build a second runtime over the SAME stores (another process / a reboot). */
  sibling(deps?: Partial<WorkflowRuntimeDeps>): WorkflowRuntime;
  warnings: string[];
  storageErrors: unknown[];
}

export function build(
  deps: Partial<WorkflowRuntimeDeps> = {},
  opts: {
    eventStore?: EventStore;
    snapshotStore?: SnapshotStore;
    timers?: TimerStore | null;
    latch?: Latch;
  } = {}
): Harness {
  const eventStore = opts.eventStore ?? new InMemoryAsyncEventStore();
  const snapshotStore = opts.snapshotStore ?? new InMemoryAsyncSnapshotStore();
  const timers = opts.timers === null ? undefined : (opts.timers ?? new InMemoryTimerStore());
  const warnings: string[] = [];
  const storageErrors: unknown[] = [];
  const mkEffects = (): EffectRuntime => {
    const effects = new EffectRuntime();
    effects.register("echo", new ToolEffect(async (i: unknown) => i));
    effects.register(
      "slow",
      new ToolEffect(async (i: unknown) => {
        opts.latch?.enter();
        await opts.latch?.promise;
        return i;
      })
    );
    return effects;
  };
  const effects = mkEffects();
  const common = (): WorkflowRuntimeDeps => ({
    eventStore,
    snapshotStore,
    effectRuntime: effects,
    inboxEnabled: true,
    ...(timers !== undefined && { timerStore: timers }),
    onWarn: (m: string) => warnings.push(m),
    onStorageError: (_id: string, e: unknown) => storageErrors.push(e),
    ...deps,
  });
  const rt = new WorkflowRuntime(common());
  return {
    rt,
    eventStore,
    snapshotStore,
    timers: timers as TimerStore,
    effects,
    warnings,
    storageErrors,
    sibling: (d = {}) => new WorkflowRuntime({ ...common(), effectRuntime: mkEffects(), ...d }),
  };
}

export const settle = (h: ExecutionHandle): Promise<unknown> =>
  Promise.race([h.waitForSuspend().catch(() => 0), h.waitForCompletion().catch(() => 0)]);

export async function kinds(store: EventStore, id: string): Promise<string[]> {
  return (await store.read(id)).map((e) => e.eventType);
}

export async function eventsOf(
  store: EventStore,
  id: string,
  kind: string
): Promise<EventEnvelope[]> {
  return (await store.read(id)).filter((e) => e.eventType === kind);
}

export const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait (bounded) until `pred` holds. */
export async function until(pred: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error("until: timed out");
    await tick(5);
  }
}

/**
 * Wrap a store so every append for which `dropFrom` returns true — and every later one for that
 * execution — is swallowed (the process died before the write landed). `restore()` is the reboot.
 */
export function crashingStore(
  inner: EventStore,
  dropFrom: (e: EventEnvelope) => boolean,
  opts: { atomicBatch?: boolean } = {}
): { store: EventStore; restore(): void; readonly crashed: boolean } {
  let crashed = false;
  let restored = false;
  const view = Object.create(inner) as EventStore;
  const guard = (e: EventEnvelope): boolean => {
    if (restored) return false;
    if (e.executionId.startsWith("__loom_")) return false; // the inbox stream is a different store row set
    if (!crashed && dropFrom(e)) crashed = true;
    return crashed;
  };
  view.append = async (e) => {
    if (guard(e)) return;
    return inner.append(e);
  };
  if (inner.deleteExecution !== undefined) {
    // A dead process deletes nothing (the owner's terminal-path inbox delete included).
    view.deleteExecution = async (id: string) => {
      if (crashed && !restored) return;
      return inner.deleteExecution?.(id);
    };
  }
  if (inner.appendBatch !== undefined) {
    view.appendBatch = async (es) => {
      if (opts.atomicBatch !== false) {
        // all-or-nothing, like a real transactional store: a crash drops the whole batch
        if (es.some((e) => guard(e))) return;
        return inner.appendBatch?.(es);
      }
      for (const e of es) await view.append(e); // `atomicBatch: false` only: a store the inbox now refuses
    };
  }
  return {
    store: view,
    restore: () => {
      restored = true;
    },
    get crashed() {
      return crashed;
    },
  };
}

/**
 * A process that DIES at a chosen append, and everything around it: after the crash the dead
 * process's event appends are swallowed (see {@link crashingStore}) and so are its snapshot saves
 * and timer rows (a real crash writes nothing more to any store). A sender's runtime and a rebooted
 * runtime are built over the SURVIVING stores.
 */
export function crashHarness(
  dropFrom: (e: EventEnvelope) => boolean,
  opts: { atomicBatch?: boolean; latch?: Latch; deps?: Partial<WorkflowRuntimeDeps> } = {}
) {
  const inner = new InMemoryAsyncEventStore();
  const rawSnap = new InMemoryAsyncSnapshotStore();
  const rawTimers = new InMemoryTimerStore();
  const crash = crashingStore(inner, dropFrom, opts);
  const snapView = Object.create(rawSnap) as InMemoryAsyncSnapshotStore;
  snapView.save = async (s) => {
    if (!crash.crashed) await rawSnap.save(s);
  };
  const timerView = Object.create(rawTimers) as InMemoryTimerStore;
  timerView.schedule = async (t) => {
    if (!crash.crashed) await rawTimers.schedule(t);
  };
  const h = build(opts.deps ?? {}, {
    eventStore: crash.store,
    snapshotStore: snapView,
    timers: timerView,
    ...(opts.latch !== undefined && { latch: opts.latch }),
  });
  const surviving = { eventStore: inner, snapshotStore: rawSnap, timerStore: rawTimers };
  return {
    inner,
    crash,
    h,
    timers: rawTimers,
    /** A live process over the surviving stores (the sender; the rebooted owner). */
    process: () => h.sibling(surviving),
    /** The reboot: let the zombie settle, lift the crash, hand back a fresh runtime. */
    reboot: async () => {
      await tick(60);
      crash.restore();
      return h.sibling(surviving);
    },
  };
}
