import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { Latch, build, flow, kinds, settle, slow, tick, until } from "./__tests__/r2Harness";
import type { Harness } from "./__tests__/r2Harness";
import { ChainHopLimitError, ReservedSuccessorIdError } from "./continuation";
import { executionAccessPolicy } from "./executionAccessPolicy";

// R1b fix round 1 (ADR 0109): the reviewer's reproductions, each failing before its fix.

const on = { continueAsNewEnabled: true } as const;
const secure = {
  ...on,
  executionAuthorizer: executionAccessPolicy(),
  executionAuthz: { requirePrincipal: true },
} as const;
const alice = { actor: "alice", tenant: "t1" };
const mallory = { actor: "mallory", tenant: "t2" };

const status = async (h: Harness, id: string) =>
  (await h.rt.loadState(id, h.rt.systemOptions()))?.status;
const parked = (h: Harness, id: string) => until(async () => (await status(h, id)) === "suspended");
const principalOf = async (h: Harness, id: string) =>
  ((await h.eventStore.read(id))[0]?.payload as { principal?: unknown } | undefined)?.principal;

/** A flow that parks, unless its input says `go`, when it rotates. */
const rotator = () =>
  flow<{ go?: boolean }, unknown>("rot", async (ctx, input) => {
    if (input?.go === true) return ctx.continueAsNew({ from: "forged-input" });
    await ctx.suspend({ on: "hold" });
    return "done";
  });

describe("P1 - restoreFromState cannot forge a successor's identity", () => {
  async function setup() {
    const h = build(secure);
    const f = rotator();
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "m", principal: mallory }));
    await settle(await h.rt.start(f, {}, { executionId: "victim", principal: alice }));
    const state = (await h.rt.loadState("m", { principal: mallory }))!;
    return { h, f, state };
  }

  it("a forged _principal + _chain + _input restores onto m: nothing is created at victim~1 and m~1 is mallory's", async () => {
    const { h, state } = await setup();
    const alicePrincipal = await principalOf(h, "victim");
    const forged = {
      ...state,
      variables: {
        ...state.variables,
        _principal: alicePrincipal,
        _chain: { chainId: "victim", generation: 0 },
        _input: { go: true },
      },
    };
    const handle = await h.rt.restoreFromState(forged as never, undefined, { principal: mallory });
    await handle.waitForCompletion().catch(() => undefined);
    await until(async () => (await kinds(h.eventStore, "m")).includes("EXECUTION_CONTINUED"));
    expect(await h.eventStore.read("victim~1")).toEqual([]);
    const succ = await h.eventStore.read("m~1");
    expect(succ.length).toBeGreaterThan(0);
    expect((succ[0]?.payload as { principal: unknown }).principal).toEqual(
      await principalOf(h, "m")
    );
    expect((succ[0]?.payload as { chainId: string }).chainId).toBe("m");
    expect(await status(h, "victim")).toBe("suspended");
  });

  it("forging only _principal still cannot hand the successor to alice", async () => {
    const { h, state } = await setup();
    const alicePrincipal = await principalOf(h, "victim");
    const forged = {
      ...state,
      variables: { ...state.variables, _principal: alicePrincipal, _input: { go: true } },
    };
    const handle = await h.rt.restoreFromState(forged as never, undefined, { principal: mallory });
    await handle.waitForCompletion().catch(() => undefined);
    await until(async () => (await h.eventStore.read("m~1")).length > 0);
    expect(
      ((await h.eventStore.read("m~1"))[0]?.payload as { principal: unknown }).principal
    ).toEqual(await principalOf(h, "m"));
  });

  it("the restored execution's folded identity is the LOG's, whatever the supplied state claims", async () => {
    const { h, state } = await setup();
    const alicePrincipal = await principalOf(h, "victim");
    const forged = {
      ...state,
      variables: {
        ...state.variables,
        _principal: alicePrincipal,
        _chain: { chainId: "victim", generation: 0 },
        _parent: "victim",
        _continuedTo: "victim",
      },
    };
    const handle = await h.rt.restoreFromState(forged as never, undefined, { principal: mallory });
    const vars = handle.getState().variables;
    expect(vars._principal).toEqual(await principalOf(h, "m"));
    expect(vars._chain).toBeUndefined(); // a plain start stamps no chain: never the forged "victim"
    expect(vars._parent).toBeUndefined();
    expect(vars._continuedTo).toBeUndefined();
  });

  it("defence in depth: a continued log pointing at a foreign id is not followed (cancel does not cascade, followToHead stops)", async () => {
    const h = build(secure);
    const f = rotator();
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "m", principal: mallory }));
    await settle(await h.rt.start(f, {}, { executionId: "victim", principal: alice }));
    // a forged (or corrupted) continuation: m's log says it continued into alice's execution
    const tip = (await h.eventStore.read("m")).length;
    await h.eventStore.append({
      id: `m-${tip}`,
      workflowId: "rot",
      executionId: "m",
      eventType: "EXECUTION_CONTINUED",
      sequence: tip,
      timestamp: 99,
      payload: { successorId: "victim", chainId: "m", generation: 1 },
      metadata: { kernel: true },
    });
    expect((await h.rt.loadState("m", { principal: mallory }))?.status).toBe("continued");
    const head = await h.rt.followToHead("m", { principal: mallory });
    expect(head?.executionId).toBe("m"); // the unverified hop is not followed
    await h.rt.cancel("m", "x", { principal: mallory }).catch(() => undefined);
    expect(await status(h, "victim")).toBe("suspended"); // never cancelled
  });
});

describe("P2-1 - successor ids of ::-derived chains are reserved too", () => {
  const trivial = flow<unknown, unknown>("trivial", async () => "done");

  it("refuses start / fork ids ending in ~<digits> on the last :: segment, appending nothing", async () => {
    const h = build(on);
    h.rt.registerFlow(trivial.definition, trivial.runner);
    for (const id of ["parent::g#0~1", "a::b~1", "a::b::c#1~7"]) {
      await expect(h.rt.start(trivial, {}, { executionId: id })).rejects.toBeInstanceOf(
        ReservedSuccessorIdError
      );
      expect(await h.eventStore.read(id)).toEqual([]);
    }
    const src = await h.rt.start(trivial, {}, { executionId: "src" });
    await src.waitForCompletion();
    await expect(h.rt.fork("src", 0, { executionId: "parent::g#0~2" })).rejects.toBeInstanceOf(
      ReservedSuccessorIdError
    );
    // a non-final segment of that shape is not the successor of anything
    const ok = await h.rt.start(trivial, {}, { executionId: "a::b~x::c" });
    await ok.waitForCompletion();
  });

  it("a derived chain rotates (the kernel creates parent::g#0~1) and the squat cannot pre-empt it", async () => {
    const h = build(on);
    const f = flow<{ n?: number }, unknown>("derived", async (ctx, input) =>
      input?.n === undefined ? ctx.continueAsNew({ n: 1 }) : "gen1"
    );
    h.rt.registerFlow(f.definition, f.runner);
    await expect(h.rt.start(f, {}, { executionId: "parent::g#0~1" })).rejects.toBeInstanceOf(
      ReservedSuccessorIdError
    );
    const handle = await h.rt.start(f, {}, { executionId: "parent::g#0" });
    await settle(handle);
    await until(async () => (await status(h, "parent::g#0~1")) === "completed");
    expect(await kinds(h.eventStore, "parent::g#0")).toContain("EXECUTION_CONTINUED");
  });
});

describe("P2-2 - system followers are not bounded by maxChainHops", () => {
  const hop = () =>
    flow<{ n?: number }, unknown>("hop12", async (ctx, input) => {
      const n = input?.n ?? 0;
      if (n >= 12) {
        await ctx.suspend({ on: "end" });
        return "end";
      }
      return ctx.continueAsNew({ n: n + 1 });
    });

  it("followToHead({unbounded}) reaches a head 12 generations away; the client walk is still bounded", async () => {
    const h = build({ ...on, maxChainHops: 8 });
    const f = hop();
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "c" }));
    await until(async () => (await status(h, "c~12")) === "suspended");
    await expect(h.rt.followToHead("c")).rejects.toBeInstanceOf(ChainHopLimitError);
    const head = await h.rt.followToHead("c", { unbounded: true });
    expect(head?.executionId).toBe("c~12");
    expect(head?.hops).toBe(12);
    // an unbounded cancel reaches the head too
    expect(await h.rt.cancel("c", "stop", { unbounded: true })).toBe(true);
    expect(await status(h, "c~12")).toBe("cancelled");
  });
});

describe("P2-3 - continueAsNew never raises a timing-dependent refusal", () => {
  const drain = () =>
    flow<{ c?: string }, unknown>("drain", async (ctx, input) => {
      if (input?.c !== undefined) return `succ:${input.c}`;
      const p = ctx.run(slow, "x");
      try {
        await ctx.continueAsNew({ c: "early" });
      } catch {
        /* a refusal would be swallowed here */
      }
      await p;
      await ctx.suspend({ on: "go" });
      return ctx.continueAsNew({ c: "late" });
    });

  it("waits for every in-flight step to settle (unbounded) and rotates with the value the original run decides", async () => {
    const latch = new Latch();
    const h = build({ ...on, parkDrainMs: 40 }, { latch });
    const f = drain();
    h.rt.registerFlow(f.definition, f.runner);
    await h.rt.start(f, {}, { executionId: "g" });
    await tick(150); // well past parkDrainMs while the step is still in flight
    expect(await kinds(h.eventStore, "g")).not.toContain("EXECUTION_CONTINUED"); // waiting, not refused
    latch.release();
    await until(async () => (await kinds(h.eventStore, "g")).includes("EXECUTION_CONTINUED"));
    const all = await kinds(h.eventStore, "g");
    expect(all).not.toContain("EXECUTION_SUSPENDED"); // the early call was accepted, never refused
    expect(all.indexOf("STEP_COMPLETED")).toBeLessThan(all.indexOf("EXECUTION_CONTINUED"));
    const seed = (await h.eventStore.read("g~1"))[0]?.payload as { input: unknown };
    expect(seed.input).toEqual({ c: "early" });
  });
});

describe("P3-1 - a squatted <chain>~n captures no traffic", () => {
  const planted = (id: string) => ({
    id: `${id}-0`,
    workflowId: "sq",
    executionId: id,
    eventType: "EXECUTION_STARTED",
    sequence: 0,
    timestamp: 1,
    payload: { input: {} },
  });
  const sq = flow<unknown, unknown>("sq", async (ctx) => {
    await ctx.receive("go");
    return "done";
  });

  it("send addressed to a RUNNING p is not routed to a planted p~1 (the start-to-commit probe)", async () => {
    const latch = new Latch();
    const h = build(on, { latch });
    const busy = flow<unknown, unknown>("busy", async (ctx) => {
      await ctx.run(slow, "x"); // in flight: p reads `running`, so send takes the probe path
      await ctx.receive("go");
      return "done";
    });
    h.rt.registerFlow(busy.definition, busy.runner);
    await h.rt.start(busy, {}, { executionId: "p" });
    await until(async () => (await kinds(h.eventStore, "p")).includes("STEP_STARTED"));
    await h.eventStore.append(planted("p~1")); // a raw store write: P2-1 closes the API path
    const sent = await h.rt.send("p", { topic: "go", payload: 1, messageId: "m1" });
    expect(sent.executionId).toBe("p"); // not the squatter
    latch.release();
    await until(async () => (await status(h, "p")) === "completed");
    expect((await h.eventStore.read("p~1")).length).toBe(1);
  });

  it("cancel and followToHead addressed to q do not reach a planted q~1", async () => {
    const h = build(on);
    h.rt.registerFlow(sq.definition, sq.runner);
    await settle(await h.rt.start(sq, {}, { executionId: "q" }));
    await parked(h, "q");
    await h.eventStore.append(planted("q~1"));
    expect((await h.rt.followToHead("q"))?.executionId).toBe("q");
    expect(await h.rt.cancel("q", "x")).toBe(true);
    expect((await h.eventStore.read("q~1")).length).toBe(1);
  });
});

describe("P3-2 - start of a successor-shaped id is no existence oracle", () => {
  it("an unauthorized caller gets the same refusal whether or not the parent log exists", async () => {
    const h = build(secure);
    const f = rotator();
    h.rt.registerFlow(f.definition, f.runner);
    const triv = flow<unknown, unknown>("trivial", async () => "done");
    h.rt.registerFlow(triv.definition, triv.runner);
    await settle(await h.rt.start(f, {}, { executionId: "secret", principal: alice }));
    await h.eventStore.append({
      id: "secret~1-0",
      workflowId: "rot",
      executionId: "secret~1",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { input: {} },
    });
    const refusal = async (id: string) =>
      h.rt
        .start(triv, {}, { executionId: id, principal: mallory })
        .then(() => "started")
        .catch((e: unknown) => (e as Error).constructor.name);
    expect(await refusal("secret~1::x")).toBe("ReservedSuccessorIdError"); // parent exists
    expect(await refusal("secret~2::x")).toBe("ReservedSuccessorIdError"); // parent absent
    expect(await h.eventStore.read("secret~1::x")).toEqual([]);
  });

  it("the supervisor (lineage grant) still starts a ::-child of an existing generation", async () => {
    const h = build(on);
    const triv = flow<unknown, unknown>("trivial", async () => "done");
    h.rt.registerFlow(triv.definition, triv.runner);
    await h.eventStore.append({
      id: "chain~1-0",
      workflowId: "trivial",
      executionId: "chain~1",
      eventType: "EXECUTION_STARTED",
      sequence: 0,
      timestamp: 1,
      payload: { input: {} },
    });
    const child = await h.rt.start(
      triv,
      {},
      { executionId: "chain~1::g#0", ...h.rt.lineageOptions() }
    );
    await child.waitForCompletion();
    await expect(
      h.rt.start(triv, {}, { executionId: "chain~9::g#0", ...h.rt.lineageOptions() })
    ).rejects.toBeInstanceOf(ReservedSuccessorIdError);
  });
});

describe("P3-3 - send authorizes before it walks the chain", () => {
  it("an unauthorized send reads only the addressed id's log", async () => {
    const touched = new Set<string>();
    const inner = new InMemoryAsyncEventStore();
    const view = new Proxy(inner, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          if (typeof args[0] === "string") touched.add(args[0]);
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as EventStore;
    const h = build({ ...secure, maxChainHops: 2 }, { eventStore: view });
    const f = flow<{ n?: number }, unknown>("hopper", async (ctx, input) => {
      const n = input?.n ?? 0;
      await ctx.receive("go");
      return ctx.continueAsNew({ n: n + 1 });
    });
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "c", principal: alice }));
    let head = "c";
    for (let i = 0; i < 4; i++) {
      await parked(h, head);
      await h.rt.send(head, { topic: "go", payload: i, messageId: `g${i}` }, { principal: alice });
      head = `c~${i + 1}`;
      await until(async () => (await status(h, head)) !== undefined);
    }
    await parked(h, head);
    touched.clear();
    const err = await h.rt
      .send("c", { topic: "go", payload: "x" }, { principal: mallory })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ChainHopLimitError);
    expect([...touched].filter((id) => /^c~\d+$/.test(id))).toEqual([]); // no hop, no probe
  });
});

describe("P3-4 - a fork of a chain member keeps the carried resources seed", () => {
  it("an exceeded quota carried into a successor survives a fork of that successor", async () => {
    const h = build(on);
    const f = flow<{ gen?: number }, unknown>("quota", async (ctx, input) => {
      if (input?.gen === undefined) {
        ctx.emit("RESOURCE_METERED", { tokens: 77 });
        ctx.emit("QUOTA_EXCEEDED", { reason: "budget" });
        await ctx.receive("go");
        return ctx.continueAsNew({ gen: 1 });
      }
      await ctx.receive("never");
    });
    h.rt.registerFlow(f.definition, f.runner);
    await settle(await h.rt.start(f, {}, { executionId: "q" }));
    await h.rt.send("q", { topic: "go", payload: 1 });
    await parked(h, "q~1");
    const succ = (await h.rt.loadState("q~1"))?.variables._resources as {
      exceeded?: boolean;
      tokens: number;
    };
    expect(succ.exceeded).toBe(true);
    const tip = (await h.eventStore.read("q~1")).length - 1;
    const { executionId: fk } = await h.rt.fork("q~1", tip, { executionId: "qf" });
    const forked = (await h.rt.loadState(fk))?.variables as {
      _resources?: { exceeded?: boolean; tokens: number };
      _chain: unknown;
    };
    expect(forked._resources?.exceeded).toBe(true);
    expect(forked._resources?.tokens).toBe(77);
    expect(forked._chain).toEqual({ chainId: "qf", generation: 0 }); // still left the chain
  });
});
