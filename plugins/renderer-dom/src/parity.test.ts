import {
  AlertCard,
  ApprovalCard,
  DataTable,
  MetricCard,
  ProgressBar,
  RendererRegistry,
  StatusBadge,
  StreamingText,
  Timeline,
  blueprint$,
  builtinCatalog,
  catalogCoverage,
  grid,
  stack,
} from "@loom/blueprint-runtime";
import { BlueprintRenderer, defaultRegistry as reactRegistry } from "@loom/plugin-renderer-react";
import { defaultTerminalRegistry, renderBlueprintToString } from "@loom/plugin-renderer-terminal";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDomRegistry } from "./defaultRegistry";
import { renderBlueprintToDom } from "./renderBlueprint";

// The three first-party surfaces over one Blueprint IR must handle the same vocabulary. A kind
// added to the catalogue and rendered by two of them, or a kind one registers that another
// does not, is the drift this fails on (ADR 0088: does each surface cover the catalogue?).

afterEach(cleanup);

// The React surface reads a ProjectionRuntime, so seed one with the same state map the DOM and
// terminal surfaces render from; `renderReact` returns the text the viewer would read.
function renderReact(
  blueprint: Parameters<typeof renderBlueprintToDom>[0],
  state: Map<string, unknown>,
  check?: Parameters<typeof renderBlueprintToDom>[2] extends infer O
    ? O extends { check?: infer C }
      ? C
      : never
    : never
): HTMLElement {
  const rt = new InMemoryProjectionRuntime();
  for (const [id, initialState] of state) rt.register({ id, initialState, handlers: {} });
  return render(
    createElement(BlueprintRenderer, {
      blueprint,
      projectionRuntime: rt,
      executionId: "parity",
      ...(check !== undefined && { check }),
    })
  ).container;
}

const kinds = (r: RendererRegistry<unknown>) => [...r.kinds()].sort();

describe("renderer parity: dom / react / terminal", () => {
  it("each covers the whole built-in catalogue", () => {
    for (const registry of [defaultDomRegistry, reactRegistry, defaultTerminalRegistry]) {
      expect(
        catalogCoverage(builtinCatalog, registry as RendererRegistry<unknown>).missing
      ).toEqual([]);
    }
  });

  it("registers exactly the same set of kinds", () => {
    const expected = builtinCatalog.entries.map((e) => e.kind).sort();
    expect(kinds(defaultDomRegistry)).toEqual(expected);
    expect(kinds(reactRegistry as RendererRegistry<unknown>)).toEqual(expected);
    expect(kinds(defaultTerminalRegistry)).toEqual(expected);
  });

  it("the coverage check can fail (negative)", () => {
    const partial = new RendererRegistry().register("MetricCard", () => null);
    expect(catalogCoverage(builtinCatalog, partial).ok).toBe(false);
  });

  it("the same blueprint shows the same facts on the DOM and terminal surfaces", () => {
    const b = (path: string) => ({ projectionId: "p", path });
    const blueprint = blueprint$({
      id: "parity",
      title: "Parity",
      layout: stack({
        children: [
          MetricCard({ id: "m", title: "CPU", binding: b("cpu"), unit: "%" }),
          grid({
            columns: 2,
            title: "Health",
            children: [
              StatusBadge({ id: "s", title: "Phase", binding: b("phase") }),
              ProgressBar({ id: "pr", title: "Pool", binding: b("pool"), max: 50 }),
            ],
          }),
          Timeline({ id: "t", title: "Events", binding: b("events") }),
          DataTable({ id: "d", title: "Rows", binding: b("rows"), columns: ["a"] }),
          AlertCard({ id: "a", title: "Lag", binding: b("alert") }),
          ApprovalCard({ id: "ap", title: "Fix", binding: b("pending") }),
          StreamingText({ id: "st", title: "Answer", binding: b("text") }),
        ],
      }),
      projections: ["p"],
    });
    const state = new Map<string, unknown>([
      [
        "p",
        {
          cpu: 87,
          phase: "running",
          pool: 25,
          events: [{ message: "boot" }],
          rows: [{ a: "row-one" }],
          alert: "replica lag",
          pending: true,
          text: "hello",
        },
      ],
    ]);
    const dom = renderBlueprintToDom(blueprint, state).textContent ?? "";
    const term = renderBlueprintToString(blueprint, state, { registry: defaultTerminalRegistry });
    const react = renderReact(blueprint, state).textContent ?? "";
    for (const fact of [
      "Parity",
      "Health",
      "87",
      "running",
      "boot",
      "row-one",
      "replica lag",
      "hello",
      "Fix",
    ]) {
      expect(term, `terminal shows ${fact}`).toContain(fact);
      expect(dom, `dom shows ${fact}`).toContain(fact);
      expect(react, `react shows ${fact}`).toContain(fact);
    }
  });
});

// ADR 0127: the status matrix is ONE decision (`describeWidgetStatus`) drawn three ways. Every
// status must put its marker, its label and its message on all three surfaces.
describe("renderer parity: the status matrix on dom / react / terminal", () => {
  const widget = MetricCard({
    id: "m",
    title: "CPU",
    binding: { projectionId: "p", path: "v", status: { path: "s" } },
  });
  const blueprint = blueprint$({
    id: "matrix",
    title: "Matrix",
    layout: stack({ children: [widget] }),
    projections: ["p"],
  });
  const finding = (message: string) => ({ code: "c", message });
  // glyph per surface: the terminal's loading row is `⋯ title` (its own, pre-existing form).
  const cases: {
    name: string;
    state: Record<string, unknown>;
    marker: string;
    glyph: { dom: string; react: string; term: string };
    texts: string[];
  }[] = [
    {
      name: "error",
      state: { v: 5, s: { state: "error", finding: finding("tool down") } },
      marker: "error",
      glyph: { dom: "✗", react: "✗", term: "✗" },
      texts: ["CPU", "tool down"],
    },
    {
      name: "empty",
      state: { v: 5, s: { state: "empty", finding: finding("nothing yet") } },
      marker: "empty",
      glyph: { dom: "○", react: "○", term: "○" },
      texts: ["CPU", "nothing yet"],
    },
    {
      name: "stale (no value)",
      state: { s: { state: "stale", finding: finding("drifted") } },
      marker: "stale",
      glyph: { dom: "~", react: "~", term: "~" },
      texts: ["CPU", "drifted"],
    },
    {
      name: "stale (with value)",
      state: { v: 5, s: { state: "stale" } },
      marker: "stale",
      glyph: { dom: "~", react: "~", term: "~" },
      texts: ["5"],
    },
    {
      name: "pending (with value)",
      state: { v: 5, s: { state: "pending" } },
      marker: "pending",
      glyph: { dom: "⋯", react: "⋯", term: "⋯" },
      texts: ["5"],
    },
    {
      name: "loading",
      state: { s: { state: "pending" } },
      marker: "loading",
      glyph: { dom: "…", react: "…", term: "⋯" },
      texts: [],
    },
    {
      name: "ready",
      state: { v: 5, s: { state: "ready" } },
      marker: "ready",
      glyph: { dom: "", react: "", term: "" },
      texts: ["5"],
    },
  ];

  for (const c of cases) {
    it(`${c.name}: the same marker and facts on every surface`, () => {
      const stateMap = new Map<string, unknown>([["p", c.state]]);
      const domHost = renderBlueprintToDom(blueprint, stateMap);
      const reactHost = renderReact(blueprint, stateMap);
      const term = renderBlueprintToString(blueprint, stateMap, {
        registry: defaultTerminalRegistry,
      });
      // The DOM and React surfaces tag the state itself.
      expect(
        domHost.querySelector("[data-binding-state]")?.getAttribute("data-binding-state")
      ).toBe(c.marker);
      expect(
        reactHost.querySelector("[data-binding-state]")?.getAttribute("data-binding-state")
      ).toBe(c.marker);
      expect(domHost.textContent).toContain(c.glyph.dom);
      expect(reactHost.textContent).toContain(c.glyph.react);
      expect(term).toContain(c.glyph.term);
      for (const t of c.texts) {
        expect(domHost.textContent, `dom ${t}`).toContain(t);
        expect(reactHost.textContent, `react ${t}`).toContain(t);
        expect(term, `terminal ${t}`).toContain(t);
      }
    });
  }

  it("a failing value-contract check is the error row on all three", () => {
    const stateMap = new Map<string, unknown>([["p", { v: 13, s: { state: "ready" } }]]);
    const check = (_w: unknown, v: unknown) =>
      v === 13 ? { code: "bad", message: "unlucky value" } : undefined;
    const dom = renderBlueprintToDom(blueprint, stateMap, { check }).textContent ?? "";
    const react = renderReact(blueprint, stateMap, check).textContent ?? "";
    const term = renderBlueprintToString(blueprint, stateMap, {
      registry: defaultTerminalRegistry,
      check,
    });
    for (const out of [dom, react, term]) {
      expect(out).toContain("✗ CPU: unlucky value");
    }
  });

  it("a malformed degradedFrom is the error placeholder on all three, with no leak", () => {
    const poisoned = blueprint$({
      id: "poisoned",
      title: "Poisoned",
      layout: stack({
        children: [
          {
            ...MetricCard({ id: "m", title: "CPU", binding: { projectionId: "p", path: "v" } }),
            source: { type: "x", version: "1", degradedFrom: "oops" },
          } as never,
        ],
      }),
      projections: ["p"],
    });
    const stateMap = new Map<string, unknown>([["p", { v: "SECRET-VALUE" }]]);
    const outs = [
      renderBlueprintToDom(poisoned, stateMap).textContent ?? "",
      renderReact(poisoned, stateMap).textContent ?? "",
      renderBlueprintToString(poisoned, stateMap, { registry: defaultTerminalRegistry }),
    ];
    for (const out of outs) {
      expect(out).toContain("[Renderer for MetricCard failed]");
      expect(out).not.toContain("SECRET-VALUE");
      expect(out).not.toContain("oops");
    }
  });
});
