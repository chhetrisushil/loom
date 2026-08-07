import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { indexByEventType, reconstructProjections } from "./projections";
import type { ProjectionSource } from "./types";
import { InspectorBudgetError } from "./types";

const EXEC = "exec-1";

function envelope(sequence: number, eventType: string, payload: unknown = {}): EventEnvelope {
  return {
    id: `${EXEC}-${sequence}`,
    workflowId: "wf",
    executionId: EXEC,
    eventType,
    sequence,
    timestamp: 1_000 + sequence,
    payload,
  };
}

/** Counts events of the types it declares. */
function counter(id: string, eventTypes: string[]): ProjectionSource {
  return {
    id,
    eventTypes,
    initialState: { count: 0 },
    load: async () =>
      Object.fromEntries(
        eventTypes.map((t) => [t, (s: unknown) => ({ count: (s as { count: number }).count + 1 })])
      ),
  };
}

describe("indexByEventType", () => {
  it("inverts many projections onto one lookup, including shared event types", () => {
    const index = indexByEventType([counter("a", ["X", "Y"]), counter("b", ["Y", "Z"])]);
    expect(index.get("X")).toEqual(["a"]);
    expect(index.get("Y")).toEqual(["a", "b"]);
    expect(index.get("Z")).toEqual(["b"]);
    expect(index.get("NOPE")).toBeUndefined();
  });
});

describe("reconstructProjections", () => {
  let events: InMemoryAsyncEventStore;

  beforeEach(async () => {
    events = new InMemoryAsyncEventStore();
    for (const e of [
      envelope(0, "A"),
      envelope(1, "B"),
      envelope(2, "A"),
      envelope(3, "C"),
      envelope(4, "A"),
    ]) {
      await events.append(e);
    }
  });

  it("folds only the events a projection declares", async () => {
    const [a] = await reconstructProjections(events, EXEC, [counter("pa", ["A"])], 4);
    expect(a?.status).toBe("ok");
    expect(a?.state).toEqual({ count: 3 });
    expect(a?.foldedEvents).toBe(3);
  });

  it("respects the position bound", async () => {
    const [a] = await reconstructProjections(events, EXEC, [counter("pa", ["A"])], 2);
    expect(a?.state).toEqual({ count: 2 });
  });

  it("reports a projection with no matching events as unaffected, NOT omitted", async () => {
    const slices = await reconstructProjections(
      events,
      EXEC,
      [counter("pa", ["A"]), counter("pz", ["NEVER_FIRED"])],
      4
    );
    expect(slices).toHaveLength(2);
    const z = slices.find((s) => s.projectionId === "pz");
    expect(z?.status).toBe("unaffected");
    expect(z?.state).toEqual({ count: 0 });
  });

  it("reports unavailable — never a current-version fallback — when the chunk is absent", async () => {
    const noLoad: ProjectionSource = { id: "gone", eventTypes: ["A"], initialState: { count: 0 } };
    const [slice] = await reconstructProjections(events, EXEC, [noLoad], 4);
    expect(slice?.status).toBe("unavailable");
    expect(slice?.state).toBeUndefined();
    expect(slice?.reason).toContain("pinned version");
  });

  it("reports unavailable when the chunk import rejects", async () => {
    const broken: ProjectionSource = {
      id: "broken",
      eventTypes: ["A"],
      initialState: {},
      load: async () => {
        throw new Error("chunk 404");
      },
    };
    const [slice] = await reconstructProjections(events, EXEC, [broken], 4);
    expect(slice?.status).toBe("unavailable");
    expect(slice?.reason).toContain("chunk 404");
  });

  it("isolates a throwing fold to its own projection", async () => {
    const thrower: ProjectionSource = {
      id: "thrower",
      eventTypes: ["A"],
      initialState: {},
      load: async () => ({
        A: () => {
          throw new Error("bad fold");
        },
      }),
    };
    const slices = await reconstructProjections(events, EXEC, [thrower, counter("ok", ["A"])], 4);
    expect(slices.find((s) => s.projectionId === "thrower")?.status).toBe("unavailable");
    // The healthy projection still reports — one broken fold must not blank the view.
    expect(slices.find((s) => s.projectionId === "ok")?.status).toBe("ok");
  });

  it("does not resolve a handler through the prototype chain", async () => {
    const proto = { A: () => ({ pwned: true }) };
    const inherited: ProjectionSource = {
      id: "inherited",
      eventTypes: ["A"],
      initialState: { count: 0 },
      load: async () => Object.create(proto) as Record<string, never>,
    };
    const [slice] = await reconstructProjections(events, EXEC, [inherited], 4);
    expect(slice?.status).toBe("ok");
    // Handler skipped (not own), so the initial state is unchanged.
    expect(slice?.state).toEqual({ count: 0 });
    expect(slice?.foldedEvents).toBe(0);
  });

  it("ignores a non-callable handler entry rather than throwing", async () => {
    const bogus: ProjectionSource = {
      id: "bogus",
      eventTypes: ["A"],
      initialState: { count: 0 },
      load: async () => ({ A: "not a function" }) as unknown as Record<string, never>,
    };
    const [slice] = await reconstructProjections(events, EXEC, [bogus], 4);
    expect(slice?.status).toBe("ok");
    expect(slice?.state).toEqual({ count: 0 });
  });

  it("reads the log once for many projections", async () => {
    let reads = 0;
    const counted = {
      read: (id: string) => events.read(id),
      readFrom: (id: string, f: number) => events.readFrom(id, f),
      readRange: (id: string, f: number, t: number) => {
        reads++;
        return events.readRange(id, f, t);
      },
    };
    await reconstructProjections(
      counted,
      EXEC,
      [counter("a", ["A"]), counter("b", ["B"]), counter("c", ["C"])],
      4
    );
    expect(reads).toBe(1);
  });

  it("refuses an over-budget read", async () => {
    await expect(
      reconstructProjections(events, EXEC, [counter("a", ["A"])], 4, { maxEvents: 2 })
    ).rejects.toBeInstanceOf(InspectorBudgetError);
  });

  it("is empty for no sources, without touching the store", async () => {
    const exploding = {
      read: () => Promise.reject(new Error("must not read")),
      readFrom: () => Promise.reject(new Error("must not read")),
    };
    expect(await reconstructProjections(exploding, EXEC, [], 4)).toEqual([]);
  });
});
