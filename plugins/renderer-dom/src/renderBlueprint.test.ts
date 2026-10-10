import {
  AlertCard,
  ApprovalCard,
  type Blueprint,
  DataTable,
  type Layout,
  MetricCard,
  ProgressBar,
  RendererRegistry,
  StatusBadge,
  StreamingText,
  Timeline,
  blueprint$,
  cell,
  customWidget$,
  grid,
  stack,
} from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { defaultDomRegistry } from "./defaultRegistry";
import { mountBlueprint, renderBlueprintToDom } from "./renderBlueprint";

const b = (path: string, projectionId = "p", status?: string) => ({
  projectionId,
  path,
  ...(status !== undefined && { status: { path: status } }),
});
const state = (o: Record<string, unknown>) => new Map<string, unknown>([["p", o]]);
const q = (el: Element, sel: string) => el.querySelector(sel) as HTMLElement;
const widget = (el: Element, id: string) => q(el, `[data-widget-id="${id}"]`);

const bp = (children: Layout["children"], extra: Partial<Layout> = {}, id = "bp"): Blueprint =>
  blueprint$({
    id,
    title: "T",
    layout: stack({ children: children as never, ...extra } as never),
    projections: ["p"],
  });

describe("renderBlueprintToDom — the eight built-in kinds", () => {
  it("renders every kind from state", () => {
    const blueprint = bp([
      MetricCard({ id: "m", title: "CPU", binding: b("cpu"), unit: "%" }),
      StatusBadge({ id: "s", title: "Phase", binding: b("phase") }),
      ProgressBar({ id: "pr", title: "Pool", binding: b("pool"), max: 50 }),
      Timeline({ id: "t", title: "Events", binding: b("events") }),
      DataTable({ id: "d", title: "Rows", binding: b("rows"), columns: ["a", "b"] }),
      AlertCard({ id: "a", title: "Lag", binding: b("alert"), severity: "critical" }),
      ApprovalCard({ id: "ap", title: "Fix", binding: b("pending") }),
      StreamingText({ id: "st", title: "Answer", binding: b("text") }),
    ]);
    const el = renderBlueprintToDom(
      blueprint,
      state({
        cpu: 87,
        phase: "running",
        pool: 25,
        events: [{ timestamp: 1, message: "boot", level: "info" }],
        rows: [{ a: 1, b: "x" }],
        alert: "replica lag",
        pending: true,
        text: "hello",
      })
    );
    expect(q(el, "h1").textContent).toBe("T");
    expect(widget(el, "m").textContent).toContain("87%");
    expect(q(widget(el, "s"), ".badge").textContent).toBe("running");
    expect(q(widget(el, "pr"), "progress").getAttribute("value")).toBe("25");
    expect(q(widget(el, "pr"), ".progress-value").textContent).toBe("25 / 50");
    expect(q(widget(el, "t"), ".timeline-msg").textContent).toBe("boot");
    expect([...widget(el, "d").querySelectorAll("th")].map((t) => t.textContent)).toEqual([
      "a",
      "b",
    ]);
    expect([...widget(el, "d").querySelectorAll("td")].map((t) => t.textContent)).toEqual([
      "1",
      "x",
    ]);
    expect(q(widget(el, "a"), ".alert").getAttribute("role")).toBe("alert");
    expect(widget(el, "ap").querySelectorAll("button")).toHaveLength(2);
    expect(q(widget(el, "st"), "pre").textContent).toBe("hello");
  });

  it("an unresolved ProgressBar is indeterminate, not 0%", () => {
    const el = renderBlueprintToDom(bp([ProgressBar({ id: "pr", binding: b("pool") })]), state({}));
    expect(q(el, "progress").hasAttribute("value")).toBe(false);
    expect(q(el, ".progress-value").textContent).toBe("—");
  });

  it("an unknown kind is a visible placeholder, never silent", () => {
    const custom = customWidget$({ kind: "Sparkline", id: "x", binding: b("v") });
    const el = renderBlueprintToDom(bp([custom as never]), state({ v: 1 }));
    expect(widget(el, "x").textContent).toBe("[No renderer for Sparkline]");
    expect(q(el, '[data-placeholder="missing"]')).not.toBeNull();
  });

  it("a registered custom kind renders; a throwing renderer is contained and its message not shown", () => {
    const registry = defaultDomRegistry.merge(
      new RendererRegistry()
        .register("Boom", () => {
          throw new Error("secret internals");
        })
        .register("Spark", ({ doc, value }) => {
          const d = doc.createElement("div");
          d.textContent = `spark ${String(value)}`;
          return d;
        })
    );
    const blueprint = bp([
      customWidget$({ kind: "Boom", id: "boom", binding: b("v") }) as never,
      customWidget$({ kind: "Spark", id: "spark", binding: b("v") }) as never,
      MetricCard({ id: "ok", binding: b("v") }),
    ]);
    const el = renderBlueprintToDom(blueprint, state({ v: 3 }), { registry });
    expect(widget(el, "boom").textContent).toBe("[Renderer for Boom failed]");
    expect(widget(el, "boom").textContent).not.toContain("secret");
    expect(widget(el, "spark").textContent).toBe("spark 3");
    expect(widget(el, "ok").textContent).toContain("3");
  });
});

describe("binding status matrix (canonical, as React and terminal)", () => {
  const w = MetricCard({ id: "m", title: "CPU", binding: b("cpu", "p", "st") });
  const NONE = Symbol("no value");
  const draw = (s: unknown, cpu: unknown = 5) =>
    widget(renderBlueprintToDom(bp([w]), state({ ...(cpu !== NONE && { cpu }), st: s })), "m");

  it("error replaces the body with an alert", () => {
    const el = draw({ state: "error", finding: { code: "x", message: "db down" } });
    expect(el.getAttribute("data-binding-state")).toBe("error");
    expect(q(el, '[role="alert"]').textContent).toBe("✗ CPU: db down");
    expect(el.textContent).not.toContain("5");
  });
  it("empty is a polite status, not an alert, and ignores the value", () => {
    const el = draw({ state: "empty" });
    expect(q(el, '[data-binding-marker="empty"]').getAttribute("role")).toBe("status");
    expect(el.textContent).toBe("○ CPU: no data");
  });
  it("stale keeps the value with a marker; stale with no value says so", () => {
    expect(q(draw({ state: "stale" }), '[data-binding-marker="stale"]').textContent).toBe("~");
    expect(draw({ state: "stale" }).textContent).toContain("5");
    expect(draw({ state: "stale" }, NONE).textContent).toContain("no value");
  });
  it("pending shows a marker beside a value, and loading when there is none", () => {
    expect(q(draw({ state: "pending" }), '[data-binding-marker="pending"]')).not.toBeNull();
    expect(q(draw({ state: "pending" }, NONE), '[data-binding-marker="loading"]')).not.toBeNull();
  });
  it("the value-contract check outranks stale/ready but not error", () => {
    const check = () => ({ code: "bad", message: "wrong shape" });
    const el = widget(
      renderBlueprintToDom(bp([w]), state({ cpu: 5, st: { state: "ready" } }), { check }),
      "m"
    );
    expect(el.textContent).toBe("✗ CPU: wrong shape");
  });
  it("a widget with no channel and no source gets no frame attributes", () => {
    const el = widget(
      renderBlueprintToDom(bp([MetricCard({ id: "m", binding: b("cpu") })]), state({ cpu: 1 })),
      "m"
    );
    expect(el.hasAttribute("data-binding-state")).toBe(false);
    expect(el.hasAttribute("title")).toBe(false);
  });
});

describe("layout", () => {
  it("a titled container is a labelled section with an h2; the heading is not a grid item", () => {
    const el = renderBlueprintToDom(
      bp([MetricCard({ id: "m", binding: b("v") })], { title: "Vitals" }),
      state({})
    );
    const section = q(el, "section");
    expect(section.getAttribute("aria-label")).toBe("Vitals");
    expect(q(section, "h2").textContent).toBe("Vitals");
  });

  it("grid columns, gap and cell placement land as CSS", () => {
    const blueprint = blueprint$({
      id: "g",
      title: "G",
      layout: grid({
        columns: 3,
        gap: 8,
        children: [
          cell(2, MetricCard({ id: "a", binding: b("v") })),
          cell(1, MetricCard({ id: "c", binding: b("v") }), { row: 2, column: 1 }),
          MetricCard({ id: "d", binding: b("v") }),
        ],
      }),
      projections: ["p"],
    });
    const el = renderBlueprintToDom(blueprint, state({}));
    const body = q(el, '[data-layout="grid"]');
    expect(body.style.getPropertyValue("grid-template-columns")).toBe("repeat(3, 1fr)");
    expect(body.style.getPropertyValue("gap")).toBe("8px");
    expect(widget(el, "a").style.getPropertyValue("grid-column")).toBe("span 2");
    expect(widget(el, "c").style.getPropertyValue("grid-row")).toBe("2 / span 1");
    expect(widget(el, "c").style.getPropertyValue("grid-column")).toBe("1 / span 1");
    expect(widget(el, "d").style.getPropertyValue("grid-column")).toBe("");
  });

  it("hostile layout numbers never reach CSS", () => {
    const blueprint = blueprint$({
      id: "g",
      title: "G",
      layout: grid({
        columns: "1fr; background:url(//evil)" as never,
        gap: "9px;x" as never,
        children: [],
      }),
      projections: [],
    });
    const body = q(renderBlueprintToDom(blueprint, state({})), '[data-layout="grid"]');
    expect(body.style.getPropertyValue("grid-template-columns")).toBe("repeat(1, 1fr)");
    expect(body.style.getPropertyValue("gap")).toBe("");
    expect(body.getAttribute("style")).not.toContain("evil");
  });

  it('title: "none" mounts no h1', () => {
    expect(
      renderBlueprintToDom(bp([]), state({}), { title: "none" }).querySelector("h1")
    ).toBeNull();
  });

  it("a layout role is ignored: the DOM is the plain container's", () => {
    const withRole = renderBlueprintToDom(
      bp([MetricCard({ id: "m", binding: b("v") })], { role: "tabbed" }),
      state({})
    );
    const plain = renderBlueprintToDom(bp([MetricCard({ id: "m", binding: b("v") })]), state({}));
    expect(withRole.innerHTML).toBe(plain.innerHTML);
  });
});

describe("actions", () => {
  it("routes an approval click to onAction with widgetId and payload", () => {
    const seen: unknown[] = [];
    const el = renderBlueprintToDom(
      bp([ApprovalCard({ id: "ap", binding: b("pending") })]),
      state({ pending: true }),
      { onAction: (a) => seen.push(a) }
    );
    const [approve, reject] = [...el.querySelectorAll("button")];
    approve?.click();
    reject?.click();
    expect(seen).toEqual([
      { type: "APPROVE", widgetId: "ap", payload: { approved: true } },
      { type: "REJECT", widgetId: "ap", payload: { approved: false } },
    ]);
  });

  it("a disposed widget's late click is dropped", () => {
    const host = document.createElement("div");
    const rt = new InMemoryProjectionRuntime();
    rt.register({ id: "p", initialState: { pending: true }, handlers: {} });
    const seen: unknown[] = [];
    const h = mountBlueprint(host, bp([ApprovalCard({ id: "ap", binding: b("pending") })]), {
      projectionRuntime: rt,
      executionId: "e",
      onAction: (a) => seen.push(a),
    });
    const button = h.element.querySelector("button") as HTMLElement;
    h.dispose();
    button.click();
    expect(seen).toEqual([]);
    expect(host.children).toHaveLength(0);
  });
});

describe("mountBlueprint — live", () => {
  const setup = () => {
    const rt = new InMemoryProjectionRuntime();
    rt.register({
      id: "p",
      initialState: { cpu: 42, other: 1 } as Record<string, unknown>,
      handlers: {
        SET: (s: Record<string, unknown>, e) => ({ ...s, ...(e.payload as object) }),
      },
    });
    const emit = (payload: object, sequence = 1) =>
      rt.handleEvent({
        id: `e${sequence}`,
        workflowId: "f",
        executionId: "e",
        eventType: "SET",
        sequence,
        timestamp: 0,
        payload,
      } as never);
    return { rt, emit };
  };
  const live = [
    MetricCard({ id: "cpu", binding: b("cpu") }),
    MetricCard({ id: "other", binding: b("other") }),
  ];

  it("re-draws only the widget whose value changed", () => {
    const { rt, emit } = setup();
    const host = document.createElement("div");
    const h = mountBlueprint(host, bp(live), { projectionRuntime: rt, executionId: "e" });
    const cpuHost = widget(h.element, "cpu");
    const otherBody = q(widget(h.element, "other"), ".metric-value");
    expect(cpuHost.textContent).toContain("42");
    emit({ cpu: 95 });
    expect(widget(h.element, "cpu")).toBe(cpuHost); // the host node is reused
    expect(cpuHost.textContent).toContain("95");
    expect(q(widget(h.element, "other"), ".metric-value")).toBe(otherBody); // untouched: not re-drawn
    h.dispose();
  });

  it("stops listening after dispose", () => {
    const { rt, emit } = setup();
    const host = document.createElement("div");
    const h = mountBlueprint(host, bp(live), { projectionRuntime: rt, executionId: "e" });
    const cpuHost = widget(h.element, "cpu");
    h.dispose();
    emit({ cpu: 1 });
    expect(cpuHost.textContent).toContain("42");
    expect(host.children).toHaveLength(0);
  });

  it("a projection the blueprint declares but nobody registered is a visible note, not a throw", () => {
    const { rt } = setup();
    const missing = blueprint$({
      id: "x",
      title: "X",
      layout: stack({ children: [MetricCard({ id: "m", binding: b("v", "ghost") })] }),
      projections: ["ghost"],
    });
    const h = mountBlueprint(document.createElement("div"), missing, {
      projectionRuntime: rt,
      executionId: "e",
    });
    expect(q(h.element, '[data-placeholder="projection"]').textContent).toBe(
      "[Projection ghost is not registered]"
    );
    expect(q(h.element, "[data-binding-marker]")).toBeNull();
    h.dispose();
  });

  describe("update(next) — incremental", () => {
    it("keeps every node whose id and kind survive, including across a reorder and an insert", () => {
      const { rt } = setup();
      const host = document.createElement("div");
      const h = mountBlueprint(host, bp(live, {}, "v1"), {
        projectionRuntime: rt,
        executionId: "e",
      });
      const cpu = widget(h.element, "cpu");
      const other = widget(h.element, "other");
      const added = MetricCard({ id: "new", binding: b("cpu") });
      const report = h.update(bp([live[1] as never, added, live[0] as never], {}, "v2"));
      expect(report.remounted).toEqual([]);
      expect(widget(h.element, "cpu")).toBe(cpu);
      expect(widget(h.element, "other")).toBe(other);
      expect(h.element.getAttribute("data-blueprint-id")).toBe("v2");
      expect(
        [...h.element.querySelectorAll("[data-widget-id]")].map((e) =>
          e.getAttribute("data-widget-id")
        )
      ).toEqual(["other", "new", "cpu"]);
      h.dispose();
    });

    it("removes a widget that left, and stops delivering to it", () => {
      const { rt, emit } = setup();
      const h = mountBlueprint(document.createElement("div"), bp(live), {
        projectionRuntime: rt,
        executionId: "e",
      });
      const other = widget(h.element, "other");
      h.update(bp([live[0] as never]));
      expect(widget(h.element, "other")).toBeNull();
      emit({ other: 7 });
      expect(other.textContent).not.toContain("7");
      h.dispose();
    });

    it("a changed widget prop re-draws in place; a changed kind remounts and says so", () => {
      const { rt } = setup();
      const h = mountBlueprint(
        document.createElement("div"),
        bp([MetricCard({ id: "m", binding: b("cpu"), unit: "%" })]),
        {
          projectionRuntime: rt,
          executionId: "e",
        }
      );
      const host = widget(h.element, "m");
      expect(host.textContent).toContain("%");
      const r1 = h.update(bp([MetricCard({ id: "m", binding: b("cpu"), unit: "ms" })]));
      expect(widget(h.element, "m")).toBe(host);
      expect(host.textContent).toContain("ms");
      expect(r1.remounted).toEqual([]);
      const r2 = h.update(bp([StatusBadge({ id: "m", binding: b("cpu") })]));
      expect(widget(h.element, "m")).not.toBe(host);
      expect(r2.remounted).toEqual(["m"]);
      h.dispose();
    });

    it("keeps an id'd container's widgets when a container is inserted before it", () => {
      const { rt } = setup();
      const inner = (id: string, wid: string): Layout =>
        stack({ id, children: [MetricCard({ id: wid, binding: b("cpu") })] });
      const h = mountBlueprint(document.createElement("div"), bp([inner("c1", "w1")]), {
        projectionRuntime: rt,
        executionId: "e",
      });
      const w1 = widget(h.element, "w1");
      const report = h.update(bp([inner("c0", "w0"), inner("c1", "w1")]));
      expect(widget(h.element, "w1")).toBe(w1);
      expect(report.remounted).toEqual([]);
      h.dispose();
    });

    it("a new projection is subscribed; a dropped one is not", () => {
      const { rt } = setup();
      rt.register({
        id: "q",
        initialState: { n: 1 },
        handlers: { SET: (s: object, e) => ({ ...s, ...(e.payload as object) }) },
      });
      const h = mountBlueprint(document.createElement("div"), bp(live), {
        projectionRuntime: rt,
        executionId: "e",
      });
      h.update(
        blueprint$({
          id: "v2",
          title: "T",
          layout: stack({ children: [MetricCard({ id: "n", binding: b("n", "q") })] }),
          projections: ["q"],
        })
      );
      expect(widget(h.element, "n").textContent).toContain("1");
      rt.handleEvent({
        id: "e9",
        workflowId: "f",
        executionId: "e",
        eventType: "SET",
        sequence: 9,
        timestamp: 0,
        payload: { n: 2 },
      } as never);
      expect(widget(h.element, "n").textContent).toContain("2");
      h.dispose();
    });

    it("never throws on a malformed revision, and a disposed handle refuses", () => {
      const { rt } = setup();
      const h = mountBlueprint(document.createElement("div"), bp(live), {
        projectionRuntime: rt,
        executionId: "e",
      });
      expect(() =>
        h.update({ _tag: "Blueprint", id: "z", title: "Z", layout: null, projections: [] } as never)
      ).not.toThrow();
      h.dispose();
      expect(h.update(bp(live)).remounted).toEqual([]);
    });
  });
});
