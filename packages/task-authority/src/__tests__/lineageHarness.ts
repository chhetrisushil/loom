import { type FlowDefinition, SuspendError } from "@loomwork/core";
import {
  type EffectContext,
  type EffectMiddleware,
  EffectRuntime,
  type PrincipalChain,
  ToolEffect,
} from "@loomwork/effect-runtime";
import { InMemoryAsyncEventStore } from "@loomwork/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loomwork/snapshot-runtime";
import {
  type ExecutionContext,
  type FlowRunner,
  WorkflowRuntime,
} from "@loomwork/workflow-runtime";
import { z } from "zod";
import type { TaskGrant } from "../grant";
import { installTaskAuthority } from "../install";
import { taskLeaseMiddleware } from "../lease";
import { InMemoryGrantBroker, type RenewalPolicy } from "../renew";
import { RENEWAL_GATE, renewalResumeSchema, withRenewal } from "../renewal";

export const SECRET = "lineage-secret";
export const NOW = 1_000_000;
export const task = (id: string, toolId = "act") =>
  ({ _tag: "TaskDefinition", kind: "tool", id, toolId }) as never;
export const chainOf = (g: TaskGrant): PrincipalChain => ({ actor: g.issuedTo, taskGrant: g });

export async function until(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** What a leased `act` call saw: the kernel's seen-origins list (`undefined` = untracked). */
export interface ActCall {
  seen: readonly string[] | undefined;
}

/**
 * One real runtime (in-memory stores, inbox on) with task authority installed and a leased `act` effect.
 * `gate` is `kernel.features.seenOrigins`. `middleware` is placed AFTER the lease middleware.
 */
export function world(
  o: {
    gate?: boolean;
    maxOrigins?: number;
    middleware?: (effects: () => EffectRuntime) => EffectMiddleware[];
    policy?: RenewalPolicy;
  } = {}
) {
  const broker = new InMemoryGrantBroker({
    secret: SECRET,
    now: () => NOW,
    ...(o.policy !== undefined && { policy: o.policy }),
  });
  const acts: ActCall[] = [];
  const effects: EffectRuntime = new EffectRuntime([
    taskLeaseMiddleware({ secret: SECRET, source: broker }),
    ...(o.middleware?.(() => effects) ?? []),
  ]);
  effects.register(
    "act",
    new ToolEffect(async (_i: unknown, ctx: EffectContext) => {
      acts.push({ seen: ctx.seenOrigins?.() });
      return { ok: true };
    })
  );
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    resumeAuthenticator: {
      verify: () => ({ status: "verified", actor: "ops", verifiedBy: "test" }),
    },
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    inboxEnabled: true,
    inboxArchive: "none",
    ...(o.gate !== false && { seenOriginsEnabled: true }),
    ...(o.maxOrigins !== undefined && { seenOriginsLimits: { maxOrigins: o.maxOrigins } }),
    onWarn: () => {},
  });
  installTaskAuthority(runtime, { source: broker, secret: SECRET, now: () => NOW });
  const flowOf = (id: string, runner: FlowRunner<unknown, unknown>) => {
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
    runtime.registerFlow(definition, runner);
    return { definition, runner } as never;
  };
  /** A root grant for `taskId` (rootId === taskId) covering `act` with a lease. */
  const grant = (taskId: string, actor = `agent-${taskId}`) =>
    broker.mint({
      taskId,
      issuedTo: actor,
      effects: ["act"],
      leases: { w: { ceiling: 50, effects: ["act"] } },
      ttlMs: 60_000,
    });
  /** `receive("t")` then one leased `act` step: agent B reading shared content, then acting. A refusal is the output. */
  const reader = flowOf("reader", async (ctx: ExecutionContext) => {
    await ctx.receive("t");
    try {
      await ctx.run(task("s1"), {});
    } catch (e) {
      if (e instanceof SuspendError) throw e;
      return { refused: (e as { reason?: string }).reason ?? String(e) };
    }
    return { done: true };
  });
  /** Like `reader`, but the step goes through `withRenewal`: a park waits on the renewal gate. */
  const parker = flowOf("parker", async (ctx: ExecutionContext) => {
    await ctx.receive("t");
    await withRenewal(ctx as never, "a", (id) => ctx.run(task(id), {}));
    await ctx.receive("u");
    await withRenewal(ctx as never, "b", (id) => ctx.run(task(id), {}));
    return { done: true };
  });
  const send = (id: string, topic: string, payload: unknown, principal?: PrincipalChain) =>
    runtime.send(id, { topic, payload }, principal === undefined ? {} : { principal });
  const types = async (id: string) => (await eventStore.read(id)).map((e) => e.eventType);
  const decisions = async (id: string) =>
    (await eventStore.read(id))
      .filter(
        (e) =>
          e.eventType === "DECISION_RECORDED" &&
          String((e.payload as { decisionId?: string }).decisionId).endsWith(
            ":task-authority:directed-by"
          )
      )
      .map((e) => (e.payload as { choice: { lineages: string[] } }).choice.lineages);
  const outcome = async (id: string) => (await runtime.loadState(id))?.variables._output;
  return {
    broker,
    runtime,
    effects,
    acts,
    flowOf,
    grant,
    reader,
    parker,
    send,
    types,
    decisions,
    outcome,
  };
}
