import { describe, expect, it } from "vitest";
import {
  buildScoreboard,
  compareAgainstBaseline,
  parseScoreboard,
  regressions,
  renderDeltas,
  renderScoreboardMarkdown,
  round4,
  serializeScoreboard,
} from "./scoreboard";

describe("cost metrics (lowerIsBetter)", () => {
  const cost = (v: number) =>
    buildScoreboard([
      { key: "a/y/meanSteps", value: v, gated: true, lowerIsBetter: true },
      { key: "a/y/mrr", value: 0.5, gated: true },
    ]);

  it("a RISE is the regression and a fall is an improvement", () => {
    const up = compareAgainstBaseline(cost(3), cost(2));
    expect(up.find((d) => d.key === "a/y/meanSteps")?.status).toBe("regressed");
    expect(regressions(up).map((d) => d.key)).toEqual(["a/y/meanSteps"]);
    const down = compareAgainstBaseline(cost(1), cost(2));
    expect(down.find((d) => d.key === "a/y/meanSteps")?.status).toBe("improved");
    expect(regressions(down)).toEqual([]);
  });

  it("only cost rows carry the flag, so every other row serialises exactly as before", () => {
    const json = serializeScoreboard(cost(2));
    expect(json).toContain('"lowerIsBetter": true');
    expect(json.match(/lowerIsBetter/g)).toHaveLength(1);
  });
});

const rows = [
  { key: "b/x/recall@5", value: 0.91234567, gated: true },
  { key: "a/y/mrr", value: 0.5, gated: true },
  { key: "a/y/extra", value: 0.25, gated: false },
];

describe("scoreboard build / serialise", () => {
  it("sorts keys, rounds to 4 dp and is byte-stable regardless of input order", () => {
    const a = serializeScoreboard(buildScoreboard(rows));
    const b = serializeScoreboard(buildScoreboard([...rows].reverse()));
    expect(a).toBe(b);
    expect(Object.keys(buildScoreboard(rows).metrics)).toEqual([
      "a/y/extra",
      "a/y/mrr",
      "b/x/recall@5",
    ]);
    expect(buildScoreboard(rows).metrics["b/x/recall@5"]?.value).toBe(0.9123);
    expect(a.endsWith("\n")).toBe(true);
  });
  it("carries no timestamps or paths", () => {
    const text = serializeScoreboard(buildScoreboard(rows));
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(text).not.toMatch(/\/Users\/|\/home\/|[A-Z]:\\/);
  });
  it("round-trips through parse", () => {
    const sb = buildScoreboard(rows);
    expect(parseScoreboard(serializeScoreboard(sb))).toEqual(sb);
  });
  it("refuses a duplicate key and a non-finite value", () => {
    expect(() => buildScoreboard([rows[0] as never, rows[0] as never])).toThrow(/duplicate/);
    expect(() => buildScoreboard([{ key: "k", value: Number.NaN, gated: true }])).toThrow(
      /not finite/
    );
  });
  it("round4 rounds half up at the fourth decimal", () => {
    expect(round4(0.12345)).toBe(0.1235);
    expect(round4(1 / 3)).toBe(0.3333);
  });
  it("renders markdown with one row per metric", () => {
    const md = renderScoreboardMarkdown(buildScoreboard(rows));
    expect(md).toContain("| `a/y/mrr` | 0.5000 | yes |");
    expect(md).toContain("| `a/y/extra` | 0.2500 | no |");
  });
});

describe("compareAgainstBaseline", () => {
  const baseline = buildScoreboard(rows);

  it("reports no change for identical boards", () => {
    const deltas = compareAgainstBaseline(baseline, baseline);
    expect(deltas.every((d) => d.status === "unchanged")).toBe(true);
    expect(renderDeltas(deltas)).toBe("No change against the baseline.\n");
  });

  it("changing ONE score names exactly that metric, with the delta", () => {
    const changed = buildScoreboard(
      rows.map((r) => (r.key === "a/y/mrr" ? { ...r, value: 0.4 } : r))
    );
    const deltas = compareAgainstBaseline(changed, baseline);
    const moved = deltas.filter((d) => d.status !== "unchanged");
    expect(moved.map((d) => d.key)).toEqual(["a/y/mrr"]);
    expect(moved[0]).toMatchObject({
      status: "regressed",
      baseline: 0.5,
      current: 0.4,
      delta: -0.1,
    });
    expect(regressions(deltas).map((d) => d.key)).toEqual(["a/y/mrr"]);
    expect(renderDeltas(deltas)).toContain("`a/y/mrr`");
    expect(renderDeltas(deltas)).not.toContain("`b/x/recall@5`");
  });

  it("an improvement is reported but is not a regression", () => {
    const better = buildScoreboard(
      rows.map((r) => (r.key === "a/y/mrr" ? { ...r, value: 0.6 } : r))
    );
    const deltas = compareAgainstBaseline(better, baseline);
    expect(deltas.find((d) => d.key === "a/y/mrr")?.status).toBe("improved");
    expect(regressions(deltas)).toEqual([]);
  });

  it("a fall in a report-only metric is shown but never fails the run", () => {
    const lower = buildScoreboard(
      rows.map((r) => (r.key === "a/y/extra" ? { ...r, value: 0 } : r))
    );
    const deltas = compareAgainstBaseline(lower, baseline);
    expect(deltas.find((d) => d.key === "a/y/extra")?.status).toBe("regressed");
    expect(regressions(deltas)).toEqual([]);
  });

  it("a metric missing from the run is not-run, and a new one is new", () => {
    const partial = buildScoreboard([
      ...rows.slice(1),
      { key: "c/z/hit@1", value: 1, gated: true },
    ]);
    const deltas = compareAgainstBaseline(partial, baseline);
    expect(deltas.find((d) => d.key === "b/x/recall@5")?.status).toBe("not-run");
    expect(deltas.find((d) => d.key === "c/z/hit@1")?.status).toBe("new");
    expect(regressions(deltas)).toEqual([]);
  });
});
