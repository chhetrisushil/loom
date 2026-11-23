import { type FlowDefinition, SuspendError } from "@loomwork/core";
import { EffectRuntime, ToolEffect } from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { superviseChildren } from "@loomwork/orchestration";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import {
  type ExecutionContext,
  type FlowRunner,
  type RegisteredFlow,
  WorkflowRuntime,
} from "@loomwork/workflow-runtime";
import { z } from "zod";
import { TaskGrantAuthorizer } from "./authorizer";
import type { GrantBroker } from "./broker";
import { CHILD_LEASE_TOOL, childGrantMinter, childLeaseEffect } from "./childLease";
import { type Check, SECRET, TTL, clock, mintReq, mk, must, task, until } from "./conformanceKit";
import type { ConformanceSubject } from "./conformanceKit";
import { directedBy } from "./directedBy";
import type { TaskGrant } from "./grant";
import { installTaskAuthority } from "./install";
import { taskLeaseMiddleware } from "./lease";
import { lineageSend } from "./lineage";
import { RENEWAL_GATE, renewalResumeSchema, withRenewal } from "./renewal";

export type Runner = (ctx: ExecutionContext) => Promise<unknown>;
export interface Stores {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
}
/** A real runtime on the production wiring: codec, lease middleware, grant authorizer, supervisor. */
export function rig(
  broker: GrantBroker,
  c: { now: () => number },
  flows: Record<string, Runner>,
  o: { stores?: Stores; hangMint?: boolean; directed?: { wired: boolean } } = {}
) {
  const ran = { act: 0, other: 0 };
  const authorizer = new TaskGrantAuthorizer({
    secret: SECRET,
    base: { authorize: () => ({ allowed: true }) },
    now: c.now,
  });
  const effects: EffectRuntime = new EffectRuntime(
    [
      taskLeaseMiddleware({ secret: SECRET, source: broker, now: c.now, effects: () => effects }),
      ...(o.directed?.wired === true ? [directedBy({ secret: SECRET })] : []),
    ],
    { authorizer }
  );
  for (const k of ["act", "other"] as const)
    effects.register(
      k,
      new ToolEffect(async () => {
        ran[k]++;
        return { ok: true };
      })
    );
  effects.register(CHILD_LEASE_TOOL, childLeaseEffect({ secret: SECRET, broker }));
  const s = o.stores ?? {
    eventStore: new InMemoryAsyncEventStore(),
    snapshotStore: new InMemoryAsyncSnapshotStore(),
  };
  const sup: { v?: ReturnType<typeof superviseChildren> } = {};
  const runtime = new WorkflowRuntime({
    ...s,
    effectRuntime: effects,
    ...(o.directed !== undefined && {
      seenOriginsEnabled: true,
      inboxEnabled: true,
      inboxArchive: "none" as const,
    }),
    onWarn: () => {},
    onEvent: (e) => sup.v?.onEvent(e),
    resumeAuthenticator: {
      verify: () => ({ status: "verified", actor: "ops", verifiedBy: "kit" }),
    },
  });
  const defs: Record<string, RegisteredFlow> = {};
  for (const [id, runner] of Object.entries(flows)) {
    const definition = {
      _tag: "FlowDefinition",
      id,
      name: id,
      version: "1.0.0",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      steps: [],
      resumeSchemas: { [RENEWAL_GATE]: renewalResumeSchema },
    } as unknown as FlowDefinition;
    runtime.registerFlow(definition, runner as FlowRunner<unknown, unknown>);
    defs[id] = { definition, runner } as unknown as RegisteredFlow;
  }
  installTaskAuthority(runtime, { source: broker, secret: SECRET, now: c.now });
  const real = childGrantMinter(broker, { ttlMs: TTL, now: c.now });
  const never = new Promise<never>(() => {});
  sup.v = superviseChildren({
    runtime,
    flows: defs,
    taskAuthority: o.hangMint ? { ...real, mintChildGrant: () => never } : real,
    onError: () => {},
  });
  return {
    runtime,
    ran,
    stores: s,
    sup: sup.v,
    start: (flow: string, id: string, g: TaskGrant) =>
      runtime.start(
        defs[flow] as RegisteredFlow,
        {},
        { executionId: id, principal: { actor: g.issuedTo, taskGrant: g } }
      ),
  };
}
/** Run `n` acts, stop at the first refusal. */
export const acts = async (ctx: ExecutionContext, n: number, tool = "act") => {
  let ran = 0;
  for (let i = 0; i < n; i++) {
    try {
      await ctx.run(task(`${tool}${i}`, tool), {});
      ran++;
    } catch (e) {
      if (e instanceof SuspendError) throw e;
      break;
    }
  }
  return ran;
};
export const RUNTIME_CHECKS: Record<string, Check> = {
  // Guards the package and kernel (reserved `lease.` prefix), not the broker: a broken broker cannot fail this.
  "carve.forged-meters": async (s) => {
    const c = clock();
    const b = mk(s, undefined, c);
    const g = await b.mint(mintReq("t", 4));
    let err: unknown;
    const h = rig(b, c, {
      f: async (ctx) => {
        try {
          ctx.emit("RESOURCE_METERED", { custom: { "lease.w.returned": 100 } });
        } catch (e) {
          err = e;
        }
      },
    });
    await (await h.start("f", "t", g)).waitForCompletion();
    must(err !== undefined, "flow code forged a lease.* meter (R26)");
  },
  // Guards the grant authorizer and lease middleware, not the broker: a broken broker cannot fail this.
  "laundering.uncovered.shared-memory": async (s) => {
    const c = clock();
    const b = mk(s, undefined, c);
    const shared: string[] = []; // the in-process channel: A writes a request, B reads it
    const ga = await b.mint({
      ...mintReq("a", 5),
      effects: ["act", "other"],
      leases: { w: { ceiling: 5, effects: ["act", "other"] } },
    });
    const gb = await b.mint(mintReq("b", 5));
    let denied: unknown;
    const h = rig(b, c, {
      a: async (ctx) => {
        shared.push("other");
        return acts(ctx, 1, "other"); // A may do it: the control that the effect works
      },
      b: async (ctx) => {
        try {
          await ctx.run(task("asked", shared[0]), {});
        } catch (e) {
          denied = e;
        }
        return acts(ctx, 1);
      },
    });
    await (await h.start("a", "a", ga)).waitForCompletion();
    const out = await (await h.start("b", "b", gb)).waitForCompletion();
    must(h.ran.other === 1, `B ran an effect outside its grant (other ran ${h.ran.other} times)`);
    must(
      denied !== undefined && out.variables._output === 1,
      "B's refusal was not a refusal, or B lost its own authority"
    );
  },
  revocation: async (s) => {
    const c = clock();
    const b = mk(s, undefined, c);
    const g = await b.mint(mintReq("t", 10));
    const h = rig(b, c, {
      f: async (ctx) => {
        await ctx.run(task("one"), {});
        await b.revoke("t", "kit");
        c.t += 10_000; // past the middleware's revocation cache
        return withRenewal(ctx as never, "two", async (a) => ctx.run(task(a), {}));
      },
    });
    await (await h.start("f", "t", g)).waitForSuspend().catch((e: Error) => {
      throw new Error(`the effect after the revoke ran, the run did not pause: ${e.message}`);
    });
    must(h.ran.act === 1, `the effect after the revoke ran (${h.ran.act} effects)`);
    must(
      (await h.runtime.loadState("t"))?.status === "suspended",
      "a revoked grant did not pause the run"
    );
  },
};

/**
 * D14 laundering, COVERED (ADR 0150 D7): B's grant covers the step, and A's content directed it. The step must be
 * attributed (`task-authority:directed-by` recorded naming `lineage:a`), never silently allowed; and B's own lineage
 * must NOT be attributed (the control). `wired: false` is the deliberately broken stack (no `directedBy`) that this must fail.
 */
export async function launderingCovered(s: ConformanceSubject, wired = true): Promise<void> {
  const c = clock();
  const b = mk(s, undefined, c);
  const [ga, gb] = [await b.mint(mintReq("a", 5)), await b.mint(mintReq("b", 5))];
  const h = rig(
    b,
    c,
    {
      b: async (ctx) => {
        await ctx.receive("t");
        return acts(ctx, 1);
      },
    },
    { directed: { wired } }
  );
  const send = lineageSend(h.runtime, SECRET);
  const directedOf = async (id: string): Promise<string[][]> =>
    (await h.runtime.events.read(id))
      .filter(
        (e) =>
          e.eventType === "DECISION_RECORDED" &&
          String((e.payload as { decisionId?: string }).decisionId).endsWith(
            ":task-authority:directed-by"
          )
      )
      .map((e) => (e.payload as { choice: { lineages: string[] } }).choice.lineages);
  const run = async (id: string, from: TaskGrant): Promise<string[][]> => {
    await h.start("b", id, gb);
    await send(
      id,
      { topic: "t", payload: "do it" },
      { principal: { actor: from.issuedTo, taskGrant: from } }
    );
    await until(async () => (await h.runtime.loadState(id))?.status === "completed", "B to finish");
    return directedOf(id);
  };
  const foreign = await run("b1", ga);
  must(h.ran.act === 1, `B's covered step ran ${h.ran.act} times, expected once`);
  must(
    foreign.some((l) => l.includes("lineage:a")),
    "B's covered step, directed by A's content, ran with no attribution (no directed-by record naming lineage:a)"
  );
  const own = await run("b2", gb);
  must(
    own.length === 0,
    "B's step, directed only by B's own lineage, was attributed to a foreign one"
  );
}
