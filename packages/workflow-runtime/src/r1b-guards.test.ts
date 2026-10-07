import { describe, expect, it } from "vitest";
import {
  Latch,
  build,
  echo,
  eventsOf,
  flow,
  kinds,
  settle,
  slow,
  until,
} from "./__tests__/r2Harness";
import {
  ContinuationConflictError,
  ContinueAsNewRefusedError,
  ReservedSuccessorIdError,
} from "./continuation";

// ADR 0109 D1 — every precondition refuses with a TYPED error, BEFORE anything is frozen or
// appended: the log is untouched and the flow may catch the refusal and carry on. D2 (a)/(b) —
// the successor shape is reserved in caller-chosen ids, and an existing sequence 0 that is not
// this predecessor's successor is a typed conflict, never adopted.

const on = { continueAsNewEnabled: true, scopes: true } as const;

/** Run a one-shot flow whose body reports what `continueAsNew` threw. */
async function refusalOf(
  body: (ctx: Parameters<Parameters<typeof flow>[1]>[0]) => Promise<unknown>,
  deps: Parameters<typeof build>[0] = {},
  opts: Parameters<typeof build>[1] = {}
) {
  const h = build({ ...on, ...deps }, opts);
  const f = flow<unknown, unknown>("guard", async (ctx) => body(ctx));
  h.rt.registerFlow(f.definition, f.runner);
  const handle = await h.rt.start(f, {}, { executionId: "g" });
  await settle(handle);
  return { h, handle };
}

describe("ctx.continueAsNew — preconditions (log untouched, typed refusal)", () => {
  it("refuses inside an open ctx.parallel scope (a branch)", async () => {
    const { h, handle } = await refusalOf(async (ctx) => {
      const [r] = await ctx.parallel([
        async (b) => {
          try {
            await b.continueAsNew({});
          } catch (e) {
            return e instanceof ContinueAsNewRefusedError ? e.reason : String(e);
          }
        },
      ]);
      return r;
    });
    const out = (await handle.waitForCompletion()).variables._output as string;
    expect(out).toMatch(/ctx\.parallel scope is open/);
    expect(await kinds(h.eventStore, "g")).not.toContain("EXECUTION_CONTINUED");
    expect(await h.eventStore.read("g~1")).toEqual([]);
  });

  it("refuses with a parallel in flight on the root (a hand-rolled Promise.all)", async () => {
    const latch = new Latch();
    const { h, handle } = await refusalOf(
      async (ctx) => {
        const running = ctx.parallel([[slow, "x"]]);
        let refused: string | undefined;
        try {
          await ctx.continueAsNew({});
        } catch (e) {
          refused = e instanceof ContinueAsNewRefusedError ? e.reason : String(e);
        }
        latch.release();
        await running;
        return refused;
      },
      {},
      { latch }
    );
    const out = (await handle.waitForCompletion()).variables._output as string;
    expect(out).toMatch(/ctx\.parallel scope is open/);
    expect(await h.eventStore.read("g~1")).toEqual([]);
  });

  it("refuses with a receive / select wait outstanding (a parked wait is not a rotation point)", async () => {
    const { h, handle } = await refusalOf(async (ctx) => {
      const waiting = ctx.receive("never");
      waiting.catch(() => {});
      try {
        await ctx.continueAsNew({});
      } catch (e) {
        return e instanceof ContinueAsNewRefusedError ? e.reason : String(e);
      }
      return "rotated";
    });
    const out = (await handle.waitForCompletion()).variables._output as string;
    expect(out).toMatch(/wait is outstanding/);
    expect(await kinds(h.eventStore, "g")).not.toContain("EXECUTION_CONTINUED");
    expect(await h.eventStore.read("g~1")).toEqual([]);
  });

  it("waits for an in-flight step to settle: its event lands BEFORE EXECUTION_CONTINUED (r1b-fix1 pins the unbounded wait)", async () => {
    const latch = new Latch();
    const h = build(on, { latch });
    const f = flow<{ gen?: number }, unknown>("drain", async (ctx, input) => {
      if (input?.gen !== undefined) return "successor";
      void ctx.run(slow, "x").catch(() => {});
      return ctx.continueAsNew({ gen: 1 });
    });
    h.rt.registerFlow(f.definition, f.runner);
    await h.rt.start(f, {}, { executionId: "d" });
    await until(async () => (await kinds(h.eventStore, "d")).includes("STEP_STARTED"));
    expect(await kinds(h.eventStore, "d")).not.toContain("EXECUTION_CONTINUED"); // draining
    latch.release();
    await until(async () => (await kinds(h.eventStore, "d")).includes("EXECUTION_CONTINUED"));
    const all = await kinds(h.eventStore, "d");
    expect(all.indexOf("STEP_COMPLETED")).toBeGreaterThan(-1);
    expect(all.indexOf("STEP_COMPLETED")).toBeLessThan(all.indexOf("EXECUTION_CONTINUED"));
    expect(all[all.length - 1]).toBe("EXECUTION_CONTINUED"); // nothing follows the commit
  });

  it("a second call after an accepted one is the same rotation, and a swallowed sentinel still rotates", async () => {
    const h = build(on);
    const f = flow<{ n?: number }, unknown>("swallow", async (ctx, input) => {
      if (input?.n !== undefined) return "successor";
      try {
        await ctx.continueAsNew({ n: 1 });
      } catch {
        // the flow ignores the unwind and tries again: same rotation
      }
      try {
        await ctx.continueAsNew({ n: 2 });
      } catch {
        // swallowed too
      }
      return "ran on"; // must never become the output
    });
    h.rt.registerFlow(f.definition, f.runner);
    await h.rt.start(f, {}, { executionId: "s" });
    await until(async () => (await kinds(h.eventStore, "s")).includes("EXECUTION_CONTINUED"));
    expect(await eventsOf(h.eventStore, "s", "EXECUTION_COMPLETED")).toEqual([]);
    expect(await eventsOf(h.eventStore, "s", "EXECUTION_CONTINUED")).toHaveLength(1);
    const first = (await h.eventStore.read("s~1"))[0];
    expect((first?.payload as { input: unknown }).input).toEqual({ n: 1 });
  });

  it("refuses a carry with no JSON form", async () => {
    const { handle } = await refusalOf(async (ctx) => {
      const cyc: Record<string, unknown> = {};
      cyc.self = cyc;
      try {
        await ctx.continueAsNew(cyc);
      } catch (e) {
        return e instanceof ContinueAsNewRefusedError ? e.reason : String(e);
      }
    });
    expect((await handle.waitForCompletion()).variables._output).toMatch(/no JSON form/);
  });

  it("validates the carry as the successor's input when validateInput is on, before anything is appended", async () => {
    const h = build({ ...on, validateInput: true });
    const f = flow<unknown, unknown>("validated", async (ctx) => {
      try {
        await ctx.continueAsNew({ bad: true });
      } catch (e) {
        return (e as Error).name;
      }
    });
    // an input schema the carry fails
    (f.definition as unknown as { inputSchema: unknown }).inputSchema = {
      safeParse: (v: unknown) =>
        (v as { good?: boolean }).good === true
          ? { success: true, data: v }
          : { success: false, error: { issues: [{ path: ["good"], message: "required" }] } },
    };
    h.rt.registerFlow(f.definition, f.runner);
    const handle = await h.rt.start(f, { good: true }, { executionId: "v" });
    expect((await handle.waitForCompletion()).variables._output).toBe("InputValidationError");
    expect(await h.eventStore.read("v~1")).toEqual([]);
  });
});

describe("ADR 0109 D2 (a) — the successor shape is reserved in caller-chosen ids", () => {
  const trivial = flow<unknown, unknown>("trivial", async () => "done");

  async function startWith(id: string, h = build(on)) {
    h.rt.registerFlow(trivial.definition, trivial.runner);
    return { h, handle: await h.rt.start(trivial, {}, { executionId: id }) };
  }

  it.each(["foo~1", "foo~12", "foo~1::x", "a::b~1", "parent::g#0~3"])(
    "refuses start(%s) (bare, no parent log, or a derived chain's successor), appending nothing",
    async (id) => {
      const h = build(on);
      h.rt.registerFlow(trivial.definition, trivial.runner);
      await expect(h.rt.start(trivial, {}, { executionId: id })).rejects.toBeInstanceOf(
        ReservedSuccessorIdError
      );
      expect(await h.eventStore.read(id)).toEqual([]);
    }
  );

  it("accepts a ::-derived child of a successor-shaped root when the parent's log exists", async () => {
    const { h } = await startWith("plain");
    // `chain~1` can only exist through the kernel; here its LOG exists (as a continued parent's would)
    await h.eventStore.append({
      id: "chain~1-0",
      workflowId: "trivial",
      executionId: "chain~1",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { input: {} },
    });
    // only the supervisor (the lineage grant) may start the derived child of a generation
    const child = await h.rt.start(
      trivial,
      {},
      { executionId: "chain~1::g#0", ...h.rt.lineageOptions() }
    );
    await child.waitForCompletion();
    expect((await h.eventStore.read("chain~1::g#0")).length).toBeGreaterThan(0);
    // ...but not when that parent's log is absent
    await expect(
      h.rt.start(trivial, {}, { executionId: "chain~2::g#0", ...h.rt.lineageOptions() })
    ).rejects.toBeInstanceOf(ReservedSuccessorIdError);
    // ...and an ordinary caller is refused whether or not the parent exists
    await expect(h.rt.start(trivial, {}, { executionId: "chain~1::g#1" })).rejects.toBeInstanceOf(
      ReservedSuccessorIdError
    );
  });

  it.each(["a~b", "a~1x", "a::b~x", "~", "a~", "plain~", "x~y~z"])(
    "still accepts %s (the reservation is the SHAPE, not the character)",
    async (id) => {
      const { handle } = await startWith(id);
      await handle.waitForCompletion();
    }
  );

  it("refuses a fork child id with the successor shape", async () => {
    const { h, handle } = await startWith("src");
    await handle.waitForCompletion();
    await expect(h.rt.fork("src", 0, { executionId: "foo~3" })).rejects.toBeInstanceOf(
      ReservedSuccessorIdError
    );
    expect(await h.eventStore.read("foo~3")).toEqual([]);
  });

  it("no RunOptions field forges a successor: an unknown option cannot change the refusal", async () => {
    const h = build(on);
    h.rt.registerFlow(trivial.definition, trivial.runner);
    await expect(
      h.rt.start(trivial, {}, {
        executionId: "forged~1",
        continuedFrom: { executionId: "x" },
        chainId: "forged",
        generation: 1,
      } as never)
    ).rejects.toBeInstanceOf(ReservedSuccessorIdError);
  });
});

describe("ADR 0109 D2 (b) — an existing sequence 0 that is not this predecessor's successor", () => {
  const rotator = flow<unknown, unknown>("rot", async (ctx) => ctx.continueAsNew({ x: 1 }));

  const seq0 = (id: string, continuedFrom?: string) => ({
    id: `${id}-0`,
    workflowId: "rot",
    executionId: id,
    eventType: "EXECUTION_STARTED",
    sequence: 0,
    timestamp: 1,
    payload: {
      input: {},
      ...(continuedFrom !== undefined && {
        chainId: "p",
        generation: 1,
        continuedFrom: { executionId: continuedFrom },
      }),
    },
  });

  it("a squatter at <chain>~1 is a typed ContinuationConflictError: the predecessor FAILS, no EXECUTION_CONTINUED", async () => {
    const h = build(on);
    h.rt.registerFlow(rotator.definition, rotator.runner);
    await h.eventStore.append(seq0("p~1")); // planted: no continuedFrom at all
    const handle = await h.rt.start(rotator, {}, { executionId: "p" });
    await expect(handle.waitForCompletion()).rejects.toBeInstanceOf(ContinuationConflictError);
    const all = await kinds(h.eventStore, "p");
    expect(all).toContain("EXECUTION_FAILED");
    expect(all).not.toContain("EXECUTION_CONTINUED");
    // the squatter's log is untouched
    expect((await h.eventStore.read("p~1")).length).toBe(1);
  });

  it("a successor naming ANOTHER execution is refused the same way", async () => {
    const h = build(on);
    h.rt.registerFlow(rotator.definition, rotator.runner);
    await h.eventStore.append(seq0("p~1", "someone-else"));
    const handle = await h.rt.start(rotator, {}, { executionId: "p" });
    const err = await handle.waitForCompletion().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContinuationConflictError);
    expect((err as ContinuationConflictError).foundContinuedFrom).toBe("someone-else");
  });

  it("an existing successor that DOES name this predecessor is adopted: no second start, the commit lands", async () => {
    const h = build(on);
    h.rt.registerFlow(rotator.definition, rotator.runner);
    await h.eventStore.append(seq0("p~1", "p")); // a crash left the successor started
    const handle = await h.rt.start(rotator, {}, { executionId: "p" });
    await handle.waitForCompletion();
    expect(await kinds(h.eventStore, "p")).toContain("EXECUTION_CONTINUED");
    expect((await h.eventStore.read("p~1")).length).toBe(1); // untouched: nothing re-started it
  });
});
