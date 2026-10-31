import { ReplayVM } from "@loom/replay-vm";
import { describe, expect, it } from "vitest";
import { CountingContentStore, boot } from "./__fixtures__/claimCheckHarness";

// ADR 0142 / issue #732 - a COMPLETED 200-turn run's folded state with `toolCallLog` "full" vs "lean",
// alone and together with `execution.claimCheck`. Sizes are `JSON.stringify` of the state folded from the
// log (what a resume rebuilds); the `_output` figure is the finished step's output alone. Byte counts are
// asserted; nothing is timed. Run with `pnpm test:perf`.

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

async function measure(turns: number, toolCallLog: "full" | "lean", claimCheck: boolean) {
  const b = boot({
    turns,
    toolCallLog,
    ...(claimCheck && { claimCheck: { store: new CountingContentStore(), toolIds: ["big"] } }),
  });
  await (await b.app.runtime.start(b.flow, {}, { executionId: "x" })).waitForCompletion();
  const state = new ReplayVM(await b.eventStore.read("x")).getState();
  return {
    state: JSON.stringify(state).length,
    output: JSON.stringify((state.variables as Record<string, unknown>)._output).length,
  };
}

describe("ADR 0142 - folded state of a completed run, toolCallLog full vs lean", () => {
  it("lean drops the duplicated tool outputs from the finished state", async () => {
    const rows: Array<Record<string, string>> = [];
    const r: Record<string, Awaited<ReturnType<typeof measure>>> = {};
    for (const [mode, cc] of [
      ["full", false],
      ["lean", false],
      ["full", true],
      ["lean", true],
    ] as const) {
      const m = await measure(200, mode, cc);
      r[`${mode}/${cc}`] = m;
      rows.push({
        toolCallLog: mode,
        claimCheck: cc ? "on" : "off",
        "state (resume read)": kb(m.state),
        _output: kb(m.output),
      });
    }
    console.table(rows);
    const full = r["full/false"];
    const lean = r["lean/false"];
    if (full === undefined || lean === undefined) throw new Error("missing measurement");
    expect(lean.output).toBeLessThan(full.output / 5);
    expect(lean.state).toBeLessThan(full.state - 100 * 1024);
    // with the claim-check on, the full log already carries envelopes; lean must not be larger
    const fullCc = r["full/true"];
    const leanCc = r["lean/true"];
    expect(leanCc?.state).toBeLessThanOrEqual((fullCc?.state ?? 0) + 4096);
  }, 120_000);
});
