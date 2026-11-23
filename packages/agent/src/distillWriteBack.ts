import { isTainted, taintOf, tainted } from "@loomwork/classify";
import { sha256Hex } from "@loomwork/core";
import type { MemoryEntry, TieredMemory } from "@loomwork/memory";
import type { ExecutionContext } from "@loomwork/workflow-runtime";
import { classifyModelCallFailure } from "./toolFailure";

/**
 * ADR 0149 D1 - `writeBack.distill`: store model-extracted facts, consolidated against the facts the
 * scope already holds, instead of the raw prompt and answer.
 */
export interface AgentLoopDistill {
  /** The distiller effect (`{ prompt, answer, existing } -> { add, supersede }`); always an effect id. */
  toolId: string;
  /** Most existing facts shown to the distiller, newest kept. Default 200. */
  maxExisting?: number;
  /** Most new facts kept per run. Default 16. */
  maxFacts?: number;
  /** Each fact is cut to this many characters. Default 1000. */
  maxFactChars?: number;
}

/** Config-time validation; `fail` throws the caller's config error. */
export function validateDistill(d: unknown, fail: (m: string) => never): void {
  const o = d as AgentLoopDistill | null;
  if (typeof o !== "object" || o === null || typeof o.toolId !== "string" || o.toolId === "") {
    fail("agentLoop$ writeBack.distill needs a non-empty `toolId` (the distiller effect)");
  }
  for (const k of ["maxExisting", "maxFacts", "maxFactChars"] as const) {
    const v = o[k];
    if (v !== undefined && !(Number.isInteger(v) && v > 0)) {
      fail(`agentLoop$ writeBack.distill.${k} must be a positive integer`);
    }
  }
}

/** What the distill step decided to write: facts to remember and ids to forget. */
export interface DistilledWrite {
  entries: { id: string; role: string; content: unknown }[];
  forget: string[];
}

/**
 * Read the scope's facts, run the distiller as a journaled effect, validate its output (D3) and
 * return the write. Returns `undefined` (nothing to write) when the distiller failed with anything
 * but control flow (D5): that outcome is a recorded decision, so a resume reaches the same verdict.
 */
export async function distillWriteBack(a: {
  ctx: ExecutionContext;
  memory: TieredMemory;
  tier: string;
  scope: string;
  idPrefix: string;
  distill: AgentLoopDistill;
  prompt: string;
  promptOrigin?: string | undefined;
  answer: string;
  sawTaintFrom?: string | undefined;
  warn: (message: string) => void;
  /** ADR 0150 D8: when set, the existing-facts read is a journaled recall EFFECT (authorized), not an inline read. */
  recallToolId?: string | undefined;
}): Promise<DistilledWrite | undefined> {
  const { ctx, distill: d } = a;
  const maxFacts = d.maxFacts ?? 16;
  const maxFactChars = d.maxFactChars ?? 1000;
  // Filter to facts BEFORE the limit, inside the recorded decision: a tier that also holds raw
  // entries (distill turned on for an existing tier) must still show the newest facts, and only
  // the facts shown are journaled.
  const factsOf = (all: MemoryEntry[]) =>
    all.filter((e) => e.role === "fact" && typeof e.id === "string").slice(-(d.maxExisting ?? 200));
  const existing =
    a.recallToolId !== undefined
      ? factsOf(
          await ctx.execute<{ tier: string; scope: string }, MemoryEntry[]>(
            {
              _tag: "TaskDefinition",
              kind: "memory",
              id: `${a.idPrefix}#writeback:existing`,
              toolId: a.recallToolId,
            },
            { tier: a.tier, scope: a.scope }
          )
        )
      : await ctx.decide(`${a.idPrefix}#writeback:existing`, async () =>
          factsOf(await a.memory.recall(a.tier, a.scope))
        );
  const shown = new Set(existing.map((e) => e.id as string));
  let origin = a.promptOrigin ?? a.sawTaintFrom;
  for (const e of existing) {
    if (isTainted(e.content)) origin ??= taintOf(e.content)?.origin ?? "unknown";
  }
  const task = {
    _tag: "TaskDefinition",
    kind: "memory",
    id: `${a.idPrefix}#writeback:distill`,
    toolId: d.toolId,
  } as const;
  const input = {
    prompt: a.promptOrigin === undefined ? a.prompt : tainted(a.prompt, a.promptOrigin),
    answer: a.sawTaintFrom === undefined ? a.answer : tainted(a.answer, a.sawTaintFrom),
    existing: existing.map((e) => ({ id: e.id as string, content: e.content })),
  };
  // A failed distiller DEGRADES (the answer exists; memory is a by-product). The outcome is a recorded
  // decision wrapping the step, so a replay whose distiller now succeeds reaches the same verdict.
  // Control flow (park, authority / safety stop, cancel, divergence) is the runtime's and propagates.
  const outcome = await ctx.decide<{ ok: true } | { failed: string }>(
    `${a.idPrefix}#writeback:distill:outcome`,
    async () => {
      try {
        await ctx.execute(task, input);
        return { ok: true as const };
      } catch (e) {
        if (classifyModelCallFailure(e) === "terminal") throw e;
        // The class only: a message may carry text the model produced (untrusted), and this verdict is journaled.
        return { failed: e instanceof Error ? e.name : "non-Error throw" };
      }
    },
    { source: "agent-distiller" }
  );
  if ("failed" in outcome) {
    a.warn(
      `agentLoop$: the memory distiller failed (${outcome.failed}); nothing was written back for this run (ADR 0149 D5).`
    );
    return undefined;
  }
  // Served from the completed frame (no second run).
  const out = (await ctx.execute(task, input)) as { add?: unknown; supersede?: unknown } | null;

  const dropped = new Set<string>();
  const forget: string[] = [];
  for (const id of Array.isArray(out?.supersede) ? out.supersede : []) {
    if (typeof id === "string" && shown.has(id)) forget.push(id);
    else dropped.add("a supersede id that was not shown to the distiller");
  }
  // Cut, then dedupe by text (the id is the text's hash), THEN cap: a repeated fact must not take a
  // maxFacts slot or store two entries under one id.
  const texts = new Set<string>();
  for (const t of Array.isArray(out?.add) ? out.add : []) {
    if (typeof t !== "string" || t.trim() === "") {
      dropped.add("a fact that is not a non-empty string");
      continue;
    }
    if (t.length > maxFactChars) dropped.add(`a fact cut to maxFactChars (${maxFactChars})`);
    const cut = t.slice(0, maxFactChars);
    if (texts.has(cut)) dropped.add("a duplicate fact in one reply");
    else if (texts.size >= maxFacts) dropped.add(`facts over maxFacts (${maxFacts})`);
    else texts.add(cut);
  }
  if (dropped.size > 0) {
    a.warn(
      `agentLoop$: the memory distiller's output was trimmed: ${[...dropped].join("; ")} (ADR 0149 D3).`
    );
  }
  const entries = [...texts].map((t) => ({
    id: `fact:${sha256Hex(t).slice(0, 32)}`,
    role: "fact",
    content: origin === undefined ? t : tainted(t, origin),
  }));
  return { entries, forget };
}
