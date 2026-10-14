import { step$ } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryLeaseStore } from "@loom/event-runtime";
import type { EventStore, LeaseStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig } from "./defineConfig";

// ADR 0130 D11 -- `durability.heartbeat`. The config resolves WHICH lease store the drivers
// heartbeat into (co-located with the event store, never silently a different failure domain)
// and records the answer on `app.heartbeat` so `loom doctor` can say it out loud.

/** What a durable preset (`sqliteStorage()`, `postgresStorage()`) returns: a `custom` storage + `leaseStore`. */
function preset(opts: { lease?: LeaseStore; durable?: boolean; onLeaseRead?: () => void }) {
  const eventStore: EventStore = opts.durable
    ? ({ ...new InMemoryAsyncEventStore(), __durable: true } as unknown as EventStore)
    : new InMemoryAsyncEventStore();
  const storage = {
    kind: "custom" as const,
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
  };
  // A real preset's `leaseStore` is a (lazy) accessor; define it as one so reads are observable.
  if (opts.lease !== undefined)
    Object.defineProperty(storage, "leaseStore", {
      enumerable: true,
      get: () => {
        opts.onLeaseRead?.();
        return opts.lease as LeaseStore;
      },
    });
  return storage as typeof storage & { leaseStore?: LeaseStore };
}

const base = { autostart: false } as const;

describe("durability.heartbeat -- derivation", () => {
  it("memory storage: heartbeat ON with an in-memory lease store (single process, nothing to disagree)", () => {
    const app = defineConfig({ ...base, storage: { kind: "memory" } });
    expect(app.heartbeat.enabled).toBe(true);
    expect(app.heartbeat.source).toBe("in-memory");
    expect(app.heartbeat.store).toBeInstanceOf(InMemoryLeaseStore);
    expect(app.heartbeat.onStoreError).toBe("stop");
  });

  it("a custom storage with an in-memory event store and no leaseStore: in-memory leases", () => {
    const app = defineConfig({ ...base, storage: preset({}) });
    expect(app.heartbeat.source).toBe("in-memory");
    expect(app.heartbeat.enabled).toBe(true);
  });

  it("a preset exposing leaseStore (sqlite/postgres shape): co-located, the SAME instance", () => {
    const lease = new InMemoryLeaseStore();
    const app = defineConfig({ ...base, storage: preset({ lease, durable: true }) });
    expect(app.heartbeat.enabled).toBe(true);
    expect(app.heartbeat.source).toBe("co-located");
    expect(app.heartbeat.store).toBe(lease);
  });

  it("a durable event store with NO derivable lease store: heartbeat DISABLED (fail-closed), never in-memory", () => {
    const store = { ...preset({}), eventStore: Object.create(null) as EventStore };
    const app = defineConfig({ ...base, storage: store });
    expect(app.heartbeat.enabled).toBe(false);
    expect(app.heartbeat.source).toBe("none");
    expect(app.heartbeat.store).toBeUndefined();
  });

  it("an explicit store overrides the co-located one", () => {
    const colocated = new InMemoryLeaseStore();
    const explicit = new InMemoryLeaseStore();
    const app = defineConfig({
      ...base,
      storage: preset({ lease: colocated, durable: true }),
      durability: { heartbeat: { store: explicit } },
    });
    expect(app.heartbeat.source).toBe("explicit");
    expect(app.heartbeat.store).toBe(explicit);
  });

  it("an explicit store enables heartbeat even when none could be derived", () => {
    const explicit = new InMemoryLeaseStore();
    const store = { ...preset({}), eventStore: Object.create(null) as EventStore };
    const app = defineConfig({
      ...base,
      storage: store,
      durability: { heartbeat: { store: explicit } },
    });
    expect(app.heartbeat.enabled).toBe(true);
    expect(app.heartbeat.store).toBe(explicit);
  });

  it("enabled:false reproduces today: no store resolved, and the co-located getter is never read", () => {
    let reads = 0;
    const app = defineConfig({
      ...base,
      storage: preset({
        lease: new InMemoryLeaseStore(),
        durable: true,
        onLeaseRead: () => reads++,
      }),
      durability: { heartbeat: { enabled: false } },
    });
    expect(app.heartbeat.enabled).toBe(false);
    expect(app.heartbeat.source).toBe("off");
    expect(app.heartbeat.store).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("carries ttlMs / renewEveryMs / onStoreError into the resolved status", () => {
    const app = defineConfig({
      ...base,
      storage: { kind: "memory" },
      durability: { heartbeat: { ttlMs: 12_000, renewEveryMs: 3_000, onStoreError: "stop" } },
    });
    expect(app.heartbeat.ttlMs).toBe(12_000);
    expect(app.heartbeat.renewEveryMs).toBe(3_000);
    expect(app.heartbeat.onStoreError).toBe("stop");
  });

  it('onStoreError "continue" is refused until the poll can treat the fleet as heuristic (S7d)', () => {
    expect(() =>
      defineConfig({
        ...base,
        storage: { kind: "memory" },
        durability: { heartbeat: { onStoreError: "continue" } },
      })
    ).toThrow(/not supported yet/);
  });
});

describe("durability.heartbeat -- validation", () => {
  const bad = (heartbeat: unknown) => () =>
    defineConfig({
      ...base,
      storage: { kind: "memory" },
      durability: { heartbeat: heartbeat as never },
    });

  it("rejects a non-positive / non-finite ttlMs", () => {
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "30"]) {
      expect(bad({ ttlMs }), String(ttlMs)).toThrow(TypeError);
    }
  });
  it("rejects a renewEveryMs that cannot beat the self-fencing deadline", () => {
    expect(bad({ renewEveryMs: 0 })).toThrow(TypeError);
    // ttl 6000 -> margin 1000 -> renewEveryMs must be < 5000
    expect(bad({ ttlMs: 6_000, renewEveryMs: 5_000 })).toThrow(TypeError);
    expect(bad({ ttlMs: 6_000, renewEveryMs: 4_999 })).not.toThrow();
  });
  it("bound-checks the DEFAULT renew cadence too (max(floor(ttl/3),1) must beat the deadline)", () => {
    expect(bad({ ttlMs: 1 })).toThrow(TypeError);
    expect(bad({ ttlMs: 0.5 })).toThrow(TypeError);
    expect(bad({ ttlMs: 2 })).not.toThrow();
  });
  it("rejects a bad onStoreError, enabled, or store", () => {
    expect(bad({ onStoreError: "ignore" })).toThrow(TypeError);
    expect(bad({ enabled: "yes" })).toThrow(TypeError);
    expect(bad({ store: {} })).toThrow(TypeError);
  });
  it("rejects unknown keys (a typo would otherwise silently do nothing)", () => {
    expect(bad({ ttl: 5 })).toThrow(/ttl/);
  });
  it("the flat spelling THROWS (project rule: groups, no deprecation window)", () => {
    expect(() =>
      defineConfig({ ...base, storage: { kind: "memory" }, heartbeat: { enabled: false } } as never)
    ).toThrow(/durability\.heartbeat/);
  });
});

describe("durability.heartbeat -- scope (cluster visibility)", () => {
  const withScope = (scope?: "process" | "host" | "cluster") => {
    const s = new InMemoryLeaseStore();
    if (scope === undefined) (s as { scope?: unknown }).scope = undefined;
    else (s as { scope?: unknown }).scope = scope;
    return s;
  };
  it("in-memory derivation is process-scoped and NOT cluster-visible", () => {
    const app = defineConfig({ ...base, storage: { kind: "memory" } });
    expect(app.heartbeat.scope).toBe("process");
    expect(app.heartbeat.clusterVisible).toBe(false);
  });
  it("a co-located store reports its own declared scope", () => {
    for (const [scope, cv] of [
      ["host", false],
      ["cluster", true],
    ] as const) {
      const app = defineConfig({
        ...base,
        storage: preset({ lease: withScope(scope), durable: true }),
      });
      expect(app.heartbeat.scope).toBe(scope);
      expect(app.heartbeat.clusterVisible).toBe(cv);
    }
  });
  it("an undeclared scope is unknown and NOT cluster-visible; an explicit store contributes its own", () => {
    const a = defineConfig({
      ...base,
      storage: preset({ lease: withScope(undefined), durable: true }),
    });
    expect(a.heartbeat.scope).toBe("unknown");
    expect(a.heartbeat.clusterVisible).toBe(false);
    const b = defineConfig({
      ...base,
      storage: preset({ durable: true }),
      durability: { heartbeat: { store: withScope("cluster") } },
    });
    expect(b.heartbeat.scope).toBe("cluster");
    expect(b.heartbeat.clusterVisible).toBe(true);
  });
  it("a disabled heartbeat is unknown / not cluster-visible", () => {
    const app = defineConfig({
      ...base,
      storage: { kind: "memory" },
      durability: { heartbeat: { enabled: false } },
    });
    expect(app.heartbeat.scope).toBe("unknown");
    expect(app.heartbeat.clusterVisible).toBe(false);
  });
});

// ADR 0130 D11 (S7c wiring) -- the resolved config actually reaches the runtime's drivers.
describe("durability.heartbeat -- wired into the runtime", () => {
  const io = z.object({}).passthrough();
  const hold = step$({
    id: "hold",
    name: "hold",
    toolId: "hold",
    inputSchema: io,
    outputSchema: io,
  });
  const definition = {
    _tag: "FlowDefinition" as const,
    id: "hb-flow",
    name: "hb-flow",
    version: "1.0.0",
    inputSchema: io,
    outputSchema: io,
    steps: [hold],
  };
  const runner = async (ctx: { run: (s: unknown, i: unknown) => Promise<unknown> }) => {
    await ctx.run(hold, {});
    return { ok: true };
  };

  function rig(heartbeat?: { enabled?: boolean }) {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const inStep = new Promise<void>((r) => {
      entered = r;
    });
    const app = defineConfig({
      ...base,
      storage: { kind: "memory" },
      ...(heartbeat !== undefined && { durability: { heartbeat } }),
      execution: {
        registerEffects: (fx) =>
          fx.register(
            "hold",
            new ToolEffect(async () => {
              entered();
              await gate;
              return {};
            })
          ),
      },
    });
    app.runtime.registerFlow(definition as never, runner as never);
    return { app, release, inStep };
  }

  it("default ON: the in-memory lease store holds a row while a step is in flight, and releases at the end", async () => {
    const { app, release, inStep } = rig();
    const store = app.heartbeat.store as InMemoryLeaseStore;
    expect(app.runtime.leaseKeeper).toBeDefined();
    const handle = await app.runtime.start({ definition, runner } as never, {});
    await inStep;
    expect(await store.get(handle.executionId)).not.toBeNull();
    expect(app.runtime.leaseKeeper?.validNow(handle.executionId)).toBe(true);
    release();
    await handle.waitForCompletion();
    await until(async () => (await store.get(handle.executionId)) === null);
    expect(app.runtime.leaseKeeper?.size).toBe(0);
  });

  it("enabled:false leaves the runtime without a keeper", () => {
    const { app } = rig({ enabled: false });
    expect(app.heartbeat.enabled).toBe(false);
    expect(app.runtime.leaseKeeper).toBeUndefined();
  });

  it('onStoreError "continue" is refused at defineConfig (and by the runtime): consistent on both layers', () => {
    expect(() =>
      defineConfig({
        ...base,
        storage: { kind: "memory" },
        durability: { heartbeat: { onStoreError: "continue" } },
      })
    ).toThrow(/continue/);
    expect(
      () =>
        new WorkflowRuntime({
          eventStore: new InMemoryAsyncEventStore(),
          snapshotStore: new InMemoryAsyncSnapshotStore(),
          heartbeat: { leaseStore: new InMemoryLeaseStore(), onStoreError: "continue" },
        } as never)
    ).toThrow(/continue/);
  });
});

async function until(cond: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("until: condition not met");
}
