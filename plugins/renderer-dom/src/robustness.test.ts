import {
  type Blueprint,
  type Layout,
  MetricCard,
  blueprint$,
  stack,
} from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { defaultDomRegistry } from "./defaultRegistry";
import { mountBlueprint } from "./renderBlueprint";
import { h, safeUrl } from "./safeDom";

const bind = (path: string) => ({ projectionId: "p", path });
const bp = (children: Layout["children"]): Blueprint =>
  blueprint$({
    id: "bp",
    title: "T",
    layout: stack({ children: children as never }),
    projections: ["p"],
  });

const setup = (initial: Record<string, unknown> = { secret: "OLD-SECRET", v: 1 }) => {
  const rt = new InMemoryProjectionRuntime();
  rt.register({
    id: "p",
    initialState: initial,
    handlers: { SET: (s: Record<string, unknown>, e) => ({ ...s, ...(e.payload as object) }) },
  });
  let live = 0;
  const realSubscribe = rt.subscribe.bind(rt);
  (rt as { subscribe: unknown }).subscribe = (...a: Parameters<typeof rt.subscribe>) => {
    live++;
    const off = realSubscribe(...a);
    return () => {
      live--;
      off();
    };
  };
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
  return { rt, emit, live: () => live };
};

describe("update() failure is never reported as success (P2-1)", () => {
  const poisoned = (id: string, degradedFrom: unknown) =>
    ({
      ...MetricCard({ id, binding: bind("secret") }),
      source: { type: "x", version: "1", degradedFrom },
    }) as never;

  it("a malformed source draws the error placeholder; the old value is gone", () => {
    const { rt } = setup();
    const host = document.createElement("div");
    const handle = mountBlueprint(host, bp([MetricCard({ id: "m", binding: bind("secret") })]), {
      projectionRuntime: rt,
      executionId: "e",
    });
    expect(host.textContent).toContain("OLD-SECRET");
    const report = handle.update(bp([poisoned("m", "oops")]));
    expect(host.textContent).not.toContain("OLD-SECRET");
    expect(host.textContent).not.toContain("oops");
    expect(host.querySelector('[data-placeholder="error"]')).not.toBeNull();
    expect(report.outcome).toBe("updated");
    handle.dispose();
  });

  it("a reconcile that still fails rebuilds fresh, releases old subscriptions, and says so", () => {
    const { rt, live } = setup();
    const host = document.createElement("div");
    const handle = mountBlueprint(host, bp([MetricCard({ id: "m", binding: bind("secret") })]), {
      projectionRuntime: rt,
      executionId: "e",
    });
    expect(live()).toBe(1);
    // A child layout whose `children` getter throws once: the failure escapes the per-widget
    // guard, so the reconcile itself fails and must not leave the old surface behind.
    const always = false;
    const bad = {
      type: "stack",
      get children() {
        // Throws while the old surface is still in the DOM, so only the rebuild can succeed.
        if (always || host.querySelector('[data-widget-id="m"]') !== null)
          throw new Error("getter exploded SECRET-ERR");
        return [];
      },
    };
    const next = {
      _tag: "Blueprint",
      id: "bp2",
      title: "T",
      layout: { type: "stack", children: [bad] },
      projections: [],
    } as never as Blueprint;
    const report = handle.update(next);
    expect(report.outcome).toBe("recovered");
    expect(report.error).toBeDefined();
    expect(report.error).not.toContain("SECRET-ERR");
    expect(report.identity.ok).toBe(false);
    expect(host.textContent).not.toContain("OLD-SECRET");
    expect(live()).toBe(0); // next declares no projection: the old subscription was released
    handle.dispose();
  });

  it("a fresh mount that fails too leaves an empty surface and says failed", () => {
    const { rt, live } = setup();
    const host = document.createElement("div");
    const handle = mountBlueprint(host, bp([MetricCard({ id: "m", binding: bind("secret") })]), {
      projectionRuntime: rt,
      executionId: "e",
    });
    expect(live()).toBe(1);
    // A child layout whose `children` getter throws once: the failure escapes the per-widget
    // guard, so the reconcile itself fails and must not leave the old surface behind.
    const always = true;
    const bad = {
      type: "stack",
      get children() {
        // Throws while the old surface is still in the DOM, so only the rebuild can succeed.
        if (always || host.querySelector('[data-widget-id="m"]') !== null)
          throw new Error("getter exploded SECRET-ERR");
        return [];
      },
    };
    const next = {
      _tag: "Blueprint",
      id: "bp2",
      title: "T",
      layout: { type: "stack", children: [bad] },
      projections: [],
    } as never as Blueprint;
    const report = handle.update(next);
    expect(report.outcome).toBe("failed");
    expect(report.error).toBeDefined();
    expect(report.error).not.toContain("SECRET-ERR");
    expect(report.identity.ok).toBe(false);
    expect(host.textContent).not.toContain("OLD-SECRET");
    expect(live()).toBe(0); // next declares no projection: the old subscription was released
    handle.dispose();
  });

  it("the guard paths are distinguishable", () => {
    const { rt } = setup();
    // biome-ignore lint/style/useConst: assigned after the registry closure that reads it
    let handle: ReturnType<typeof mountBlueprint>;
    let inner: string | undefined;
    const registry = {
      get: (k: string) => {
        if (inner === "arm") {
          inner = handle.update(bp([])).outcome;
        }
        return defaultDomRegistry.get(k);
      },
    };
    handle = mountBlueprint(document.createElement("div"), bp([]), {
      projectionRuntime: rt,
      executionId: "e",
      registry: registry as never,
    });
    inner = "arm";
    handle.update(bp([MetricCard({ id: "m", binding: bind("v") })]));
    expect(inner).toBe("busy");
    handle.dispose();
    const after = handle.update(bp([]));
    expect(after.outcome).toBe("disposed");
    expect(after.error).toBeDefined();
  });
});

describe("duplicate ids (P2-2)", () => {
  it("a, a, a~1 do not collide, and repeated updates leak nothing", () => {
    const { rt, emit } = setup();
    let calls = 0;
    const registry = {
      get: (k: string) => {
        const r = defaultDomRegistry.get(k);
        return (
          r &&
          ((c: never) => {
            calls++;
            return r(c);
          })
        );
      },
    };
    const mk = () => bp(["a", "a", "a~1"].map((id) => MetricCard({ id, binding: bind("v") })));
    const host = document.createElement("div");
    const handle = mountBlueprint(host, mk(), {
      projectionRuntime: rt,
      executionId: "e",
      registry: registry as never,
    });
    for (let i = 0; i < 5; i++) handle.update(mk());
    calls = 0;
    emit({ v: 2 });
    expect(host.querySelectorAll("[data-widget-id]")).toHaveLength(3);
    expect(calls).toBe(3);
    handle.dispose();
  });
});

describe("a throwing check never escapes into the runtime (P2-3)", () => {
  it("draws the error placeholder and the other subscriber still hears the event", () => {
    const { rt, emit } = setup({ v: 1 });
    const widgetWithChannel = {
      ...MetricCard({ id: "m", binding: { ...bind("v"), status: { path: "s" } } }),
    };
    const host = document.createElement("div");
    const handle = mountBlueprint(host, bp([widgetWithChannel as never]), {
      projectionRuntime: rt,
      executionId: "e",
      check: (_w, value) => {
        if (value === 3) throw new Error("check blew up SECRET-CHECK");
        return undefined;
      },
    });
    let heard = 0;
    rt.subscribe("p", "e", () => heard++);
    expect(() => emit({ v: 3 })).not.toThrow();
    expect(heard).toBe(1);
    expect(host.querySelector('[data-placeholder="error"]')).not.toBeNull();
    expect(host.textContent).not.toContain("SECRET-CHECK");
    emit({ v: 4 }, 2);
    expect(host.querySelector('[data-placeholder="error"]')).toBeNull();
    handle.dispose();
  });
});

describe("safeUrl backslash protocol-relative (P3-1)", () => {
  it("refuses every spelling a browser reads as //host", () => {
    for (const bad of [
      "/\\evil.com",
      "\\\\evil.com",
      "\\/evil.com",
      " \t/\\evil.com",
      "//evil.com",
    ])
      expect(safeUrl(bad), bad).toBeUndefined();
    expect(h(document, "a", { href: "/\\evil.com" }).getAttribute("href")).toBeNull();
    expect(safeUrl("/a/b\\c")).toBe("/a/b\\c");
  });
});
