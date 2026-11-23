import type { EventStore } from "@loomwork/event-runtime";
import { ReplayVM } from "@loomwork/replay-vm";
import { describe, expect, it } from "vitest";
import { adoptSeenOrigins } from "./seenOriginsSeed";

// ADR 0152 S2c (perf, non-blocking): the one-time rescan of a long history. Numbers are printed, not gated on a ratio.
const env = (seq: number, eventType: string, payload: unknown) =>
  ({
    id: `p-${seq}`,
    executionId: "p",
    workflowId: "f",
    sequence: seq,
    eventType,
    payload,
    timestamp: seq,
  }) as never;

describe("seen-origins rescan of a long history", () => {
  it("folds 50k events, a tenth of them channel events with small tainted values", async () => {
    const N = 50_000;
    const log = [env(0, "EXECUTION_STARTED", { input: 1 })] as { sequence: number }[];
    for (let i = 1; i <= N; i++) {
      log.push(
        i % 10 === 0
          ? env(i, "DECISION_RECORDED", {
              decisionId: `d${i}`,
              choice: { __loomTainted: { origin: `o${i % 7}` }, value: i },
            })
          : env(i, "NOTE", { n: i })
      );
    }
    const events = {
      readRange: async (_: string, from: number, to: number) => log.slice(from, to + 1),
    } as unknown as EventStore;
    const vm = new ReplayVM([], {
      executionId: "p",
      workflowId: "f",
      workflowVersion: "1",
      sequence: N,
    } as never);
    const t0 = performance.now();
    await adoptSeenOrigins(
      { enabled: true, limits: { maxOrigins: 64, maxScanNodes: 10_000 }, events, memo: new Map() },
      vm
    );
    const ms = performance.now() - t0;
    console.log(
      `rescan ${N} events: ${ms.toFixed(0)} ms (${((ms * 1000) / N).toFixed(1)} us/event)`
    );
    const key = vm.peekState().variables._seenOrigins as { origins: string[]; through: number };
    expect(key.through).toBe(N);
    expect(key.origins.length).toBe(7);
  }, 60_000);
});
