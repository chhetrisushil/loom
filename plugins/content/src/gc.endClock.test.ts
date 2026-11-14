import type { EventEnvelope } from "@loomwork/core";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { ReplayVM } from "@loomwork/replay-vm";
import { describe, expect, it } from "vitest";
import { terminalEndOf } from "./executionEnd";
import { sweepUnpinnedContent } from "./gc";
import { InMemoryContentStore } from "./index";

// ADR 0146 - a reclaimable ref ages from the citing execution's END, never earlier than its citation.

const DAY = 24 * 60 * 60 * 1000;
const TTL = 30 * DAY;
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

function evt(
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown,
  timestamp: number,
  metadata?: Record<string, unknown>
): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence,
    timestamp,
    payload,
    ...(metadata !== undefined && { metadata }),
  };
}

const envelopeFor = (address: string) => ({
  __loomClaimCheck: true,
  ref: { __loomContent: address },
  size: 1,
});
const cite = (id: string, seq: number, address: string, at: number) =>
  evt(id, seq, "STEP_COMPLETED", { stepId: `s${seq}`, output: envelopeFor(address) }, at);
const end = (id: string, seq: number, kind: string, at: number, kernel = false) =>
  evt(id, seq, kind, {}, at, kernel ? { kernel: true } : undefined);

async function setup(build: (ref: string) => EventEnvelope[][]) {
  const content = new InMemoryContentStore({ now: () => 1 });
  const ref = (await content.put(bytes("telemetry sample"))).__loomContent;
  const store = new InMemoryAsyncEventStore();
  for (const log of build(ref)) for (const e of log) await store.append(e);
  const sweep = (now: number, extra: object = {}) =>
    sweepUnpinnedContent({
      eventStores: [store],
      contentStore: content,
      pinnedEventTypes: ["FINDING_RECORDED"],
      snapshotStores: [{ loadLatest: async () => null, loadLatestBefore: async () => null }],
      olderThanMs: TTL,
      touchedBefore: now - TTL,
      now,
      ...extra,
    });
  return { content, ref, store, sweep };
}

const completedRun = (ref: string) => [
  evt("A", 0, "EXECUTION_STARTED", {}, 0),
  cite("A", 1, ref, 0),
  end("A", 2, "EXECUTION_COMPLETED", 20 * DAY),
];

describe("end clock (ADR 0146)", () => {
  it("(a) a terminal execution ages its citation from its end; boundary inclusive", async () => {
    const t = await setup((ref) => [completedRun(ref)]);
    expect((await t.sweep(40 * DAY, { dryRun: true })).reclaimed).toEqual([]);
    expect((await t.sweep(50 * DAY, { dryRun: true })).reclaimed).toEqual([t.ref]);
    const control = await setup((ref) => [completedRun(ref).slice(0, 2)]);
    expect((await control.sweep(40 * DAY, { dryRun: true })).reclaimed).toEqual([control.ref]);
  });

  it("(b) a late citation after the end is never aged earlier than the citation", async () => {
    const t = await setup((ref) => [
      [
        evt("A", 0, "EXECUTION_STARTED", {}, 0),
        cite("A", 1, ref, 0),
        end("A", 2, "EXECUTION_COMPLETED", 10 * DAY),
        cite("A", 3, ref, 25 * DAY),
      ],
    ]);
    expect((await t.sweep(50 * DAY, { dryRun: true })).reclaimed).toEqual([]);
    expect((await t.sweep(55 * DAY, { dryRun: true })).reclaimed).toEqual([t.ref]);
  });

  it("(c) an execution re-opened after its end is live; ending again restarts the clock", async () => {
    const reopened = (ref: string) => [
      evt("A", 0, "EXECUTION_STARTED", {}, 0),
      cite("A", 1, ref, 0),
      end("A", 2, "EXECUTION_COMPLETED", 20 * DAY),
      evt("A", 3, "EXECUTION_RESUMED", null, 21 * DAY),
    ];
    const t = await setup((ref) => [reopened(ref)]);
    expect((await t.sweep(40 * DAY, { dryRun: true })).reclaimed).toEqual([t.ref]);
    const again = await setup((ref) => [
      [...reopened(ref), end("A", 4, "EXECUTION_COMPLETED", 35 * DAY)],
    ]);
    expect((await again.sweep(50 * DAY, { dryRun: true })).reclaimed).toEqual([]);
    expect((await again.sweep(65 * DAY, { dryRun: true })).reclaimed).toEqual([again.ref]);
  });

  it("(d) each terminal kind ends it; an unstamped EXECUTION_CONTINUED does not", async () => {
    for (const [kind, kernel, ends] of [
      ["EXECUTION_FAILED", false, true],
      ["EXECUTION_CANCELLED", false, true],
      ["EXECUTION_CONTINUED", true, true],
      ["EXECUTION_CONTINUED", false, false],
    ] as const) {
      const t = await setup((ref) => [[cite("A", 0, ref, 0), end("A", 1, kind, 20 * DAY, kernel)]]);
      const r = await t.sweep(40 * DAY, { dryRun: true });
      expect(r.reclaimed, `${kind} kernel=${kernel}`).toEqual(ends ? [] : [t.ref]);
    }
  });

  it("(e) the newest effective time across executions wins", async () => {
    const mk = (bCite: number) => (ref: string) => [completedRun(ref), [cite("B", 0, ref, bCite)]];
    expect((await (await setup(mk(5 * DAY))).sweep(40 * DAY, { dryRun: true })).reclaimed).toEqual(
      []
    );
    expect((await (await setup(mk(35 * DAY))).sweep(40 * DAY, { dryRun: true })).reclaimed).toEqual(
      []
    );
    const old = await setup((ref) => [
      [cite("A", 0, ref, 0), end("A", 1, "EXECUTION_COMPLETED", 1 * DAY)],
      [cite("B", 0, ref, 5 * DAY)],
    ]);
    expect((await old.sweep(40 * DAY, { dryRun: true })).reclaimed).toEqual([old.ref]);
  });

  it("(f) a never-ending execution keeps the citation clock", async () => {
    const t = await setup((ref) => [
      [evt("P", 0, "EXECUTION_STARTED", {}, 0), cite("P", 1, ref, 0), cite("P", 2, ref, 10 * DAY)],
    ]);
    const r = await t.sweep(45 * DAY);
    expect(r.reclaimed).toEqual([t.ref]);
    expect(r.refsAgedByEnd).toBe(0);
  });

  it("(g) pinned kinds, bare citations and roots are never reclaimed, ended or not", async () => {
    const t = await setup((ref) => [
      [
        evt("A", 0, "FINDING_RECORDED", { x: envelopeFor(ref) }, 0),
        end("A", 1, "EXECUTION_COMPLETED", 1 * DAY),
      ],
    ]);
    expect((await t.sweep(90 * DAY)).reclaimed).toEqual([]);
    const bare = await setup((ref) => [
      [
        evt("A", 0, "STEP_COMPLETED", { evidence: { __loomContent: ref } }, 0),
        end("A", 1, "EXECUTION_COMPLETED", 1 * DAY),
      ],
    ]);
    expect((await bare.sweep(90 * DAY)).reclaimed).toEqual([]);
    const rooted = await setup((ref) => [completedRun(ref)]);
    const r = await rooted.sweep(90 * DAY, {
      roots: async function* () {
        yield rooted.ref;
      },
    });
    expect(r.reclaimed).toEqual([]);
  });

  it("(h) the orphan pass is unaffected: a cited blob is never an orphan, an uncited one is", async () => {
    const t = await setup((ref) => [completedRun(ref)]);
    const orphan = (await t.content.put(bytes("nobody cites me"))).__loomContent;
    const r = await t.sweep(90 * DAY, {
      reclaimOrphans: true,
      dryRun: true, // the fixture store clock is fixed: an ERASING orphan pass would refuse its margin
    });
    expect(r.reclaimed).toEqual([t.ref]); // by the TTL pass, not as an orphan
    expect(r.orphansReclaimed).toEqual([orphan]);
  });

  it("(i) olderThanMs 0: an end equal to now reclaims, an end one ms later keeps", async () => {
    const mk = (endAt: number) => (ref: string) => [
      [cite("A", 0, ref, 0), end("A", 1, "EXECUTION_COMPLETED", endAt)],
    ];
    const at = await setup(mk(1000));
    expect((await at.sweep(1000, { olderThanMs: 0, dryRun: true })).reclaimed).toEqual([at.ref]);
    const later = await setup(mk(1001));
    expect((await later.sweep(1000, { olderThanMs: 0, dryRun: true })).reclaimed).toEqual([]);
  });

  it("(j) a compacted log (gap below the retained terminal event) still finds its end", async () => {
    const t = await setup((ref) => [
      [cite("A", 5, ref, 0), end("A", 6, "EXECUTION_COMPLETED", 20 * DAY)],
    ]);
    expect((await t.sweep(40 * DAY, { dryRun: true })).reclaimed).toEqual([]);
    expect((await t.sweep(50 * DAY, { dryRun: true })).reclaimed).toEqual([t.ref]);
  });

  it("(k) dry run reports what the end clock holds; an erasing run reports no such list", async () => {
    const t = await setup((ref) => [completedRun(ref)]);
    const dry = await t.sweep(40 * DAY, { dryRun: true });
    expect(dry.heldByEndClock).toEqual([t.ref]);
    expect(dry.refsAgedByEnd).toBe(1);
    expect(dry.reclaimed).toEqual([]);
    const real = await t.sweep(40 * DAY);
    expect(real.heldByEndClock).toBeUndefined();
    expect(real.refsAgedByEnd).toBe(1);
    expect(real.reclaimed).toEqual(dry.reclaimed);
    const reclaiming = await t.sweep(50 * DAY, { dryRun: true });
    expect(reclaiming.heldByEndClock).toEqual([]);
  });

  it("(l) terminalEndOf agrees with the ReplayVM fold on a table of logs", () => {
    const S = (n: number, k: string, at: number, p: unknown = {}, kernel = false) =>
      evt("X", n, k, p, at, kernel ? { kernel: true } : undefined);
    const start = S(0, "EXECUTION_STARTED", 1);
    const cont = S(2, "EXECUTION_CONTINUED", 9, { successorId: "Y" }, true);
    const table: Array<{ events: EventEnvelope[]; end: number | undefined }> = [
      { events: [start], end: undefined },
      { events: [start, S(1, "EXECUTION_COMPLETED", 5)], end: 5 },
      { events: [start, S(1, "EXECUTION_FAILED", 6, { error: "x" })], end: 6 },
      { events: [start, S(1, "EXECUTION_CANCELLED", 7)], end: 7 },
      { events: [start, S(1, "STEP_STARTED", 2, { stepId: "a" }), cont], end: 9 },
      {
        events: [start, S(1, "EXECUTION_COMPLETED", 5), S(2, "EXECUTION_RESUMED", 6, null)],
        end: undefined,
      },
      {
        events: [
          start,
          S(1, "EXECUTION_FAILED", 5, { error: "x" }),
          S(2, "EXECUTION_RESUMED", 6, null),
          S(3, "EXECUTION_COMPLETED", 8),
        ],
        end: 8,
      },
      {
        events: [
          start,
          S(1, "EXECUTION_COMPLETED", 5),
          S(2, "STEP_COMPLETED", 50, { stepId: "late", output: 1 }),
        ],
        end: 5,
      },
      {
        events: [start, S(1, "EXECUTION_SUSPENDED", 3, { condition: { type: "approval" } })],
        end: undefined,
      },
      // A non-kernel EXECUTION_CONTINUED is an application event: a no-op in the fold, not an end.
      { events: [start, S(1, "EXECUTION_CONTINUED", 4, { successorId: "Y" })], end: undefined },
      {
        events: [
          start,
          S(1, "EXECUTION_COMPLETED", 5),
          S(2, "EXECUTION_CONTINUED", 6, { successorId: "Y" }),
        ],
        end: 5,
      },
      // A wait-addressed EXECUTION_RESUMED (kernel-stamped) re-opens a terminal execution.
      {
        events: [
          start,
          S(1, "EXECUTION_COMPLETED", 5),
          S(2, "EXECUTION_RESUMED", 6, { waitId: "w1", payload: 1 }, true),
        ],
        end: undefined,
      },
    ];
    const terminal = new Set(["completed", "failed", "cancelled", "continued"]);
    for (const { events, end: expected } of table) {
      expect(terminalEndOf(events)).toBe(expected);
      const status = new ReplayVM(events).getState().status;
      expect(terminal.has(status), `${events.map((e) => e.eventType).join(",")} -> ${status}`).toBe(
        expected !== undefined
      );
    }
  });

  it("(n) a non-numeric terminal timestamp falls back to the citation clock exactly", async () => {
    // Cited 10d, ends "20d" but the terminal timestamp is garbage; sweep at 11d (cited 1 day ago).
    // Old clock keeps (1d < 30d TTL); at 45d old clock reclaims (35d >= 30d). Both must hold.
    const bad: unknown[] = [
      Number.NaN,
      "2026-01-01",
      "864000000",
      "9007199254740993",
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      null,
      undefined,
    ];
    for (const ts of bad) {
      const t = await setup((ref) => [
        [
          evt("A", 0, "EXECUTION_STARTED", {}, 0),
          cite("A", 1, ref, 10 * DAY),
          end("A", 2, "EXECUTION_COMPLETED", ts as number),
        ],
      ]);
      expect(terminalEndOf((await t.store.read("A")) as EventEnvelope[]), String(ts)).toBe(
        undefined
      );
      const keep = await t.sweep(11 * DAY, { dryRun: true });
      expect(keep.reclaimed, String(ts)).toEqual([]);
      expect(keep.refsAgedByEnd, String(ts)).toBe(0);
      const gone = await t.sweep(45 * DAY, { dryRun: true });
      expect(gone.reclaimed, String(ts)).toEqual([t.ref]);
    }
    // Same for an unstamped-kernel-free CONTINUED with a bad timestamp.
    expect(
      terminalEndOf([evt("A", 0, "EXECUTION_CONTINUED", {}, Number.NaN, { kernel: true })])
    ).toBeUndefined();
  });

  it("(o) a non-numeric CITATION timestamp behaves as it did before ADR 0146", async () => {
    // Old behaviour is whatever `now - NaN < olderThanMs` gives; the end clock must not change it.
    for (const cts of [Number.NaN, "2026-01-01"]) {
      const ended = await setup((ref) => [
        [
          evt("A", 0, "EXECUTION_STARTED", {}, 0),
          cite("A", 1, ref, cts as number),
          end("A", 2, "EXECUTION_COMPLETED", 20 * DAY),
        ],
      ]);
      const open = await setup((ref) => [
        [evt("A", 0, "EXECUTION_STARTED", {}, 0), cite("A", 1, ref, cts as number)],
      ]);
      // An open execution never consults the end: the pure old path.
      for (const now of [11 * DAY, 45 * DAY]) {
        const a = await ended.sweep(now, { dryRun: true });
        const b = await open.sweep(now, { dryRun: true });
        expect(a.reclaimed.length, `${String(cts)} @${now}`).toBe(b.reclaimed.length);
      }
    }
  });

  it("(m) fuzz: the end clock never reclaims a ref the citation clock keeps; exact new set vs an oracle (seeded)", async () => {
    const SEED = 0x146;
    const ITERATIONS = 300;
    let s = SEED;
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const KINDS = [
      "STEP_COMPLETED",
      "STEP_COMPLETED",
      "STEP_COMPLETED",
      "EXECUTION_COMPLETED",
      "EXECUTION_FAILED",
      "EXECUTION_CANCELLED",
      "EXECUTION_CONTINUED",
      "EXECUTION_RESUMED",
      "EXECUTION_SUSPENDED",
      "EXECUTION_STARTED",
    ];
    const BAD = [
      Number.NaN,
      "2026-01-01",
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      null,
    ];
    const BAD_FRACTION = 0.25;
    let sawHeld = 0;
    let sawEnded = 0;
    let sawBad = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const content = new InMemoryContentStore({ now: () => 1 });
      const refs: string[] = [];
      for (let r = 0; r < 5; r++)
        refs.push((await content.put(bytes(`blob-${i}-${r}`))).__loomContent);
      const stores = [new InMemoryAsyncEventStore(), new InMemoryAsyncEventStore()];
      // Independent oracle: per ref, the newest effective time, computed from the generated logs.
      const logs: EventEnvelope[][] = [];
      const rawMax = new Map<string, number>();
      const bare = new Set<string>();
      const executions = 1 + Math.floor(rnd() * 4);
      for (let x = 0; x < executions; x++) {
        const id = `E${x}`;
        const store = stores[x % 2] as InMemoryAsyncEventStore;
        const log: EventEnvelope[] = [];
        logs.push(log);
        const n = 1 + Math.floor(rnd() * 8);
        for (let q = 0; q < n; q++) {
          const kind = pick(KINDS);
          const at = Math.floor(rnd() * 60 * DAY); // random, non-monotone
          const ref = pick(refs);
          const isBare = rnd() < 0.1;
          const payload =
            kind === "STEP_COMPLETED" || rnd() < 0.3
              ? isBare
                ? { v: { __loomContent: ref } }
                : { output: envelopeFor(ref) }
              : {};
          const cites = Object.keys(payload).length > 0;
          if (cites) {
            rawMax.set(ref, Math.max(rawMax.get(ref) ?? -1, at));
            if (isBare) bare.add(ref);
          }
          const e = evt(
            id,
            q,
            kind,
            payload,
            at,
            kind === "EXECUTION_CONTINUED" && rnd() < 0.5 ? { kernel: true } : undefined
          );
          log.push(e);
          await store.append(e);
        }
        // Most executions end, so the end clock is exercised, not just the citation fallback.
        if (rnd() < 0.7) {
          const isBad = rnd() < BAD_FRACTION;
          if (isBad) sawBad++;
          const at = isBad ? (pick(BAD) as number) : Math.floor(rnd() * 60 * DAY);
          const e = evt(id, n, pick(["EXECUTION_COMPLETED", "EXECUTION_FAILED"]), {}, at);
          log.push(e);
          await store.append(e);
        }
      }
      const now = Math.floor(rnd() * 120 * DAY);
      const ttl = Math.floor(rnd() * 40 * DAY);
      const opts = {
        eventStores: stores,
        contentStore: content,
        pinnedEventTypes: [] as string[],
        olderThanMs: ttl,
        touchedBefore: now - ttl,
        now,
      };
      const oldReclaimed = new Set(
        [...rawMax].filter(([r, at]) => !bare.has(r) && now - at >= ttl).map(([r]) => r)
      );
      const dry = await sweepUnpinnedContent({ ...opts, dryRun: true });
      for (const r of dry.reclaimed) expect(oldReclaimed.has(r), `iteration ${i}`).toBe(true);
      const newSet = new Set(dry.reclaimed);
      const effMax = new Map<string, number>();
      for (const log of logs) {
        let endAt: number | undefined;
        for (let k = log.length - 1; k >= 0; k--) {
          const e = log[k] as EventEnvelope;
          if (
            ["EXECUTION_RESUMED", "EXECUTION_SUSPENDED", "EXECUTION_STARTED"].includes(e.eventType)
          )
            break;
          const terminal =
            ["EXECUTION_COMPLETED", "EXECUTION_FAILED", "EXECUTION_CANCELLED"].includes(
              e.eventType
            ) ||
            (e.eventType === "EXECUTION_CONTINUED" && e.metadata?.kernel === true);
          if (terminal) {
            if (typeof e.timestamp === "number" && Number.isFinite(e.timestamp))
              endAt = e.timestamp;
            break;
          }
        }
        for (const e of log) {
          const p = e.payload as { output?: { ref?: { __loomContent?: string } } };
          const r = p.output?.ref?.__loomContent;
          if (r === undefined) continue;
          const at = endAt !== undefined && endAt > e.timestamp ? endAt : e.timestamp;
          effMax.set(r, Math.max(effMax.get(r) ?? -1, at));
        }
      }
      const oracleNew = new Set(
        [...effMax].filter(([r, at]) => !bare.has(r) && now - at >= ttl).map(([r]) => r)
      );
      expect(newSet, `oracle iteration ${i}`).toEqual(oracleNew);
      expect(new Set(dry.heldByEndClock)).toEqual(
        new Set([...oldReclaimed].filter((r) => !newSet.has(r)))
      );
      sawHeld += dry.heldByEndClock?.length ?? 0;
      sawEnded += dry.refsAgedByEnd;
      const real = await sweepUnpinnedContent(opts);
      expect(new Set(real.reclaimed)).toEqual(newSet);
    }
    // The generator must actually exercise the rule, or the subset check is vacuous.
    expect(sawHeld).toBeGreaterThan(20);
    expect(sawEnded).toBeGreaterThan(20);
    expect(sawBad).toBeGreaterThan(50);
  });
});
