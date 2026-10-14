import { MetricCard, blueprint$, stack } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { renderBlueprintToDom } from "./renderBlueprint";

// Characterisation (ADR 0127 residual): the DOM markup for every status state and combination,
// pinned BEFORE the marker decision moved into @loom/blueprint-runtime.

const f = (message: string) => ({ code: "c", message });
const degraded = [
  { type: "Trend", version: "2" },
  { type: "Spark", version: "1" },
];
// [name, state, hasStatusChannel, source, check]
const CASES: {
  name: string;
  state: Record<string, unknown>;
  channel?: boolean;
  source?: unknown;
  check?: boolean;
}[] = [
  { name: "inert, no source", state: { v: 5 }, channel: false },
  {
    name: "inert, source only",
    state: { v: 5 },
    channel: false,
    source: { type: "T", version: "1" },
  },
  {
    name: "inert, degraded",
    state: { v: 5 },
    channel: false,
    source: { type: "T", version: "1", degradedFrom: degraded },
  },
  { name: "error + value", state: { v: 5, s: { state: "error", finding: f("down") } } },
  { name: "error no finding", state: { s: { state: "error" } } },
  { name: "empty", state: { v: 5, s: { state: "empty", finding: f("none") } } },
  { name: "empty no finding", state: { s: { state: "empty" } } },
  { name: "stale + value", state: { v: 5, s: { state: "stale", finding: f("old") } } },
  { name: "stale no value", state: { s: { state: "stale", finding: f("old") } } },
  { name: "stale no finding no value", state: { s: { state: "stale" } } },
  { name: "pending + value", state: { v: 5, s: { state: "pending" } } },
  { name: "pending no value (loading)", state: { s: { state: "pending" } } },
  { name: "ready", state: { v: 5, s: { state: "ready" } } },
  { name: "status unwritten + value", state: { v: 5 } },
  { name: "status unwritten no value", state: {} },
  {
    name: "error outranks stale finding",
    state: { v: 5, s: { state: "error", finding: f("hard") } },
    check: true,
  },
  {
    name: "contract outranks stale",
    state: { v: 13, s: { state: "stale", finding: f("old") } },
    check: true,
  },
  { name: "contract outranks pending", state: { v: 13, s: { state: "pending" } }, check: true },
  { name: "contract skipped under empty", state: { v: 13, s: { state: "empty" } }, check: true },
  {
    name: "degraded + error",
    state: { v: 5, s: { state: "error", finding: f("down") } },
    source: { type: "T", version: "1", degradedFrom: degraded },
  },
  {
    name: "degraded + stale value",
    state: { v: 5, s: { state: "stale" } },
    source: { type: "T", version: "1", degradedFrom: degraded },
  },
  {
    name: "degraded + ready",
    state: { v: 5, s: { state: "ready" } },
    source: { type: "T", version: "1", degradedFrom: [degraded[0]] },
  },
  {
    name: "degraded empty list",
    state: { v: 5, s: { state: "ready" } },
    source: { type: "T", version: "1", degradedFrom: [] },
  },
  {
    name: "malformed degradedFrom",
    state: { v: 5, s: { state: "ready" } },
    source: { type: "T", version: "1", degradedFrom: "oops" },
  },
  {
    name: "redacted",
    state: { v: 5, s: { state: "error" } },
    source: { type: "redacted", version: "1", redacted: true },
  },
];
const check = (_w: unknown, v: unknown) =>
  v === 13 ? { code: "bad", message: "unlucky" } : undefined;
const bp = (c: (typeof CASES)[number]) => {
  const base = MetricCard({
    id: "m",
    title: "CPU",
    binding: {
      projectionId: "p",
      ...(c.channel === false ? { path: "v" } : { path: "v", status: { path: "s" } }),
    },
  });
  return blueprint$({
    id: "g",
    title: "Golden",
    layout: stack({
      children: [{ ...base, ...(c.source !== undefined && { source: c.source }) } as never],
    }),
    projections: ["p"],
  });
};
describe("dom status golden", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const host = renderBlueprintToDom(bp(c), new Map([["p", c.state]]), {
        ...(c.check && { check }),
      });
      expect(host.innerHTML).toMatchSnapshot();
    });
  }
});
