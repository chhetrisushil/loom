import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { isClaimCheck } from "@loom/middleware";
import { InMemoryContentStore } from "@loom/plugin-content";
import { InMemoryDurableStateStore } from "@loom/plugin-durable-state";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sentinelPreset } from "./sentinelPreset";

const stateSchema = z.object({ wakes: z.number() });
type State = z.infer<typeof stateSchema>;

function makePreset(timeZone?: string) {
  return sentinelPreset<State>({
    id: "pg-sentinel",
    cron: "0 */6 * * *",
    ...(timeZone !== undefined && { timeZone }),
    state: { schema: stateSchema },
    stateStore: new InMemoryDurableStateStore(),
    contentStore: new InMemoryContentStore(),
    inlineCapBytes: 256,
    digests: { "pg.read": (r) => ({ n: (r as { rows: unknown[] }).rows.length }) },
  });
}

describe("sentinelPreset (DX-1) — assembles the shipped pieces, adds nothing", () => {
  it("exposes the schedule, pin policy, and T1 occurrence identity", () => {
    const preset = makePreset();
    expect(preset.schedule).toMatchObject({
      _tag: "ScheduleDefinition",
      id: "pg-sentinel",
      cron: "0 */6 * * *",
      flowId: "pg-sentinel-flow",
    });
    expect(preset.pinnedEventTypes).toEqual(["FINDING_RECORDED"]);
    const t = Date.UTC(2026, 6, 15);
    expect(preset.occurrenceId(t)).toBe(`pg-sentinel@${t}`);
    expect(preset.occurrenceOf(preset.occurrenceId(t))).toBe(t);
  });

  it("passes timeZone through to the schedule (default: none, i.e. UTC)", () => {
    expect(makePreset().schedule.timeZone).toBeUndefined();
    expect(makePreset("Europe/Berlin").schedule.timeZone).toBe("Europe/Berlin");
  });

  it("one wake end-to-end: carry state loads/saves, big reads go by reference, findings pin", async () => {
    const preset = makePreset();
    const effects = new EffectRuntime(preset.middleware);
    preset.register(effects);
    effects.register(
      "pg.read",
      new ToolEffect(async () => ({ rows: Array.from({ length: 64 }, (_, i) => `row-${i}`) }), {
        idempotent: true,
      })
    );

    const eventStore = new InMemoryAsyncEventStore();
    const runtime = new WorkflowRuntime({
      eventStore,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: effects,
      validateInput: true,
    });

    const io = z.object({}).passthrough() as z.ZodSchema<Record<string, unknown>>;
    const runner: FlowRunner<Record<string, unknown>, Record<string, unknown>> = async (ctx) => {
      const carried = await preset.state.load(ctx);
      const read = await ctx.execute(
        { _tag: "TaskDefinition", kind: "tool", id: "read", toolId: "pg.read" },
        {}
      );
      if (isClaimCheck(read)) {
        ctx.emit("FINDING_RECORDED", { evidence: [{ __loomContent: read.ref.__loomContent }] });
      }
      await preset.state.save(
        ctx,
        { wakes: ((carried.value?.wakes as number) ?? 0) + 1 },
        carried.revision
      );
      return { ok: true };
    };
    const definition: FlowDefinition<Record<string, unknown>, Record<string, unknown>> = {
      _tag: "FlowDefinition",
      id: "pg-sentinel-flow",
      name: "sentinel",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: io,
      steps: [],
    };
    runtime.registerFlow(definition, runner);

    const t = Date.UTC(2026, 6, 15);
    const handle = await runtime.start(
      { definition, runner },
      {},
      { executionId: preset.occurrenceId(t) }
    );
    expect((await handle.waitForCompletion()).status).toBe("completed");

    const events = await eventStore.read(preset.occurrenceId(t));
    const read = events.find(
      (e) => e.eventType === "STEP_COMPLETED" && (e.payload as { stepId: string }).stepId === "read"
    );
    const output = (read?.payload as { output: unknown }).output;
    expect(isClaimCheck(output)).toBe(true); // claim-check wired
    expect((output as { digest: unknown }).digest).toEqual({ n: 64 }); // declared digest applied

    const pinned = preset.pinPredicate(eventStore);
    expect(await pinned(preset.occurrenceId(t))).toBe(true); // finding pins the run
    expect(await pinned("some-other-run")).toBe(false);
  });
});
