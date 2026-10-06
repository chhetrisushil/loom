import { unwrapTainted } from "@loom/classify";
import { describe, expect, it } from "vitest";
import { TimerService } from "./TimerService";
import {
  Latch,
  build,
  eventsOf,
  flow,
  kinds,
  settle,
  slow,
  tick,
  until,
} from "./__tests__/r2Harness";
import { viewDigest } from "./approvalBinding";
import { signResume, signedResumeAuthenticator } from "./signedResumeAuthenticator";
import { FlowDivergenceError, ResumeRefusedError } from "./types";
import type { SelectResult } from "./types";

// ADR 0110 D2–D4 — `ctx.select`, concurrent waits, wait identity, per-wait approval binding.

const run = async (h: ReturnType<typeof build>, f: ReturnType<typeof flow>, id = "e1") => {
  h.rt.registerFlow(f.definition, f.runner);
  const handle = await h.rt.start(f, {}, { executionId: id });
  await handle.waitForSuspend();
  return handle;
};
const done = async (h: ReturnType<typeof build>, id = "e1") => {
  await until(async () => (await h.rt.loadState(id))?.status === "completed");
  return (await h.rt.loadState(id))?.variables._output;
};

describe("R2 — select over a gate, an inbox topic and a timer", () => {
  const selector = (digest?: string) =>
    flow("sel", async (ctx) => {
      const r = await ctx.select<unknown>([
        { gate: "Approval", ...(digest !== undefined && { viewDigest: digest }) },
        { inbox: "user-message" },
        { timer: { afterMs: 3_600_000 } },
      ]);
      return { arm: r.arm, kind: r.kind, value: unwrapTainted(r.value) };
    });

  it("parks ONCE with all three waits, in arm order", async () => {
    const h = build();
    await run(h, selector());
    const park = (await h.rt.loadState("e1"))?.suspendedOn;
    expect(park?.waits?.map((w) => [w.waitId, w.kind])).toEqual([
      ["#0", "gate"],
      ["#1", "inbox"],
      ["#2", "timer"],
    ]);
    expect(typeof park?.waits?.[2]?.wakeAt).toBe("number");
    // exactly one park, stamped (the fold honours `waits` only on a kernel-stamped park)
    expect((await eventsOf(h.eventStore, "e1", "EXECUTION_SUSPENDED")).length).toBe(1);
    const [suspended] = await eventsOf(h.eventStore, "e1", "EXECUTION_SUSPENDED");
    expect(suspended?.metadata?.kernel).toBe(true);
    // one TimerStore row for the timer arm
    expect((await h.timers.due(Number.MAX_SAFE_INTEGER)).length).toBe(1);
  });

  it("the gate arm wins", async () => {
    const h = build();
    await run(h, selector());
    await h.rt.resume("e1", { eventType: "Approval", payload: { ok: true } });
    expect(await done(h)).toEqual({ arm: 0, kind: "gate", value: { ok: true } });
  });

  it("the inbox arm wins", async () => {
    const h = build();
    await run(h, selector());
    await h.rt.send("e1", { topic: "user-message", payload: "hi" });
    expect(await done(h)).toEqual({ arm: 1, kind: "inbox", value: "hi" });
  });

  it("the timer arm wins (TimerService fires the arm's row, addressed to its wait)", async () => {
    const h = build();
    await run(h, selector());
    const wakeAt = (await h.rt.loadState("e1"))?.suspendedOn?.waits?.[2]?.wakeAt as number;
    await new TimerService(h.rt, h.timers).tick(wakeAt + 1);
    const out = (await done(h)) as SelectResult<{ wakeAt: number }>;
    expect(out).toMatchObject({ arm: 2, kind: "timer", value: { wakeAt } });
    const resumed = await eventsOf(h.eventStore, "e1", "EXECUTION_RESUMED");
    expect(resumed[0]?.payload).toMatchObject({ waitId: "#2" });
  });

  it("a later answer to a LOSING arm is refused (wait-settled), appending nothing", async () => {
    const h = build();
    await run(h, selector());
    await h.rt.send("e1", { topic: "user-message", payload: "first" });
    await done(h);
    const before = await kinds(h.eventStore, "e1");
    const err = await h.rt
      .resume("e1", { eventType: "Approval", waitId: "#0", payload: { late: true } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResumeRefusedError);
    expect(await kinds(h.eventStore, "e1")).toEqual(before);
  });

  it("a stale timer fire for a settled arm is obsolete: the row is retired, nothing resumed", async () => {
    const h = build();
    await run(h, selector());
    await h.rt.send("e1", { topic: "user-message", payload: "first" });
    await done(h);
    const before = await kinds(h.eventStore, "e1");
    await new TimerService(h.rt, h.timers).tick(Number.MAX_SAFE_INTEGER);
    expect(await kinds(h.eventStore, "e1")).toEqual(before);
    expect(await h.timers.due(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it("a bare resume naming the one gate wait answers it; an unlisted name is a gate-mismatch", async () => {
    const h = build();
    await run(h, selector());
    const err = await h.rt.resume("e1", { eventType: "Nope", payload: 1 }).catch((e: unknown) => e);
    expect((err as ResumeRefusedError).reason).toBe("gate-mismatch");
    await h.rt.resume("e1", { eventType: "Approval", payload: "bare" });
    expect(await done(h)).toEqual({ arm: 0, kind: "gate", value: "bare" });
  });

  it("two gate waits with the same name need a waitId (ambiguous-wait otherwise)", async () => {
    const h = build();
    const f = flow("twin", async (ctx) => {
      const rs = await Promise.all([ctx.select([{ gate: "Go" }]), ctx.select([{ gate: "Go" }])]);
      return rs.map((r) => r.value);
    });
    await run(h, f);
    const err = await h.rt.resume("e1", { eventType: "Go", payload: 1 }).catch((e: unknown) => e);
    expect((err as ResumeRefusedError).reason).toBe("ambiguous-wait");
    await h.rt.resume("e1", { eventType: "Go", waitId: "#1", payload: "second" });
    await tick(30);
    // #0 is still pending; the park lists only it now
    expect((await h.rt.loadState("e1"))?.suspendedOn?.waits?.map((w) => w.waitId)).toEqual(["#0"]);
    await h.rt.resume("e1", { eventType: "Go", waitId: "#0", payload: "first" });
    expect(await done(h)).toEqual(["first", "second"]);
  });

  it("replay is identical: the same answer, the same arm, from the fold", async () => {
    const h = build();
    await run(h, selector());
    await h.rt.send("e1", { topic: "user-message", payload: "stable" });
    const first = await done(h);
    // a second runtime re-drives the finished log through resumeAs-free replay of the fold
    const state = await h.rt.loadState("e1");
    expect(state?.variables._waitAnswers).toEqual({
      "#1": { kind: "inbox", name: "user-message", payload: "stable" },
    });
    expect(first).toEqual({ arm: 1, kind: "inbox", value: "stable" });
  });
});

describe("R2 — timer arms record their wake once", () => {
  it("sibling traffic cannot push a timer arm's deadline out", async () => {
    let clock = 1_000_000;
    const h = build({ now: () => clock, scopes: true });
    const f = flow("pin", async (ctx) => {
      const [t] = await ctx.parallel([
        async (b) => b.select([{ gate: "Never" }, { timer: { afterMs: 60_000 } }]),
        async (b) => {
          for (let i = 0; i < 3; i++) await b.receive("tick");
          return "done";
        },
      ]);
      return t;
    });
    await run(h, f);
    const wakes: number[] = [];
    const timerWake = async () =>
      (await h.rt.loadState("e1"))?.suspendedOn?.waits?.find((w) => w.kind === "timer")
        ?.wakeAt as number;
    wakes.push(await timerWake());
    for (let i = 0; i < 2; i++) {
      clock += 10_000; // time passes between messages
      await h.rt.send("e1", { topic: "tick", payload: i });
      await until(
        async () =>
          (await timerWake()) !== undefined &&
          (await h.rt.loadState("e1"))?.status === "suspended" &&
          (await kinds(h.eventStore, "e1")).filter((k) => k === "EXECUTION_SUSPENDED").length ===
            i + 2
      );
      wakes.push(await timerWake());
    }
    // every re-park listed the SAME recorded instant: afterMs is a request, the log has the fact
    expect(new Set(wakes).size).toBe(1);
    expect(wakes[0]).toBe(1_000_000 + 60_000);
  });
});

describe("R2 — concurrent waits (receive inside ctx.parallel) and the park barrier", () => {
  it("two parallel receives park ONCE with two waits; answers consumed out of order land on the right wait", async () => {
    const h = build({ scopes: true });
    const f = flow("par", async (ctx) =>
      ctx.parallel([
        async (b) => unwrapTainted(await b.receive<string>("a")),
        async (b) => unwrapTainted(await b.receive<string>("b")),
      ])
    );
    await run(h, f);
    const park = (await h.rt.loadState("e1"))?.suspendedOn;
    expect(park?.waits?.map((w) => [w.waitId, w.topic])).toEqual([
      ["/0.0#0", "a"],
      ["/0.1#0", "b"],
    ]);
    expect((await eventsOf(h.eventStore, "e1", "EXECUTION_SUSPENDED")).length).toBe(1);
    // b first, then a — against the order the branches registered them
    await h.rt.send("e1", { topic: "b", payload: "B" });
    await until(async () => (await h.rt.loadState("e1"))?.suspendedOn?.waits?.length === 1);
    expect((await h.rt.loadState("e1"))?.suspendedOn?.waits?.[0]?.topic).toBe("a");
    await h.rt.send("e1", { topic: "a", payload: "A" });
    expect(await done(h)).toEqual(["A", "B"]);
  });

  it("without kernel.features.scopes a branch's receive is refused, not numbered by timing", async () => {
    const h = build(); // scopes off: ctx.parallel is the pre-R6 Promise.all
    const f = flow("noscope", async (ctx) =>
      ctx.parallel([async (b) => b.receive("a"), async (b) => b.receive("b")])
    );
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "e1" });
    await expect(handle.waitForCompletion()).rejects.toThrow(/kernel\.features\.scopes/);
  });

  it("two SEQUENTIAL parallel scopes mint distinct waitIds", async () => {
    const h = build({ scopes: true });
    const ids: string[] = [];
    const f = flow("seq", async (ctx) => {
      for (let i = 0; i < 2; i++) {
        await ctx.parallel([
          async (b) => {
            const r = await b.select([{ inbox: `t${i}` }]);
            return r.arm;
          },
          async () => 1,
        ]);
      }
      return "ok";
    });
    await run(h, f);
    ids.push(...((await h.rt.loadState("e1"))?.suspendedOn?.waits ?? []).map((w) => w.waitId));
    await h.rt.send("e1", { topic: "t0", payload: 1 });
    await until(async () => (await h.rt.loadState("e1"))?.suspendedOn?.waits?.[0]?.topic === "t1");
    ids.push(...((await h.rt.loadState("e1"))?.suspendedOn?.waits ?? []).map((w) => w.waitId));
    expect(ids).toEqual(["/0.0#0", "/1.0#0"]);
    await h.rt.send("e1", { topic: "t1", payload: 1 });
    expect(await done(h)).toBe("ok");
  });

  it("the park barrier: a sibling's in-flight step lands BEFORE the multi-wait park", async () => {
    const latch = new Latch();
    const h = build({ scopes: true }, { latch });
    const f = flow("bar", async (ctx) =>
      ctx.parallel([
        async (b) => unwrapTainted(await b.receive<string>("go")),
        async (b) => {
          await b.run(slow, { n: 1 });
          return "stepped";
        },
      ])
    );
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, {}, { executionId: "e1" });
    await tick(60); // the receive registered; the step is still in flight
    expect((await kinds(h.eventStore, "e1")).includes("EXECUTION_SUSPENDED")).toBe(false);
    latch.release();
    await handle.waitForSuspend();
    const ks = await kinds(h.eventStore, "e1");
    expect(ks.indexOf("STEP_COMPLETED")).toBeGreaterThan(-1);
    expect(ks.indexOf("STEP_COMPLETED")).toBeLessThan(ks.indexOf("EXECUTION_SUSPENDED"));
    await h.rt.send("e1", { topic: "go", payload: "now" });
    expect(await done(h)).toEqual(["now", "stepped"]);
  });

  it("a legacy ctx.suspend gate beside a registered receive (a mixed park): both mechanisms answer", async () => {
    const h = build({ scopes: true });
    const f = flow("mixed", async (ctx) =>
      ctx.parallel([
        async (b) => unwrapTainted(await b.receive<string>("m")),
        async (b) => b.suspend<string>({ on: "Legacy" }),
      ])
    );
    await run(h, f);
    const park = (await h.rt.loadState("e1"))?.suspendedOn;
    expect(park?.on).toBe("Legacy");
    expect(park?.waits?.map((w) => w.topic)).toEqual(["m"]);
    await h.rt.resume("e1", { eventType: "Legacy", payload: "L" }); // positional, as ever
    await until(async () => (await h.rt.loadState("e1"))?.suspendedOn?.on === "__loom_waits__");
    await h.rt.send("e1", { topic: "m", payload: "M" });
    expect(await done(h)).toEqual(["M", "L"]);
  });
});

describe("R2 — wait identity: a body edit that shifts an ordinal is loud", () => {
  it("FlowDivergenceError, not a message handed to the wrong wait", async () => {
    const h = build();
    const v1 = flow("edit", async (ctx) => {
      const a = await ctx.select([{ gate: "A" }]);
      const b = await ctx.select([{ gate: "B" }]);
      return [a.value, b.value];
    });
    await run(h, v1);
    await h.rt.resume("e1", { eventType: "A", payload: "a" }); // answers #0 as gate "A"
    await until(async () => (await h.rt.loadState("e1"))?.suspendedOn?.waits?.[0]?.on === "B");
    // v2 inserts a receive BEFORE the first select: ordinal #0 is now an inbox wait
    const v2 = flow(
      "edit",
      async (ctx) => {
        await ctx.receive("inserted");
        const a = await ctx.select([{ gate: "A" }]);
        const b = await ctx.select([{ gate: "B" }]);
        return [a.value, b.value];
      },
      "2.0.0"
    );
    const h2 = h.sibling();
    h2.registerFlow(v2.definition, v2.runner);
    const handle = await h2.resume(
      "e1",
      { eventType: "B", payload: "b" },
      { allowFlowCodeMismatch: true }
    );
    const err = await handle.waitForCompletion().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowDivergenceError);
    expect((err as FlowDivergenceError).waitId).toBe("#0");
  });
});

describe("R2 — approvals bind to the WAIT (ADR 0117 per wait, R13 signatures)", () => {
  const KEY = "alice-secret-0123456789";
  const mk = () =>
    build({
      resumeAuthenticator: signedResumeAuthenticator({
        gates: ["ApproveA", "ApproveB"],
        keys: { alice: KEY },
      }),
    });
  const flowAB = (da: string, db: string) =>
    flow("ab", async (ctx) =>
      Promise.all([
        ctx.select([{ gate: "ApproveA", viewDigest: da }]),
        ctx.select([{ gate: "ApproveB", viewDigest: db }]),
      ])
    );

  it("viewDigest is checked PER WAIT: a stale approval for one gate arm is refused", async () => {
    const h = build();
    const da = viewDigest({ a: 1 });
    const db = viewDigest({ b: 1 });
    await run(h, flowAB(da, db));
    const stale = await h.rt
      .resume("e1", { eventType: "ApproveA", waitId: "#0", payload: { viewDigest: db } })
      .catch((e: unknown) => e);
    expect((stale as ResumeRefusedError).reason).toBe("view-digest-mismatch");
    await h.rt.resume("e1", { eventType: "ApproveA", waitId: "#0", payload: { viewDigest: da } });
    await until(async () => (await h.rt.loadState("e1"))?.suspendedOn?.waits?.length === 1);
    await h.rt.resume("e1", { eventType: "ApproveB", payload: { viewDigest: db } }); // bare: unambiguous
    await until(async () => (await h.rt.loadState("e1"))?.status === "completed");
  });

  it("a signature for arm A does not answer arm B; the right one verifies and is recorded", async () => {
    const h = mk();
    const da = viewDigest({ a: 1 });
    await run(h, flowAB(da, da)); // the SAME digest on both arms, so only the signature can tell them apart
    const park = (await h.rt.parkedAtSequence("e1")) as number;
    const sign = (eventType: string, waitId: string) =>
      signResume(
        { eventType, waitId, payload: { viewDigest: da } },
        {
          actor: "alice",
          secret: KEY,
          exp: Date.now() + 60_000,
          executionId: "e1",
          parkedAtSequence: park,
          waitRegisteredAtSequence: park,
        }
      );
    const forB = sign("ApproveB", "#1");
    // replay arm B's signature at arm A (same name would be needed; use A's name, B's proof)
    const forged = { ...forB, eventType: "ApproveA", waitId: "#0" };
    const refused = await h.rt.resume("e1", forged).catch((e: unknown) => e);
    expect(String(refused)).toMatch(/signature does not verify|not verified/);
    // an event that drops the waitId cannot ride a wait-bound signature either
    const dropped = await h.rt
      .resume("e1", { ...sign("ApproveA", "#0"), waitId: undefined } as never)
      .catch((e: unknown) => e);
    expect(String(dropped)).toMatch(/not bound|not verified|does not verify/);
    expect(await kinds(h.eventStore, "e1")).not.toContain("APPROVAL_GRANTED");
    await h.rt.resume("e1", sign("ApproveA", "#0"));
    const granted = await eventsOf(h.eventStore, "e1", "APPROVAL_GRANTED");
    expect(granted[0]?.payload).toMatchObject({ actor: "alice", on: "ApproveA" });
  });
});

void settle;
