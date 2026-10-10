import type { ExecutionState } from "@loom/core";
import { DISPATCHER_SPI_VERSION, LocalDispatcher, SupervisingDispatcher } from "@loom/dispatcher";
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
import {
  AnthropicProvider,
  GeminiProvider,
  OpenAiProvider,
  assertRequestSupported,
  textOf,
} from "@loom/llm";
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
import {
  checkContentStoreTouchContract,
  checkTouchNeverMovesBackwards,
} from "./contentTouchContract";
import {
  optionalSurfaceProblems,
  runEventStoreDecoratorConformance,
  runSnapshotStoreDecoratorConformance,
} from "./decorators";
import {
  type ContentStoreLike,
  leaseExpiredDefaultProblem,
  leaseStoreNowProblem,
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
import { checkDeclaredMediaOnWire } from "./mediaWire";
import { checkPartsReadAsText } from "./partsTextRead";
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

// The kit's acquireFenceIf cases run only when a store offers the method (like `copyPrefix`), which
// is a vacuous pass for a store that silently lacks it. The reference stores MUST offer it, so the
// cases above are exercised for real (ADR 0118; the vacuous-check lesson).
it("the reference stores offer appendIfUnchanged (SPI 2.2.0), so its conformance cases are not vacuous", () => {
  expect(typeof new InMemoryAsyncEventStore().appendIfUnchanged).toBe("function");
  expect(typeof new CoalescingEventStore(new InMemoryAsyncEventStore()).appendIfUnchanged).toBe(
    "function"
  );
  expect(
    typeof new ShardedEventStore(Array.from({ length: 2 }, () => new InMemoryAsyncEventStore()))
      .appendIfUnchanged
  ).toBe("function");
});

it("the reference stores offer acquireFenceIf, so its conformance cases are not vacuous", () => {
  expect(typeof new InMemoryAsyncEventStore().acquireFenceIf).toBe("function");
  expect(typeof new CoalescingEventStore(new InMemoryAsyncEventStore()).acquireFenceIf).toBe(
    "function"
  );
  expect(
    typeof new ShardedEventStore(Array.from({ length: 2 }, () => new InMemoryAsyncEventStore()))
      .acquireFenceIf
  ).toBe("function");
});

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
    acquireFenceIf: inner.acquireFenceIf.bind(inner),
    appendIfUnchanged: inner.appendIfUnchanged.bind(inner),
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
runLeaseStoreConformance(() => new InMemoryLeaseStore(), "InMemoryLeaseStore", {
  clocked: (now) => new InMemoryLeaseStore({ now }),
});

// The kit's expired()-default case must DISCRIMINATE, not merely pass on the reference store
// (L28 review: with wall-clock factories it passed the exact bug and failed a correct sim store).
describe("leaseExpiredDefaultProblem discriminates", () => {
  // The L28 bug: stamps with its own (injected) clock, but `expired()` defaults to Date.now().
  class WallDefaultExpired extends InMemoryLeaseStore {
    override expired(now = Date.now(), limit = 100) {
      return super.expired(now, limit);
    }
  }
  // 1.x-shaped: required `now`, so `undefined` compares false and nothing is ever expired.
  class RequiredNow extends InMemoryLeaseStore {
    override expired(now?: number, limit = 100) {
      return now === undefined ? Promise.resolve([]) : super.expired(now, limit);
    }
  }

  it("fails a store that stamps on its own clock but defaults expired() to Date.now()", async () => {
    const problem = await leaseExpiredDefaultProblem(
      () => new WallDefaultExpired(),
      (now) => new WallDefaultExpired({ now })
    );
    expect(problem).toMatch(/other than the stamping clock/);
  });

  it("fails a store whose expired() returns [] when handed undefined", async () => {
    const problem = await leaseExpiredDefaultProblem(
      () => new RequiredNow(),
      (now) => new RequiredNow({ now })
    );
    expect(problem).toBeDefined();
  });

  it("passes a correct store on a simulated clock, and on the wall clock", async () => {
    expect(
      await leaseExpiredDefaultProblem(
        () => new InMemoryLeaseStore(),
        (now) => new InMemoryLeaseStore({ now })
      )
    ).toBeUndefined();
    expect(await leaseExpiredDefaultProblem(() => new InMemoryLeaseStore())).toBeUndefined();
  });
});
// storeNow() must agree with the stamping clock; a probe an hour off must FAIL, a correct one PASS.
describe("leaseStoreNowProblem discriminates", () => {
  const HOUR = 3_600_000;
  class SkewedStoreNow extends InMemoryLeaseStore {
    storeNow(): Promise<number> {
      return Promise.resolve(Date.now() + HOUR);
    }
  }
  class HonestStoreNow extends InMemoryLeaseStore {
    storeNow(): Promise<number> {
      return Promise.resolve(Date.now());
    }
  }
  it("fails a store whose storeNow() is an hour off its stamping clock", async () => {
    expect(await leaseStoreNowProblem(() => new SkewedStoreNow())).toMatch(/disagrees/);
  });
  it("passes a correct store, and skips one without storeNow", async () => {
    expect(await leaseStoreNowProblem(() => new HonestStoreNow())).toBeUndefined();
    expect(await leaseStoreNowProblem(() => new InMemoryLeaseStore())).toBeUndefined();
  });
});
runExecutionDispatcherConformance(() => new LocalDispatcher(new FakeWorker()), "LocalDispatcher", {
  overWorker: (worker) => new LocalDispatcher(worker, { maxAttempts: 3 }),
});
runExecutionDispatcherConformance(
  () => new SupervisingDispatcher(new LocalDispatcher(new FakeWorker())),
  "SupervisingDispatcher",
  {
    overWorker: (worker) =>
      new SupervisingDispatcher(new LocalDispatcher(worker, { maxAttempts: 2 }), {
        policy: { maxRestarts: 2 },
      }),
  }
);
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
    assertRequestSupported(req, undefined);
    const last = req.messages[req.messages.length - 1];
    return {
      content: `echo:${last === undefined ? "" : textOf(last.content)}`,
      stopReason: "end_turn",
    };
  },
  async *stream(req) {
    assertRequestSupported(req, undefined);
    const last = req.messages[req.messages.length - 1];
    yield { delta: `echo:${last === undefined ? "" : textOf(last.content)}`, done: false };
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
  async complete(req) {
    assertRequestSupported(req, undefined);
    return {
      content: "thinking",
      toolCalls: [{ id: "c1", name: "lookup", input: { q: "x" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 7, outputTokens: 3 },
    };
  },
  async *stream(req) {
    assertRequestSupported(req, undefined);
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
  function fixture(opts: {
    bump: boolean;
    methods?: readonly string[];
    touch?: "ok" | "noop" | "inserts" | "overwrites";
    now?: () => number;
  }) {
    const clockNow = opts.now ?? Date.now;
    const blobs = new Map<string, { bytes: Uint8Array; touchedAt: number }>();
    const key = (b: Uint8Array) => Buffer.from(b).toString("hex");
    const store: Record<string, unknown> = {
      put: async (bytes: Uint8Array) => {
        const address = key(bytes);
        const existing = blobs.get(address);
        if (existing === undefined) blobs.set(address, { bytes, touchedAt: clockNow() });
        else if (opts.bump) existing.touchedAt = Math.max(existing.touchedAt, clockNow());
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
      touchClock: async () => clockNow(),
    };
    if (opts.touch !== undefined) {
      store.touch = async (addresses: readonly string[]) => {
        const missing: string[] = [];
        for (const a of addresses) {
          const b = blobs.get(a);
          if (b === undefined) {
            missing.push(a);
            if (opts.touch === "inserts") blobs.set(a, { bytes: new Uint8Array(), touchedAt: 0 });
          } else if (opts.touch === "overwrites") b.touchedAt = clockNow();
          else if (opts.touch !== "noop") b.touchedAt = Math.max(b.touchedAt, clockNow());
        }
        return [...new Set(missing)];
      };
    }
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

  it("SPI 1.4.0 touch: passes a store that bumps, FAILS one that does not bump or that inserts an unknown address", async () => {
    await expect(
      checkContentStoreTouchContract(fixture({ bump: true, touch: "ok" }))
    ).resolves.toBeUndefined();
    await expect(
      checkContentStoreTouchContract(fixture({ bump: true, touch: "noop" }))
    ).rejects.toThrow(/touch did not bump/);
    await expect(
      checkContentStoreTouchContract(fixture({ bump: true, touch: "inserts" }))
    ).rejects.toThrow(/created a blob/);
  });

  it("SPI 1.4.0 touch: FAILS a store that has touch but none of the 1.3.0 set, or only part of it", async () => {
    await expect(
      checkContentStoreTouchContract(fixture({ bump: true, touch: "ok", methods: [] }))
    ).rejects.toThrow(/touch needs the whole SPI 1.3.0 set/);
    await expect(
      checkContentStoreTouchContract(
        fixture({ bump: true, touch: "ok", methods: ["deleteIfUntouchedSince", "listPage"] })
      )
    ).rejects.toThrow(/touch, SPI 1.4.0, needs them all/);
  });

  it("SPI 1.4.0 touch takes the maximum: passes max(), FAILS a touch that overwrites under a clock that stepped back", async () => {
    const clocked = (touch: "ok" | "overwrites") => (now: () => number) =>
      fixture({ bump: true, touch, now });
    await expect(checkTouchNeverMovesBackwards(clocked("ok"))).resolves.toBeUndefined();
    await expect(checkTouchNeverMovesBackwards(clocked("overwrites"))).rejects.toThrow(
      /moved the touch time backwards/
    );
    // A store with no touch has nothing to check.
    await expect(
      checkTouchNeverMovesBackwards((now) => fixture({ bump: true, now }))
    ).resolves.toBeUndefined();
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

// --- checkDeclaredMediaOnWire: R5 "declared means delivered", unit-tested directly. ---
describe("checkDeclaredMediaOnWire (R5)", () => {
  const sendsBody = (build: (r: LlmRequest) => unknown): LlmProvider => ({
    capabilities: { image: ["image/png"] },
    async complete(r) {
      await fetch("https://example.invalid/", { method: "POST", body: JSON.stringify(build(r)) });
      return { content: "", stopReason: "end_turn" };
    },
  });

  it("passes a provider that sends the image it declared", async () => {
    await expect(checkDeclaredMediaOnWire(sendsBody((r) => r))).resolves.toBeUndefined();
  });

  it("FAILS a provider that declares images and silently drops them from the wire body", async () => {
    const dropping = sendsBody((r) => ({
      messages: r.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : textOf(m.content),
      })),
    }));
    await expect(checkDeclaredMediaOnWire(dropping)).rejects.toThrow(/does not carry the image/);
  });

  it("is silent for a provider that does not declare images", async () => {
    await expect(
      checkDeclaredMediaOnWire({ complete: async () => ({ content: "", stopReason: "end_turn" }) })
    ).resolves.toBeUndefined();
  });
});

// --- checkPartsReadAsText: a parts message must be read as text, unit-tested directly. ---
describe("checkPartsReadAsText (R5)", () => {
  const httpProvider = (render: (r: LlmRequest) => unknown): LlmProvider => ({
    async complete(r) {
      await fetch("https://example.invalid/", { method: "POST", body: JSON.stringify(render(r)) });
      return { content: "", stopReason: "end_turn" };
    },
  });

  it("passes a provider that reads content through textOf", async () => {
    const good = httpProvider((r) => ({
      messages: r.messages.map((m) => ({ text: textOf(m.content) })),
    }));
    await expect(checkPartsReadAsText(good)).resolves.toBeUndefined();
  });

  it("passes a provider that branches on typeof", async () => {
    const good = httpProvider((r) => ({
      messages: r.messages.map((m) => ({
        parts:
          typeof m.content === "string"
            ? [{ text: m.content }]
            : m.content.map((p) => (p.type === "text" ? { text: p.text } : {})),
      })),
    }));
    await expect(checkPartsReadAsText(good)).resolves.toBeUndefined();
  });

  it("FAILS a naive provider that joins raw content (string coercion)", async () => {
    const naive: LlmProvider = {
      async complete(r) {
        const prompt = r.messages.map((m) => m.content).join(" ");
        return { content: prompt, stopReason: "end_turn" };
      },
    };
    await expect(checkPartsReadAsText(naive)).rejects.toThrow(/read LlmMessage\.content raw/);
  });

  it("FAILS a naive provider that interpolates raw content into the wire body", async () => {
    const naive = httpProvider((r) => ({ prompt: `${r.messages[0]?.content}` }));
    await expect(checkPartsReadAsText(naive)).rejects.toThrow(/read LlmMessage\.content raw/);
  });

  it("FAILS an HTTP provider whose body drops the text parts (wire check)", async () => {
    const dropping = httpProvider(() => ({ messages: [{ text: "" }] }));
    await expect(checkPartsReadAsText(dropping)).rejects.toThrow(/carries the text parts/);
  });

  it("passes a provider that makes an auxiliary fetch (auth, count_tokens) besides the real one", async () => {
    const withAux: LlmProvider = {
      async complete(r) {
        await fetch("https://example.invalid/token", { method: "POST", body: "grant_type=x" });
        await fetch("https://example.invalid/count_tokens", { method: "POST", body: "{}" });
        await fetch("https://example.invalid/", {
          method: "POST",
          body: JSON.stringify({ messages: r.messages.map((m) => ({ text: textOf(m.content) })) }),
        });
        return { content: "", stopReason: "end_turn" };
      },
    };
    await expect(checkPartsReadAsText(withAux)).resolves.toBeUndefined();
  });

  it("passes FormData, stream and bodiless fetches, and reads a Request body", async () => {
    const odd: LlmProvider = {
      async complete(r) {
        await fetch("https://example.invalid/upload", { method: "POST", body: new FormData() });
        await fetch(new Request("https://example.invalid/get"));
        await fetch(
          new Request("https://example.invalid/", {
            method: "POST",
            body: JSON.stringify({ messages: r.messages.map((m) => textOf(m.content)) }),
          })
        );
        return { content: "", stopReason: "end_turn" };
      },
    };
    await expect(checkPartsReadAsText(odd)).resolves.toBeUndefined();
  });

  it("FAILS a raw-join provider that also makes an auxiliary fetch", async () => {
    const naive: LlmProvider = {
      async complete(r) {
        await fetch("https://example.invalid/token", { method: "POST", body: "x" });
        await fetch("https://example.invalid/", {
          method: "POST",
          body: JSON.stringify({ prompt: `${r.messages[0]?.content}` }),
        });
        return { content: "", stopReason: "end_turn" };
      },
    };
    await expect(checkPartsReadAsText(naive)).rejects.toThrow();
  });

  it("FAILS a Request-body provider whose body holds '[object Object]' (no toString trap hit)", async () => {
    const naive: LlmProvider = {
      async complete() {
        await fetch(
          new Request("https://example.invalid/", { method: "POST", body: "x [object Object] y" })
        );
        return { content: "", stopReason: "end_turn" };
      },
    };
    await expect(checkPartsReadAsText(naive)).rejects.toThrow(/\[object Object\]/);
  });
});

// The parts-as-text case against the real first-party providers (fetch is stubbed by the check), so
// the case is exercised by shipped code and not only by hand-written naive providers.
describe("checkPartsReadAsText on the first-party providers (R5)", () => {
  const providers: Array<[string, () => LlmProvider]> = [
    ["AnthropicProvider", () => new AnthropicProvider({ apiKey: "k" })],
    ["OpenAiProvider", () => new OpenAiProvider({ apiKey: "k" })],
    ["GeminiProvider", () => new GeminiProvider({ apiKey: "k" })],
  ];
  for (const [name, make] of providers) {
    it(`${name} reads a parts message as text`, async () => {
      await expect(checkPartsReadAsText(make())).resolves.toBeUndefined();
    });
  }
});
