import { ReplayVM } from "@loom/replay-vm";
import { describe, expect, it } from "vitest";
import { CountingContentStore, boot } from "./__fixtures__/claimCheckHarness";

// ADR 0140 - folded state / log bytes of an `agentLoop$` run at 50 and 200 turns, WITHOUT and WITH
// `execution.claimCheck` (1 KiB cap, default 256-char preview, and preview off), tool outputs of 1.5-4 kB per
// turn (the #730 harness shape), payloads JSON-cloned the way a durable store does. Sizes are
// `JSON.stringify` of the state folded from the log, which is what a resume rebuilds. Timings are printed,
// not asserted on (this is a *.perf.test.ts: `pnpm test:perf`); the asserted facts are byte counts.

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

async function measure(turns: number, claimCheck: "off" | "preview" | "none") {
  const content = new CountingContentStore();
  const b = boot({
    turns,
    ...(claimCheck !== "off" && {
      claimCheck: {
        store: content,
        toolIds: ["big"],
        ...(claimCheck === "none" && { preview: false as const }),
      },
    }),
  });
  await (await b.app.runtime.start(b.flow, {}, { executionId: "x" })).waitForCompletion();
  const events = await b.eventStore.read("x");
  const json = JSON.stringify(new ReplayVM(events).getState());
  const samples: number[] = [];
  for (let i = 0; i < 9; i++) {
    const t0 = performance.now();
    JSON.parse(json);
    samples.push(performance.now() - t0);
  }
  return {
    state: json.length,
    log: JSON.stringify(events).length,
    parseMs: median(samples),
    blobs: content.calls.put ?? 0,
  };
}

describe("ADR 0140 - state bytes with and without execution.claimCheck, 50 vs 200 turns", () => {
  it("claim-checking cuts the folded state and the log several-fold, and keeps them linear", async () => {
    const rows: Array<Record<string, string | number>> = [];
    const r: Record<string, Awaited<ReturnType<typeof measure>>> = {};
    for (const turns of [50, 200]) {
      for (const mode of ["off", "preview", "none"] as const) {
        const m = await measure(turns, mode);
        r[`${turns}/${mode}`] = m;
        rows.push({
          turns,
          claimCheck: mode,
          "state (resume read)": kb(m.state),
          log: kb(m.log),
          "resume parse ms": Number(m.parseMs.toFixed(2)),
          "blobs written": m.blobs,
        });
      }
    }
    console.table(rows);
    for (const turns of [50, 200]) {
      expect(r[`${turns}/preview`]!.state).toBeLessThan(r[`${turns}/off`]!.state / 2);
      expect(r[`${turns}/none`]!.state).toBeLessThan(r[`${turns}/preview`]!.state);
      expect(r[`${turns}/preview`]!.blobs).toBe(turns);
    }
    // still linear in turns: x4 turns is about x4 state, not x16
    expect(r["200/preview"]!.state / r["50/preview"]!.state).toBeLessThan(6);
  }, 120_000);
});
