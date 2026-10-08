import { tainted } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { evidenceEvents } from "./evidence";
import {
  type ExportExecutionRef,
  type ExportOptions,
  type ExportSource,
  type ExportStats,
  exportJsonl,
  newExportStats,
} from "./export";

let seq = 0;
function ev(executionId: string, eventType: string, payload: unknown): EventEnvelope {
  seq += 1;
  return {
    id: `e${seq}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence: seq,
    timestamp: 1000 + seq,
    payload,
  };
}

interface Spec {
  id: string;
  tenant?: string;
  principal?: string;
  context?: unknown;
  choice?: unknown;
  alternatives?: unknown[];
  reward?: number;
  extra?: EventEnvelope[];
  policy?: unknown;
}

function execution(s: Spec): { ref: ExportExecutionRef; events: EventEnvelope[] } {
  const events = [
    ev(s.id, "DECISION_RECORDED", {
      decisionId: "route",
      choice: s.choice ?? "a",
      context: s.context ?? { q: 1 },
      alternatives: s.alternatives ?? ["a", "b"],
      policy: s.policy ?? { id: "p", version: "1", propensity: 0.5 },
    }),
    ev(s.id, "OUTCOME_RECORDED", { key: "k", score: s.reward ?? 1, decisionId: "route" }),
    ...(s.extra ?? []),
    ev(s.id, "EXECUTION_COMPLETED", {}),
  ];
  return {
    ref: {
      executionId: s.id,
      ...(s.tenant !== undefined && { tenant: s.tenant }),
      ...(s.principal !== undefined && { principal: s.principal }),
    },
    events,
  };
}

function source(specs: Spec[], opts: { pages?: number } = {}) {
  const all = specs.map(execution);
  const loaded: string[] = [];
  const listed: (string | undefined)[] = [];
  const src: ExportSource = {
    async list(cursor, limit) {
      listed.push(cursor);
      const start = cursor === undefined ? 0 : Number(cursor);
      const size = Math.min(limit, opts.pages ?? limit);
      const slice = all.slice(start, start + size);
      const next = start + size < all.length ? String(start + size) : undefined;
      return { executions: slice.map((e) => e.ref), ...(next !== undefined && { next }) };
    },
    async load(id) {
      loaded.push(id);
      return all.find((e) => e.ref.executionId === id)?.events ?? [];
    },
  };
  return { src, loaded, listed };
}

async function run(
  o: ExportOptions
): Promise<{ lines: Record<string, unknown>[]; raw: string[]; stats: ExportStats }> {
  const stats = newExportStats();
  const raw: string[] = [];
  for await (const l of exportJsonl(o, stats)) raw.push(l);
  return { raw, lines: raw.map((l) => JSON.parse(l)), stats };
}
const ofType = (r: { lines: Record<string, unknown>[] }, t: string) =>
  r.lines.filter((l) => l.type === t);

describe("exportJsonl (R18)", () => {
  it("exports only the named tenant's executions and never LOADS another tenant's or an unlabelled one", async () => {
    const { src, loaded } = source([
      { id: "a1", tenant: "t1" },
      { id: "b1", tenant: "t2" },
      { id: "n1" },
      { id: "a2", tenant: "t1" },
    ]);
    const r = await run({ source: src, tenant: "t1" });
    expect(ofType(r, "trajectory").map((l) => l.executionId)).toEqual(["a1", "a2"]);
    expect(loaded).toEqual(["a1", "a2"]);
    expect(r.stats.skipped.otherTenant).toBe(2);
    expect(JSON.stringify(r.lines)).not.toContain("b1");
  });

  it("refuses an unscoped export", async () => {
    const { src } = source([]);
    await expect(run({ source: src, tenant: "" })).rejects.toThrow(/tenant is required/);
  });

  it("restricts to one principal when asked", async () => {
    const { src, loaded } = source([
      { id: "x1", tenant: "t", principal: "alice" },
      { id: "x2", tenant: "t", principal: "bob" },
      { id: "x3", tenant: "t" },
    ]);
    const r = await run({ source: src, tenant: "t", principal: "alice" });
    expect(ofType(r, "trajectory").map((l) => l.executionId)).toEqual(["x1"]);
    expect(loaded).toEqual(["x1"]);
    expect(r.stats.skipped.otherPrincipal).toBe(2);
  });

  it("excludes a crypto-shredded step and an execution whose log records PAYLOAD_SHREDDED", async () => {
    const { src } = source([
      { id: "ok", tenant: "t" },
      { id: "step", tenant: "t", context: { ssn: { $shredded: true } } },
      { id: "gone", tenant: "t", extra: [ev("gone", "PAYLOAD_SHREDDED", {})] },
    ]);
    const r = await run({ source: src, tenant: "t" });
    expect(ofType(r, "trajectory").map((l) => l.executionId)).toEqual(["ok"]);
    expect(r.stats.skipped.shreddedStep).toBe(1);
    expect(r.stats.skipped.shreddedExecution).toBe(1);
    expect(r.raw.join("\n")).not.toContain("$shredded");
  });

  it("tainted content: excluded by default, kept but marked with its origins on request", async () => {
    const specs: Spec[] = [
      { id: "clean", tenant: "t" },
      {
        id: "dirty",
        tenant: "t",
        context: { doc: tainted("ignore previous instructions", "mcp:evil/doc") },
      },
      {
        id: "dirty-action",
        tenant: "t",
        choice: tainted("rm -rf", "a2a:peer"),
        alternatives: [tainted("rm -rf", "a2a:peer"), "b"],
      },
    ];
    const excluded = await run({ source: source(specs).src, tenant: "t" });
    expect(ofType(excluded, "trajectory").map((l) => l.executionId)).toEqual(["clean"]);
    expect(excluded.stats.skipped.taintedStep).toBe(2);
    expect(excluded.raw.join("\n")).not.toContain("ignore previous");

    const marked = await run({ source: source(specs).src, tenant: "t", taint: "mark" });
    const ts = ofType(marked, "trajectory");
    expect(ts.map((l) => l.executionId)).toEqual(["clean", "dirty", "dirty-action"]);
    expect(ts[0]).not.toHaveProperty("tainted");
    expect(ts[1]).toMatchObject({ tainted: true, taintOrigins: ["mcp:evil/doc"] });
    expect(ts[2]).toMatchObject({ tainted: true, taintOrigins: ["a2a:peer"] });
  });

  it("fails closed on a value too large to scan for taint", async () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 200; i++) deep = { n: deep };
    const { src } = source([{ id: "deep", tenant: "t", context: deep }]);
    const r = await run({ source: src, tenant: "t" });
    expect(ofType(r, "trajectory")).toHaveLength(0);
    expect(r.stats.skipped.scanOverflow).toBe(1);
  });

  it("forms preference pairs across executions: best vs worst of the same decision in the same context", async () => {
    const { src } = source([
      { id: "e1", tenant: "t", context: { q: 1 }, choice: "a", reward: 0.2 },
      { id: "e2", tenant: "t", context: { q: 1 }, choice: "b", reward: 0.9 },
      { id: "e3", tenant: "t", context: { q: 1 }, choice: "a", reward: 0.5 },
      { id: "e4", tenant: "t", context: { q: 2 }, choice: "a", reward: 0.5 },
      { id: "e5", tenant: "t", context: { q: 3 }, choice: "a", reward: 0.5 },
      { id: "e6", tenant: "t", context: { q: 3 }, choice: "b", reward: 0.5 }, // tie: no preference
    ]);
    const r = await run({ source: src, tenant: "t", kinds: ["preference"] });
    const prefs = ofType(r, "preference");
    expect(prefs).toHaveLength(1);
    expect(prefs[0]).toMatchObject({
      prompt: { q: 1 },
      chosen: "b",
      rejected: "a",
      margin: 0.7,
      chosenRef: { executionId: "e2", decisionId: "route" },
      rejectedRef: { executionId: "e1" },
    });
    expect(ofType(r, "trajectory")).toHaveLength(0);
  });

  it("a preference between two actions that are the same action is never emitted", async () => {
    const { src } = source([
      { id: "e1", tenant: "t", choice: "a", reward: 0.1 },
      { id: "e2", tenant: "t", choice: "a", reward: 0.9 },
    ]);
    expect(ofType(await run({ source: src, tenant: "t" }), "preference")).toHaveLength(0);
  });

  it("minMargin filters weak pairs; tainted steps never form pairs by default", async () => {
    const specs: Spec[] = [
      { id: "e1", tenant: "t", choice: "a", reward: 0.4 },
      { id: "e2", tenant: "t", choice: "b", reward: 0.5 },
    ];
    expect(
      ofType(await run({ source: source(specs).src, tenant: "t", minMargin: 0.2 }), "preference")
    ).toHaveLength(0);
    expect(
      ofType(await run({ source: source(specs).src, tenant: "t", minMargin: 0.05 }), "preference")
    ).toHaveLength(1);
    const poisoned: Spec[] = [
      { id: "e1", tenant: "t", choice: "a", reward: 0.1 },
      {
        id: "e2",
        tenant: "t",
        choice: tainted("b", "mcp:x"),
        alternatives: ["a", tainted("b", "mcp:x")],
        reward: 0.9,
      },
    ];
    expect(
      ofType(await run({ source: source(poisoned).src, tenant: "t" }), "preference")
    ).toHaveLength(0);
    const marked = ofType(
      await run({ source: source(poisoned).src, tenant: "t", taint: "mark" }),
      "preference"
    );
    expect(marked[0]).toMatchObject({ tainted: true, taintOrigins: ["mcp:x"] });
  });

  it("is byte-deterministic for the same log, and context can be dropped", async () => {
    const specs: Spec[] = [
      { id: "e1", tenant: "t", choice: "a", reward: 0.1 },
      { id: "e2", tenant: "t", choice: "b", reward: 0.9 },
    ];
    const s = source(specs);
    const a = await run({ source: s.src, tenant: "t" });
    const b = await run({ source: s.src, tenant: "t" });
    expect(a.raw.join("\n")).toBe(b.raw.join("\n"));
    expect(a.lines[0]).toMatchObject({
      type: "header",
      format: "loom-learning-export/1",
      tenant: "t",
    });
    expect(a.lines.at(-1)).toMatchObject({ type: "summary" });
    const bare = await run({ source: s.src, tenant: "t", includeContext: false });
    expect(bare.raw.join("\n")).not.toContain('"context"');
    expect(bare.raw.join("\n")).not.toContain('"prompt"');
  });

  it("streams: pulls pages over the cursor and loads lazily (no whole-log read)", async () => {
    const specs = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, tenant: "t" }));
    const { src, loaded, listed } = source(specs, { pages: 10 });
    const stats = newExportStats();
    const it = exportJsonl(
      { source: src, tenant: "t", kinds: ["trajectory"], pageSize: 10 },
      stats
    );
    await it.next(); // header
    await it.next(); // first trajectory
    expect(loaded).toEqual(["s0"]);
    expect(listed).toEqual([undefined]);
    for await (const _ of it) {
      /* drain */
    }
    expect(listed).toEqual([undefined, "10", "20"]);
    expect(loaded).toHaveLength(25);
  });

  it("stops at maxExecutions with a cursor to resume from", async () => {
    const specs = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, tenant: "t" }));
    const { src } = source(specs, { pages: 5 });
    const first = await run({
      source: src,
      tenant: "t",
      kinds: ["trajectory"],
      pageSize: 5,
      maxExecutions: 7,
    });
    expect(first.stats.truncated).toBe(true);
    expect(first.stats.nextCursor).toBe('lx1:{"c":"5","s":2}');
    // resume from the exact position inside the page
    const second = await run({
      source: src,
      tenant: "t",
      kinds: ["trajectory"],
      pageSize: 5,
      cursor: first.stats.nextCursor,
    });
    const ids = new Set(
      [...ofType(first, "trajectory"), ...ofType(second, "trajectory")].map((l) => l.executionId)
    );
    expect(ids.size).toBe(12);
  });

  it("skips oversize logs and lines, and a loader that returns another execution's events", async () => {
    const big = source([{ id: "big", tenant: "t" }]);
    expect(
      (await run({ source: big.src, tenant: "t", maxEventsPerExecution: 2 })).stats.skipped
        .tooManyEvents
    ).toBe(1);
    const fat = await run({
      source: source([{ id: "fat", tenant: "t" }]).src,
      tenant: "t",
      maxLineBytes: 50,
    });
    expect(fat.stats.skipped.lineTooLong).toBe(1);
    expect(ofType(fat, "trajectory")).toHaveLength(0);

    const wrong: ExportSource = {
      list: async () => ({ executions: [{ executionId: "mine", tenant: "t" }] }),
      load: async () => execution({ id: "someone-elses", tenant: "t2" }).events,
    };
    const r = await run({ source: wrong, tenant: "t" });
    expect(r.stats.skipped.emptyOrMismatched).toBe(1);
    expect(ofType(r, "trajectory")).toHaveLength(0);
  });

  it("bounds the preference index and a bad page size", async () => {
    const specs = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`,
      tenant: "t",
      context: { q: i },
      reward: i / 10,
    }));
    const r = await run({ source: source(specs).src, tenant: "t", maxPreferenceGroups: 2 });
    expect(r.stats.skipped.preferenceGroupsDropped).toBe(4);
    await expect(run({ source: source([]).src, tenant: "t", pageSize: 0 })).rejects.toThrow(
      /pageSize/
    );
    await expect(run({ source: source([]).src, tenant: "t", pageSize: 5000 })).rejects.toThrow(
      /pageSize/
    );
  });
});

describe("exportJsonl hardening (R18 fix round 1)", () => {
  const paged = (ids: string[], load: (id: string) => EventEnvelope[]): ExportSource => ({
    async list(cursor, limit) {
      const start = cursor === undefined ? 0 : Number(cursor);
      const next = start + limit < ids.length ? String(start + limit) : undefined;
      return {
        executions: ids
          .slice(start, start + limit)
          .map((executionId) => ({ executionId, tenant: "t" })),
        ...(next !== undefined && { next }),
      };
    },
    async load(id) {
      return load(id);
    },
  });
  const one = (id: string) => execution({ id, tenant: "t", context: { id } }).events;

  async function drain(o: Omit<ExportOptions, "cursor">, maxRuns = 20) {
    const ids: string[] = [];
    let cursor: string | undefined;
    let runs = 0;
    do {
      const r = await run({ ...o, ...(cursor !== undefined && { cursor }) });
      for (const l of ofType(r, "trajectory")) ids.push(l.executionId as string);
      if (r.stats.truncated) expect(r.stats.nextCursor).toBeDefined();
      cursor = r.stats.truncated ? r.stats.nextCursor : undefined;
      runs += 1;
    } while (cursor !== undefined && runs < maxRuns);
    return { ids, runs };
  }

  it("maxExecutions smaller than a page progresses to completion across runs, no gaps, no duplicates", async () => {
    const all = Array.from({ length: 10 }, (_, i) => `x${i}`);
    const { ids, runs } = await drain({
      source: paged(all, one),
      tenant: "t",
      kinds: ["trajectory"],
      pageSize: 10,
      maxExecutions: 4,
    });
    expect(ids).toEqual(all);
    expect(runs).toBe(3);
  });

  it("a single page larger than maxRecords progresses too", async () => {
    const all = Array.from({ length: 9 }, (_, i) => `y${i}`);
    const { ids } = await drain({
      source: paged(all, one),
      tenant: "t",
      kinds: ["trajectory"],
      pageSize: 100,
      maxRecords: 2,
    });
    expect(ids).toEqual(all);
  });

  it("resumes across page boundaries and mid-page alike", async () => {
    const all = Array.from({ length: 23 }, (_, i) => `z${i}`);
    const { ids } = await drain({
      source: paged(all, one),
      tenant: "t",
      kinds: ["trajectory"],
      pageSize: 5,
      maxExecutions: 7,
    });
    expect(ids).toEqual(all);
  });

  it("refuses a zero bound (it could never advance) and a malformed resume cursor", async () => {
    const s = paged(["a"], one);
    await expect(run({ source: s, tenant: "t", maxExecutions: 0 })).rejects.toThrow(
      /maxExecutions/
    );
    await expect(run({ source: s, tenant: "t", maxRecords: 0 })).rejects.toThrow(/maxRecords/);
    // anything that is not OUR strict envelope is the source's own cursor, passed through untouched
    for (const bare of [
      "lx1:{nope",
      'lx1:{"c":null,"s":-1}',
      'lx1:{"c":null,"s":1.5}',
      'lx1:{"c":null,"s":1,"x":2}',
      "lx1:null",
    ]) {
      const seen: (string | undefined)[] = [];
      const probe: ExportSource = {
        async list(cursor) {
          seen.push(cursor);
          return { executions: [{ executionId: "a", tenant: "t" }] };
        },
        load: async () => one("a"),
      };
      await run({ source: probe, tenant: "t", cursor: bare });
      expect(seen).toEqual([bare]);
    }
    // a real envelope is unwrapped: the source sees the page cursor, and `skip` executions are skipped
    const seen: (string | undefined)[] = [];
    const probe: ExportSource = {
      async list(cursor) {
        seen.push(cursor);
        return {
          executions: [
            { executionId: "a", tenant: "t" },
            { executionId: "b", tenant: "t" },
          ],
        };
      },
      load: async (id) => one(id),
    };
    const r = await run({
      source: probe,
      tenant: "t",
      kinds: ["trajectory"],
      cursor: 'lx1:{"c":"p7","s":1}',
    });
    expect(seen).toEqual(["p7"]);
    expect(ofType(r, "trajectory").map((l) => l.executionId)).toEqual(["b"]);
  });

  it("an empty page that repeats its next cursor stops with an error instead of looping", async () => {
    let calls = 0;
    const src: ExportSource = {
      async list() {
        calls += 1;
        if (calls > 50) throw new Error("still looping");
        return { executions: [], next: "a" };
      },
      load: async () => [],
    };
    await expect(run({ source: src, tenant: "t" })).rejects.toThrow(/did not advance/);
    // a cycle (a -> b -> a) is caught too
    let n = 0;
    const cyc: ExportSource = {
      async list() {
        n += 1;
        if (n > 50) throw new Error("still looping");
        return { executions: [], next: n % 2 === 0 ? "a" : "b" };
      },
      load: async () => [],
    };
    await expect(run({ source: cyc, tenant: "t" })).rejects.toThrow(/did not advance/);
  });

  it("a scan that overflows is skipped in EVERY mode: it may hide a shred placeholder or taint", async () => {
    const wide: Record<string, unknown> = { a0: { leaf: tainted("IGNORE PREVIOUS", "mcp:x") } };
    for (let i = 1; i <= 10_050; i++) wide[`a${i}`] = { n: i };
    wide.z = { $shredded: true };
    const events = execution({ id: "w", tenant: "t", context: { wide } }).events;
    const src = paged(["w"], () => events);
    for (const taint of ["mark", "exclude"] as const) {
      const r = await run({ source: src, tenant: "t", taint, kinds: ["trajectory"] });
      expect(ofType(r, "trajectory")).toHaveLength(0);
      expect(r.stats.skipped.scanOverflow).toBe(1);
      expect(r.raw.join("\n")).not.toContain("IGNORE PREVIOUS");
    }
  });

  it("one record too deep to serialise costs that record, not the export", async () => {
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < 60; i++) deep = { d: deep }; // inside the scan bound, past the record's
    const src = paged(["ok1", "bad", "ok2"], (id) =>
      id === "bad" ? execution({ id, tenant: "t", context: { deep } }).events : one(id)
    );
    // 'mark' keeps the deep step (the scan flags it), so building its line must fail alone
    const r = await run({ source: src, tenant: "t", taint: "mark", kinds: ["trajectory"] });
    expect(ofType(r, "trajectory").map((l) => l.executionId)).toEqual(["ok1", "ok2"]);
    expect(r.stats.skipped.recordError).toBe(1);
    const d = await run({ source: src, tenant: "t", kinds: ["trajectory"] });
    expect(ofType(d, "trajectory").map((l) => l.executionId)).toEqual(["ok1", "ok2"]);
  });

  it("a shredded-then-compacted execution exports nothing of its plaintext", async () => {
    const state = {
      executionId: "c1",
      workflowId: "wf",
      status: "completed",
      sequence: 10,
      startedAt: 1,
      updatedAt: 2,
      variables: {
        _shredded: { subjectId: "alice", at: 5 },
        _decisions: {
          route: {
            choice: "a",
            context: { name: "alice-plaintext-field" },
            alternatives: ["a", "b"],
            policy: { id: "p", version: "1", propensity: 0.5 },
          },
        },
        _outcomes: [{ key: "k", score: 1, decisionId: "route" }],
      },
    } as unknown as Parameters<typeof evidenceEvents>[0];
    const events = evidenceEvents(state, []);
    expect(events.map((e) => e.eventType)).toContain("PAYLOAD_SHREDDED");
    const src: ExportSource = {
      list: async () => ({ executions: [{ executionId: "c1", tenant: "t" }] }),
      load: async () => events,
    };
    const r = await run({ source: src, tenant: "t" });
    expect(r.stats.skipped.shreddedExecution).toBe(1);
    expect(r.raw.join("\n")).not.toContain("alice-plaintext-field");
    // and an execution that was NOT shredded is untouched by the new marker
    const clean = evidenceEvents(
      { ...state, variables: { ...state.variables, _shredded: undefined } } as never,
      []
    );
    expect(clean.map((e) => e.eventType)).not.toContain("PAYLOAD_SHREDDED");
  });
});
