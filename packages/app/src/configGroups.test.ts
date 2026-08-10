import { step$ } from "@loom/core";
import { GrantTable, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { Snapshot, SnapshotStore } from "@loom/snapshot-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig, normalizeConfig } from "./defineConfig";

// ── Grouped config options, with the flat spellings still accepted ───────────
//
// The dual surface exists so no app has to move on this release's schedule. What these
// pin is that BOTH spellings reach the same wiring, that neither silently wins when an
// app sets both, and that the grouping is presentation only — `defineConfig`'s body
// reads one normalized shape and cannot tell which was used.

const io = { inputSchema: z.object({}), outputSchema: z.object({}) };
const s0 = step$({ id: "s0", name: "S0", toolId: "t", ...io });
const runner: FlowRunner<unknown, Record<string, never>> = async (ctx) => {
  await ctx.run(s0, {});
  return {};
};
const flow = {
  definition: { _tag: "FlowDefinition", id: "f", name: "f", version: "1.0.0", ...io, steps: [s0] },
  runner,
} as RegisteredFlow;

class CountingSnapshotStore implements SnapshotStore {
  readonly saves: Snapshot[] = [];
  async save(s: Snapshot): Promise<void> {
    this.saves.push(s);
  }
  async loadLatest(): Promise<Snapshot | null> {
    return null;
  }
  async loadAt(): Promise<Snapshot | null> {
    return null;
  }
  async loadLatestBefore(): Promise<Snapshot | null> {
    return null;
  }
  async close(): Promise<void> {}
}

describe("normalizeConfig — one shape from two spellings", () => {
  it("lifts every grouped option to the flat internal shape", () => {
    const authorizer = new GrantTable({ f: ["t"] });
    const onWarn = () => {};
    const resolved = normalizeConfig({
      storage: { kind: "memory" },
      security: { authorizer },
      observability: { onWarn },
      durability: { snapshotEvery: 4 },
      execution: { validateInput: true },
      checks: { validate: "warn" },
    });
    expect(resolved.authorizer).toBe(authorizer);
    expect(resolved.onWarn).toBe(onWarn);
    expect(resolved.snapshotEvery).toBe(4);
    expect(resolved.validateInput).toBe(true);
    expect(resolved.validate).toBe("warn");
    // The group keys themselves do not survive into the internal shape.
    expect("security" in resolved).toBe(false);
    expect("durability" in resolved).toBe(false);
  });

  it("passes the flat spelling through untouched", () => {
    const resolved = normalizeConfig({ storage: { kind: "memory" }, snapshotEvery: 7 });
    expect(resolved.snapshotEvery).toBe(7);
  });

  it("mixes the two freely — grouping is per option, not per app", () => {
    const resolved = normalizeConfig({
      storage: { kind: "memory" },
      security: { policies: [] },
      snapshotEvery: 3, // still flat
    });
    expect(resolved.policies).toEqual([]);
    expect(resolved.snapshotEvery).toBe(3);
  });

  it("REFUSES an option set both ways, naming it and both spellings", () => {
    // No sensible precedence between two deliberate answers — and quietly preferring one
    // is how `security.authorizer` ends up ignored because a flat one survived a refactor.
    expect(() =>
      normalizeConfig({
        storage: { kind: "memory" },
        authorizer: new GrantTable({}),
        security: { authorizer: new GrantTable({}) },
      })
    ).toThrow(/`authorizer` \(also set as `security.authorizer`\)/);
  });

  it("reports every conflict at once, not just the first", () => {
    expect(() =>
      normalizeConfig({
        storage: { kind: "memory" },
        snapshotEvery: 1,
        durability: { snapshotEvery: 2 },
        validateInput: true,
        execution: { validateInput: false },
      })
    ).toThrow(/snapshotEvery(.|\n)*validateInput/);
  });

  it("leaves an option set in neither place undefined", () => {
    const resolved = normalizeConfig({ storage: { kind: "memory" }, security: {} });
    expect(resolved.authorizer).toBeUndefined();
  });
});

describe("defineConfig — grouped options reach the same wiring", () => {
  it("applies durability.snapshotEvery exactly as the flat key did", async () => {
    const snapshots = new CountingSnapshotStore();
    const app = defineConfig({
      storage: {
        kind: "custom",
        eventStore: new InMemoryAsyncEventStore(),
        snapshotStore: snapshots,
      },
      flows: [flow],
      durability: { snapshotEvery: 2 },
    });
    app.effectRuntime.register("t", new ToolEffect(async () => ({})));
    await (await app.runtime.start(flow, {})).waitForCompletion();
    await new Promise((r) => setTimeout(r, 0));
    expect(snapshots.saves.length).toBeGreaterThan(0);
    await app.close();
  });

  it("applies security.authorizer exactly as the flat key did", () => {
    // capability-compat only runs when an authorizer is wired, so its presence in the
    // report is evidence the grouped key was read.
    const app = defineConfig({
      storage: { kind: "memory" },
      flows: [flow],
      security: { authorizer: new GrantTable({ f: ["t"] }) },
    });
    expect(app.verify().checked).toContain("capability-compat");
  });

  it("applies observability.onWarn exactly as the flat key did", () => {
    const warnings: string[] = [];
    defineConfig({
      storage: { kind: "memory" },
      // A schedule with no timer store warns — the cheapest observable use of onWarn.
      scheduleModules: [
        { s: { _tag: "ScheduleDefinition", id: "s", cron: "* * * * *", flowId: "f" } },
      ] as never,
      observability: { onWarn: (m) => warnings.push(m) },
    });
    expect(warnings.some((w) => w.includes("will not fire"))).toBe(true);
  });
});
