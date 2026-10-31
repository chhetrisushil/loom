import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { InMemoryArchiveStore } from "./InMemoryArchiveStore";
import { InMemoryAsyncEventStore } from "./InMemoryAsyncEventStore";
import { TenantScopedArchiveStore } from "./TenantScopedArchiveStore";
import { TenantScopedEventStore } from "./TenantScopedEventStore";
import { assertSegmentDigest, buildSegment, pageIds, segmentDigest } from "./archive";
import { ArchiveUnserializableError } from "./archiveSpi";

const env = (sequence: number, payload: unknown): EventEnvelope => ({
  id: `x-${sequence}`,
  workflowId: "wf",
  executionId: "x",
  eventType: "E",
  sequence,
  timestamp: 1,
  payload,
});

describe("ADR 0138 L1 - the digest is over the JSON form", () => {
  it("a Date / toJSON payload digests the same before and after a JSON round trip", () => {
    const live = [env(1, { at: new Date(0), v: { toJSON: () => "j" }, gone: undefined })];
    const stored = JSON.parse(JSON.stringify(live)) as EventEnvelope[];
    expect(segmentDigest(live)).toBe(segmentDigest(stored));
    const seg = buildSegment(live, "inc");
    expect(() => assertSegmentDigest("x", { ...seg, envelopes: stored })).not.toThrow();
  });

  it("a circular value, a BigInt or a too-deep nesting is a typed error, not a bare TypeError/RangeError", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => segmentDigest([env(1, circular)])).toThrow(ArchiveUnserializableError);
    expect(() => segmentDigest([env(1, { n: 1n })])).toThrow(ArchiveUnserializableError);
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i++) deep = { d: deep };
    expect(() => segmentDigest([env(1, deep)])).toThrow(ArchiveUnserializableError);
  });
});

describe("TenantScopedArchiveStore (ADR 0138 H3)", () => {
  it("two tenants with the same execution id never see each other's segments; delete and list are scoped", async () => {
    const raw = new InMemoryArchiveStore();
    const a = new TenantScopedArchiveStore(raw, "a");
    const b = new TenantScopedArchiveStore(raw, "b");
    await a.append("x", buildSegment([env(1, "a")], "inc-a"));
    await b.append("x", buildSegment([env(1, "b")], "inc-b"));
    expect((await a.read("x"))[0]!.envelopes[0]!.payload).toBe("a");
    expect((await b.read("x"))[0]!.envelopes[0]!.payload).toBe("b");
    expect((await raw.listExecutions()).executionIds).toEqual(["a:x", "b:x"]);
    expect((await a.listExecutions()).executionIds).toEqual(["x"]);
    await b.deleteExecution!("x");
    expect(await b.headers("x")).toEqual([]);
    expect((await a.headers("x")).length).toBe(1);
  });

  it("exposes the tenant marker on both stores and forwards the sealing markers", () => {
    const keys = {};
    const sealing = Object.assign(new InMemoryArchiveStore(), {
      keys,
      sealsSegments: true as const,
    });
    const scoped = new TenantScopedArchiveStore(sealing, "t");
    expect(scoped.tenantScope).toBe("t");
    expect(scoped.keys).toBe(keys);
    expect(scoped.sealsSegments).toBe(true);
    expect(new TenantScopedEventStore(new InMemoryAsyncEventStore(), "t").tenantScope).toBe("t");
    expect(() => new TenantScopedArchiveStore(raw(), "a:b")).toThrow(TypeError);
  });
});

const raw = () => new InMemoryArchiveStore();

describe("pageIds", () => {
  it("keyset-pages ascending with an exclusive cursor", () => {
    const ids = ["a", "b", "c"];
    expect(pageIds(ids, { limit: 2 })).toEqual({ executionIds: ["a", "b"], nextCursor: "b" });
    expect(pageIds(ids, { cursor: "b", limit: 2 })).toEqual({ executionIds: ["c"] });
    expect(pageIds(ids, { cursor: "c" })).toEqual({ executionIds: [] });
  });
});
