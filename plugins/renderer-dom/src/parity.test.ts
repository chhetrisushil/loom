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
import { mountBlueprint, renderBlueprintToDom } from "./renderBlueprint";

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
  // IR 2.5.0 (ADR 0097 amendment): a widget redacted for the surface's audience draws ONE constant
  // marker on every surface. The input is deliberately hostile — the title, props, binding, value,
  // finding, kind and degrade chain all carry would-be-sensitive text — to prove the render path
  // never reads them, whatever a (non-validating) caller hands it.
  describe("redacted (IR 2.5.0)", () => {
    const hostile = {
      ...MetricCard({
        id: "r_1",
        title: "SECRET-TITLE",
        binding: { projectionId: "p", path: "v", status: { path: "s" } },
      }),
      kind: "SECRETKIND",
      props: { unit: "SECRET-PROP" },
      source: {
        type: "SECRET-TYPE",
        version: "SECRET-VER",
        redacted: true,
        degradedFrom: [{ type: "SECRET-FROM", version: "9" }],
      },
    } as never;
    const clean = {
      _tag: "Widget",
      id: "r_2",
      kind: "StatusBadge",
      props: {},
      source: { type: "redacted", version: "1", redacted: true },
    } as never;
    const bp = (w: never) =>
      blueprint$({
        id: "red",
        title: "Red",
        layout: stack({ children: [w] }),
        projections: ["p"],
      });
    const stateMap = new Map<string, unknown>([
      [
        "p",
        {
          v: "SECRET-VALUE",
          s: { state: "error", finding: { code: "c", message: "SECRET-FINDING" } },
        },
      ],
    ]);

    for (const [name, w] of [
      ["a hostile input", hostile],
      ["the clean placeholder", clean],
    ] as const) {
      it(`${name}: the same marker, and nothing of the widget, on all three`, () => {
        const check = () => ({ code: "x", message: "SECRET-CHECK" });
        const dom = renderBlueprintToDom(bp(w), stateMap, { check });
        const react = renderReact(bp(w), stateMap, check);
        const term = renderBlueprintToString(bp(w), stateMap, {
          registry: defaultTerminalRegistry,
          check,
        });
        for (const host of [dom, react]) {
          expect(
            host.querySelector("[data-binding-state]")?.getAttribute("data-binding-state")
          ).toBe("redacted");
          expect(host.querySelector('[data-binding-marker="redacted"]')?.textContent).toBe(
            "⊘ redacted"
          );
          expect(host.innerHTML).not.toMatch(
            /SECRET|data-source|data-degraded|data-widget-kind|title=/
          );
        }
        expect(term).toContain("⊘ redacted");
        expect(term).not.toMatch(/SECRET/);
        // The marker is the whole widget: no body, no label on any surface.
        expect(dom.textContent).toContain("⊘ redacted");
        expect(dom.textContent).not.toMatch(/SECRET|CPU/);
      });
    }

    // The UPDATE path: an ordinary widget carrying real content, revised in place to a redacted
    // one with the same id. Nothing of the first draw (attributes included) may survive.
    const ordinary = {
      ...MetricCard({
        id: "r_1",
        title: "SECRET-TITLE",
        binding: { projectionId: "p", path: "v", status: { path: "s" } },
      }),
      kind: "StatusBadge",
      props: { unit: "SECRET-PROP" },
      source: {
        type: "SECRET-TYPE",
        version: "SECRET-VER",
        degradedFrom: [{ type: "SECRET-FROM", version: "9" }],
      },
    } as never;
    const redactedSame = {
      _tag: "Widget",
      id: "r_1",
      kind: "StatusBadge",
      props: {},
      source: { type: "redacted", version: "1", redacted: true },
    } as never;

    it("dom update(): ordinary -> redacted strips every attribute and node of the first draw", () => {
      const rt = new InMemoryProjectionRuntime();
      rt.register({ id: "p", initialState: { v: "SECRET-VALUE" }, handlers: {} });
      const h = mountBlueprint(document.createElement("div"), bp(ordinary), {
        projectionRuntime: rt,
        executionId: "e",
      });
      const before = h.element.innerHTML;
      expect(before).toMatch(/SECRET/);
      expect(before).toContain("data-source-type");
      h.update(bp(redactedSame));
      expect(h.element.innerHTML).not.toMatch(
        /SECRET|data-source|data-degraded|data-widget-kind|title=/
      );
      expect(h.element.querySelector('[data-binding-marker="redacted"]')?.textContent).toBe(
        "⊘ redacted"
      );
      h.dispose();
    });

    it("react rerender: ordinary -> redacted leaves nothing of the first draw", () => {
      const rt = new InMemoryProjectionRuntime();
      rt.register({ id: "p", initialState: { v: "SECRET-VALUE" }, handlers: {} });
      const el = (b: ReturnType<typeof bp>) =>
        createElement(BlueprintRenderer, {
          blueprint: b,
          projectionRuntime: rt,
          executionId: "e",
        });
      const r = render(el(bp(ordinary)));
      expect(r.container.innerHTML).toMatch(/SECRET/);
      r.rerender(el(bp(redactedSame)));
      expect(r.container.innerHTML).not.toMatch(/SECRET|data-source|data-degraded|title=/);
      expect(r.container.querySelector('[data-binding-marker="redacted"]')?.textContent).toBe(
        "⊘ redacted"
      );
    });

    it("redacted: false is an ordinary widget on all three", () => {
      const w = {
        ...(clean as object),
        source: { type: "t", version: "1", redacted: false },
      } as never;
      const t = renderBlueprintToString(bp(w), new Map(), { registry: defaultTerminalRegistry });
      expect(t).not.toContain("⊘");
    });
  });
});

// State-level parity (ADR 0127 residual): for each status, the DOM, React and terminal surfaces
// expose the same FACTS for the same Blueprint — the state, the marker, its role semantics and the
// degraded-from chain — against a hand-written table, not against the shared decision itself, so
// a surface that drifts from the matrix (or a shared change nobody meant) fails here.
describe("renderer parity: state-level facts on dom / react / terminal", () => {
  const f = (message: string) => ({ code: "c", message });
  const chain = [
    { type: "Trend", version: "2" },
    { type: "Spark", version: "1" },
  ];
  const make = (source?: unknown) =>
    blueprint$({
      id: "facts",
      title: "Facts",
      layout: stack({
        children: [
          {
            ...MetricCard({
              id: "m",
              title: "CPU",
              binding: { projectionId: "p", path: "v", status: { path: "s" } },
            }),
            ...(source !== undefined && { source }),
          } as never,
        ],
      }),
      projections: ["p"],
    });
  const check = (_w: unknown, v: unknown) =>
    v === 13 ? { code: "bad", message: "unlucky" } : undefined;
  const rows: {
    name: string;
    state: Record<string, unknown>;
    source?: unknown;
    check?: boolean;
    expect: {
      state: string;
      marker: string | null;
      role: string | null;
      degraded: string | null;
    };
  }[] = [
    {
      name: "error",
      state: { v: 5, s: { state: "error", finding: f("x") } },
      expect: { state: "error", marker: "error", role: "alert", degraded: null },
    },
    {
      name: "empty",
      state: { s: { state: "empty" } },
      expect: { state: "empty", marker: "empty", role: "status", degraded: null },
    },
    {
      name: "stale+value",
      state: { v: 5, s: { state: "stale" } },
      expect: { state: "stale", marker: "stale", role: null, degraded: null },
    },
    {
      name: "stale, no value",
      state: { s: { state: "stale" } },
      expect: { state: "stale", marker: "stale", role: null, degraded: null },
    },
    {
      name: "pending",
      state: { v: 5, s: { state: "pending" } },
      expect: { state: "pending", marker: "pending", role: null, degraded: null },
    },
    {
      name: "loading",
      state: { s: { state: "pending" } },
      expect: { state: "loading", marker: "loading", role: null, degraded: null },
    },
    {
      name: "ready",
      state: { v: 5, s: { state: "ready" } },
      expect: { state: "ready", marker: null, role: null, degraded: null },
    },
    {
      name: "contract outranks stale",
      state: { v: 13, s: { state: "stale" } },
      check: true,
      expect: { state: "error", marker: "error", role: "alert", degraded: null },
    },
    {
      name: "error outranks the contract check",
      state: { v: 13, s: { state: "error" } },
      check: true,
      expect: { state: "error", marker: "error", role: "alert", degraded: null },
    },
    {
      name: "empty outranks the contract check",
      state: { v: 13, s: { state: "empty" } },
      check: true,
      expect: { state: "empty", marker: "empty", role: "status", degraded: null },
    },
    {
      name: "degraded chain + error",
      state: { v: 5, s: { state: "error" } },
      source: { type: "T", version: "1", degradedFrom: chain },
      expect: { state: "error", marker: "error", role: "alert", degraded: "Trend@2 › Spark@1" },
    },
    {
      name: "degraded chain + ready",
      state: { v: 5, s: { state: "ready" } },
      source: { type: "T", version: "1", degradedFrom: chain },
      expect: { state: "ready", marker: null, role: null, degraded: "Trend@2 › Spark@1" },
    },
  ];
  for (const r of rows) {
    it(r.name, () => {
      const bp = make(r.source);
      const stateMap = new Map<string, unknown>([["p", r.state]]);
      const opts = r.check ? { check } : {};
      for (const [surface, host] of [
        ["dom", renderBlueprintToDom(bp, stateMap, opts)],
        ["react", renderReact(bp, stateMap, r.check ? check : undefined)],
      ] as const) {
        const frame = host.querySelector("[data-binding-state]");
        expect(frame?.getAttribute("data-binding-state"), `${surface} state`).toBe(r.expect.state);
        const m = host.querySelector("[data-binding-marker]");
        expect(m?.getAttribute("data-binding-marker") ?? null, `${surface} marker`).toBe(
          r.expect.marker
        );
        expect(m?.getAttribute("role") ?? null, `${surface} role`).toBe(r.expect.role);
        expect(frame?.getAttribute("data-degraded") ?? null, `${surface} degraded`).toBe(
          r.expect.degraded
        );
      }
      const term = renderBlueprintToString(bp, stateMap, {
        registry: defaultTerminalRegistry,
        ...opts,
      });
      // The terminal has no attributes: its facts are the glyph (state) and the chain suffix.
      const glyph: Record<string, string | undefined> = {
        error: "✗",
        empty: "○",
        stale: "~",
        pending: "⋯",
        loading: "⋯",
      };
      const g = glyph[r.expect.state];
      // Anchored to the line start: a bare `~`/`⋯` anywhere would let two glyphs swap unnoticed.
      if (g !== undefined) expect(term, "terminal glyph").toMatch(new RegExp(`^\\s*${g} `, "m"));
      else expect(term, "terminal ready has no marker").not.toMatch(/[✗○~⋯]/);
      if (r.expect.degraded === null) expect(term).not.toContain("degraded from");
      else expect(term).toContain(`(degraded from ${r.expect.degraded})`);
    });
  }
});
