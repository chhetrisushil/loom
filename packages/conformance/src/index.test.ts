import type { ExecutionState } from "@loom/core";
import { DISPATCHER_SPI_VERSION, LocalDispatcher } from "@loom/dispatcher";
import { GrantTable } from "@loom/effect-runtime";
import {
  BRANCH_REGISTRY_SPI_VERSION,
  CoalescingEventStore,
  EVENT_STORE_SPI_VERSION,
  InMemoryAsyncEventStore,
  InMemoryBranchRegistry,
  InMemoryLeaseStore,
  InMemoryTimerStore,
  OPTIONAL_EVENT_STORE_METHODS,
  ProfilingEventStore,
  ShardPlan,
  ShardedEventStore,
  TenantScopedEventStore,
} from "@loom/event-runtime";
import type { LlmProvider, LlmRequest } from "@loom/llm";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import {
  InMemoryAsyncSnapshotStore,
  SNAPSHOT_STORE_SPI_VERSION,
  TenantScopedSnapshotStore,
} from "@loom/snapshot-runtime";
import type {
  ExecutionPackage,
  ExecutionResult,
  WorkerLease,
  WorkerRequest,
  WorkerRuntime,
} from "@loom/worker-runtime";
import { describe, expect, it } from "vitest";
import { checkContentStoreTouchContract } from "./contentTouchContract";
import {
  optionalSurfaceProblems,
  runEventStoreDecoratorConformance,
  runSnapshotStoreDecoratorConformance,
} from "./decorators";
import {
  type ContentStoreLike,
  runBranchRegistryConformance,
  runCapabilityAuthorizerConformance,
  runEventStoreConformance,
  runExecutionDispatcherConformance,
  runLeaseStoreConformance,
  runLlmProviderConformance,
  runProjectionRuntimeConformance,
  runSnapshotStoreConformance,
  runTimerStoreConformance,
} from "./index";
import { checkToolCallStreamParity } from "./toolCallParity";

/** A minimal in-memory WorkerRuntime for the dispatcher conformance self-test. */
class FakeWorker implements WorkerRuntime {
  async allocate(request: WorkerRequest): Promise<WorkerLease> {
    return { leaseId: `lease-${request.executionId}` };
  }
  async execute(_lease: WorkerLease, p: ExecutionPackage): Promise<ExecutionResult> {
    const state: ExecutionState = {
      executionId: p.executionId,
      workflowId: "wf",
      workflowVersion: "1.0.0",
      status: "completed",
      frames: {},
      variables: {},
      sequence: 1,
      startedAt: 0,
      updatedAt: 0,
    };
    return {
      executionId: p.executionId,
      status: "completed",
      state,
      output: { ok: true },
      lastSequence: 1,
    };
  }
  async release(): Promise<void> {}
}

// The kits must pass against Loom's own reference impls — this self-tests the kits.
// Durable backends (SQLite, Postgres) run the SAME kits in their own packages; that
// is the point: a third-party backend proves conformance the same way.
runEventStoreConformance(() => new InMemoryAsyncEventStore(), "InMemoryAsyncEventStore");

// ADR 0074 — the scale decorators run the SAME suite as a backend. That is the strongest
// statement available about a decorator: it is indistinguishable from the store it wraps,
// including through the composition the ADR documents (sharding outermost).
runEventStoreConformance(
  () => new CoalescingEventStore(new InMemoryAsyncEventStore()),
  "CoalescingEventStore(InMemory)"
);
runEventStoreConformance(
  () => new ShardedEventStore(Array.from({ length: 4 }, () => new InMemoryAsyncEventStore())),
  "ShardedEventStore(4x InMemory)"
);
// ADR 0075 — plan-driven routing, and routing while a bucket is mid-migration, must both be
// indistinguishable from an unsharded store. The migrating case is the interesting one: it
// exercises the two-sided per-execution resolution on every contract case.
runEventStoreConformance(
  () =>
    new ShardedEventStore(
      Array.from({ length: 3 }, () => new InMemoryAsyncEventStore()),
      {
        plan: ShardPlan.uniform(3, 256),
      }
    ),
  "ShardedEventStore(planned)"
);
runEventStoreConformance(
  () =>
    new ShardedEventStore(
      Array.from({ length: 3 }, () => new InMemoryAsyncEventStore()),
      {
        plan: ShardPlan.uniform(2, 256).rebalanced(3),
      }
    ),
  "ShardedEventStore(mid-migration)"
);
runEventStoreConformance(
  () =>
    new ShardedEventStore([
      new CoalescingEventStore(new InMemoryAsyncEventStore()),
      new CoalescingEventStore(new InMemoryAsyncEventStore()),
    ]),
  "Sharded(Coalescing(InMemory))"
);
// L10 — the composition `TenantScopedEventStore`'s docs name ("Sharded(TenantScoped(…))").
// Sharding resumes every shard from the merged page's last id, so each tenant-scoped shard
// must read its cursor as an OUTER (unprefixed) id; handing the inner, prefixed cursor back
// out made this composition re-serve its first page forever.
runEventStoreConformance(
  () =>
    new ShardedEventStore(
      Array.from(
        { length: 3 },
        () => new TenantScopedEventStore(new InMemoryAsyncEventStore(), "acme")
      )
    ),
  "Sharded(TenantScoped(InMemory))"
);
// ADR 0074 Amendment (L1) — every in-package decorator proves it carries the whole optional
// SPI through, and passes the full suite THROUGH itself. The plugin decorators (encryption,
// content, audit chain) and the tools (DST fault store, crash harness) register in their own
// packages; `packages/spec/src/decoratorConformance.test.ts` fails if any decorator does not.
runEventStoreDecoratorConformance(
  "TenantScopedEventStore",
  (inner) => new TenantScopedEventStore(inner, "acme")
);
runEventStoreDecoratorConformance(
  "CoalescingEventStore",
  (inner) => new CoalescingEventStore(inner)
);
runEventStoreDecoratorConformance("ProfilingEventStore", (inner) => new ProfilingEventStore(inner));
// Sharding over ONE shard is the decorator shape the kit can check (every capability the inner
// has must survive); the multi-shard compositions above cover routing.
runEventStoreDecoratorConformance("ShardedEventStore", (inner) => new ShardedEventStore([inner]));
runSnapshotStoreDecoratorConformance(
  "TenantScopedSnapshotStore",
  (inner) => new TenantScopedSnapshotStore(inner, "acme")
);

// The kit's guard must FIRE: a decorator that forgets `appendBatch` is exactly the drift it
// exists to catch. `optionalSurfaceProblems` is the check the kit's own `it` asserts empty.
describe("the decorator kit rejects a decorator that drops an optional method", () => {
  /** Hand-forwards everything EXCEPT appendBatch — the pre-L1 TenantScopedEventStore shape. */
  const droppingDecorator = (inner: InstanceType<typeof InMemoryAsyncEventStore>) => ({
    append: inner.append.bind(inner),
    read: inner.read.bind(inner),
    readFrom: inner.readFrom.bind(inner),
    subscribe: inner.subscribe.bind(inner),
    close: inner.close.bind(inner),
    readRange: inner.readRange.bind(inner),
    head: inner.head.bind(inner),
    acquireFence: inner.acquireFence.bind(inner),
    copyPrefix: inner.copyPrefix.bind(inner),
    deleteExecution: inner.deleteExecution.bind(inner),
    truncatePrefix: inner.truncatePrefix.bind(inner),
    truncatePrefixKeeping: inner.truncatePrefixKeeping.bind(inner),
    listExecutions: inner.listExecutions.bind(inner),
    listExecutionsPage: inner.listExecutionsPage.bind(inner),
  });

  it("fails it, naming the method", () => {
    const store = droppingDecorator(new InMemoryAsyncEventStore());
    const problems = optionalSurfaceProblems("Dropper", store, OPTIONAL_EVENT_STORE_METHODS);
    expect(problems).toEqual([expect.stringContaining("Dropper silently drops appendBatch")]);
    // …which is what the kit's `it` asserts is empty — so the kit fails for this decorator.
    expect(() => expect(problems).toEqual([])).toThrow();
  });

  it("accepts the same omission once it is refused with a reason — and not with an empty one", () => {
    const store = droppingDecorator(new InMemoryAsyncEventStore());
    expect(
      optionalSurfaceProblems("Dropper", store, OPTIONAL_EVENT_STORE_METHODS, {
        appendBatch: "cannot batch: each envelope needs its own round-trip",
      })
    ).toEqual([]);
    expect(
      optionalSurfaceProblems("Dropper", store, OPTIONAL_EVENT_STORE_METHODS, { appendBatch: " " })
    ).toEqual([expect.stringContaining("without a reason")]);
  });

  it("rejects a stale refusal — declared refused, still exposed", () => {
    const store = new InMemoryAsyncEventStore();
    expect(
      optionalSurfaceProblems("Liar", store, OPTIONAL_EVENT_STORE_METHODS, { head: "no tips" })
    ).toEqual([expect.stringContaining("declares head refused")]);
  });
});

runSnapshotStoreConformance(() => new InMemoryAsyncSnapshotStore(), "InMemoryAsyncSnapshotStore");
runBranchRegistryConformance(() => new InMemoryBranchRegistry(), "InMemoryBranchRegistry");
runLeaseStoreConformance(() => new InMemoryLeaseStore(), "InMemoryLeaseStore");
runExecutionDispatcherConformance(() => new LocalDispatcher(new FakeWorker()), "LocalDispatcher");
runTimerStoreConformance(() => new InMemoryTimerStore(), "InMemoryTimerStore");
runProjectionRuntimeConformance(() => new InMemoryProjectionRuntime(), "InMemoryProjectionRuntime");

// Every public SPI declares a version constant (ADR 0033 — versioning policy).
describe("SPI version constants", () => {
  it("are semver strings", () => {
    for (const v of [
      EVENT_STORE_SPI_VERSION,
      SNAPSHOT_STORE_SPI_VERSION,
      BRANCH_REGISTRY_SPI_VERSION,
      DISPATCHER_SPI_VERSION,
    ]) {
      expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

// (WorkerRuntime conformance self-tests against LocalWorkerRuntime in
// @loom/worker-runtime-local — that package owns the reference impl + a runtime to run.)

// --- LlmProvider: a deterministic echo provider (offline). ---
const echoProvider: LlmProvider = {
  async complete(req) {
    const last = req.messages[req.messages.length - 1];
    return { content: `echo:${last?.content ?? ""}`, stopReason: "end_turn" };
  },
  async *stream(req) {
    const last = req.messages[req.messages.length - 1];
    yield { delta: `echo:${last?.content ?? ""}`, done: false };
    yield { delta: "", done: true };
  },
};
// Echo never calls a tool for any request, so it opts out of the R8 tool-call parity
// check explicitly rather than leaving `toolRequest` unset.
runLlmProviderConformance(() => echoProvider, "EchoLlmProvider", { toolRequest: null });

// A provider that REPORTS the outcome on its terminal chunk — the shape an agent
// turn needs. Without one of these in the fixture set, the parity assertions all
// take their "not reported" branch and the suite proves only that text matches.
const richProvider: LlmProvider = {
  async complete() {
    return {
      content: "thinking",
      toolCalls: [{ id: "c1", name: "lookup", input: { q: "x" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 7, outputTokens: 3 },
    };
  },
  async *stream() {
    yield { delta: "think", done: false };
    yield { delta: "ing", done: false };
    yield {
      delta: "",
      done: true,
      toolCalls: [{ id: "c1", name: "lookup", input: { q: "x" } }],
      stopReason: "tool_use" as const,
      usage: { inputTokens: 7, outputTokens: 3 },
    };
  },
};
const richToolRequest: LlmRequest = { messages: [{ role: "user", content: "look something up" }] };
runLlmProviderConformance(() => richProvider, "RichLlmProvider", { toolRequest: richToolRequest });

// --- checkToolCallStreamParity: the R8 tool-call parity rule, unit-tested directly. ---
//
// `runLlmProviderConformance` can only be driven through vitest's own `it`, and vitest
// refuses to collect a nested describe/it once a test has started running — so these
// negative cases prove the rule FIRES by calling the extracted function directly,
// rather than by asserting that the kit's own generated suite fails (which vitest has
// no supported way to observe from inside a test).
describe("checkToolCallStreamParity (the R8 tool-call parity rule)", () => {
  const toolReq: LlmRequest = { messages: [{ role: "user", content: "use the tool" }] };

  it("passes when the provider has no stream at all", async () => {
    const textOnly: LlmProvider = {
      async complete() {
        return { content: "hi", stopReason: "end_turn" };
      },
    };
    await expect(checkToolCallStreamParity(textOnly, undefined)).resolves.toBeUndefined();
  });

  it("passes on an explicit `toolRequest: null` opt-out, even with a stream present", async () => {
    await expect(checkToolCallStreamParity(echoProvider, null)).resolves.toBeUndefined();
  });

  it("fails when `toolRequest` is missing on a streaming provider", async () => {
    await expect(checkToolCallStreamParity(richProvider, undefined)).rejects.toThrow(
      /stream parity for tool calls is unproven/
    );
  });

  it("fails when complete(toolRequest) itself makes no tool call (a vacuous fixture)", async () => {
    const noToolCall: LlmProvider = {
      async complete() {
        return { content: "no tools here", stopReason: "end_turn" };
      },
      async *stream() {
        yield { delta: "no tools here", done: true };
      },
    };
    await expect(checkToolCallStreamParity(noToolCall, toolReq)).rejects.toThrow(
      /complete\(toolRequest\) returned no tool call/
    );
  });

  it("fails when the stream drops a tool call complete(toolRequest) made", async () => {
    const dropsToolCall: LlmProvider = {
      async complete() {
        return {
          content: "thinking",
          toolCalls: [{ id: "c1", name: "lookup", input: { q: "x" } }],
          stopReason: "tool_use",
        };
      },
      async *stream() {
        // Text only — the terminal chunk reports neither `toolCalls` nor `stopReason`.
        yield { delta: "thinking", done: true };
      },
    };
    await expect(checkToolCallStreamParity(dropsToolCall, toolReq)).rejects.toThrow();
  });

  it("fails when the streamed stopReason disagrees with a completed tool_use", async () => {
    const wrongStopReason: LlmProvider = {
      async complete() {
        return {
          content: "thinking",
          toolCalls: [{ id: "c1", name: "lookup", input: { q: "x" } }],
          stopReason: "tool_use",
        };
      },
      async *stream() {
        yield {
          delta: "thinking",
          done: true,
          toolCalls: [{ id: "c1", name: "lookup", input: { q: "x" } }],
          stopReason: "end_turn",
        };
      },
    };
    await expect(checkToolCallStreamParity(wrongStopReason, toolReq)).rejects.toThrow();
  });

  it("passes when the stream faithfully reports the same tool call and stopReason", async () => {
    await expect(checkToolCallStreamParity(richProvider, richToolRequest)).resolves.toBeUndefined();
  });
});

// --- CapabilityAuthorizer: the reference GrantTable. ---
runCapabilityAuthorizerConformance(() => new GrantTable({ w: ["t"] }), "GrantTable");

describe("TenantScopedSnapshotStore rejects a tenant containing the separator (K12.5)", () => {
  it("throws for 'a:b' and '' — the same prefix-collision rule as the event store", () => {
    const inner = new InMemoryAsyncSnapshotStore();
    expect(() => new TenantScopedSnapshotStore(inner, "a:b")).toThrow(/separator/);
    expect(() => new TenantScopedSnapshotStore(inner, "")).toThrow(/tenant/);
    expect(() => new TenantScopedSnapshotStore(inner, "acme")).not.toThrow();
  });
});

// ── ContentStore SPI 1.3.0: the touch-contract check must FIRE (ADR 0055 D5) ───
describe("checkContentStoreTouchContract", () => {
  /** A tiny content store; `bump: false` is the INSERT OR IGNORE shape that loses re-cites. */
  function fixture(opts: { bump: boolean; methods?: readonly string[] }) {
    const blobs = new Map<string, { bytes: Uint8Array; touchedAt: number }>();
    const key = (b: Uint8Array) => Buffer.from(b).toString("hex");
    const store: Record<string, unknown> = {
      put: async (bytes: Uint8Array) => {
        const address = key(bytes);
        const existing = blobs.get(address);
        if (existing === undefined) blobs.set(address, { bytes, touchedAt: Date.now() });
        else if (opts.bump) existing.touchedAt = Math.max(existing.touchedAt, Date.now());
        return { __loomContent: address };
      },
      get: async (ref: { __loomContent: string }) => blobs.get(ref.__loomContent)?.bytes ?? null,
      delete: async (ref: { __loomContent: string }) => {
        blobs.delete(ref.__loomContent);
      },
      deleteIfUntouchedSince: async (ref: { __loomContent: string }, cutoff: number) => {
        const blob = blobs.get(ref.__loomContent);
        return blob !== undefined && blob.touchedAt < cutoff && blobs.delete(ref.__loomContent);
      },
      listPage: async () => ({
        entries: [...blobs].map(([address, b]) => ({ address, touchedAt: b.touchedAt })),
      }),
      touchClock: async () => Date.now(),
    };
    for (const m of ["deleteIfUntouchedSince", "listPage", "touchClock"]) {
      if (opts.methods !== undefined && !opts.methods.includes(m)) delete store[m];
    }
    return store as unknown as ContentStoreLike;
  }

  it("passes a store that bumps the touch time on a re-put", async () => {
    await expect(checkContentStoreTouchContract(fixture({ bump: true }))).resolves.toBeUndefined();
  });

  it("FAILS a store whose re-put leaves the touch time alone (INSERT OR IGNORE)", async () => {
    await expect(checkContentStoreTouchContract(fixture({ bump: false }))).rejects.toThrow(
      /did not bump/
    );
  });

  it("FAILS a partial SPI 1.3.0 set, and passes a store with none of it", async () => {
    await expect(
      checkContentStoreTouchContract(
        fixture({ bump: true, methods: ["deleteIfUntouchedSince", "listPage"] })
      )
    ).rejects.toThrow(/together/);
    await expect(
      checkContentStoreTouchContract(fixture({ bump: true, methods: [] }))
    ).resolves.toBeUndefined();
  });
});
