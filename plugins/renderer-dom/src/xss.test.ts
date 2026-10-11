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
  customWidget$,
  stack,
} from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { type DomWidgetRenderer, defaultDomRegistry } from "./defaultRegistry";
import { renderBlueprintToDom } from "./renderBlueprint";
import { display, h, safeUrl, token } from "./safeDom";

// Hostile data in EVERY place a blueprint or a projection can put a string. The renderer must
// show it as text and nothing else: no element it did not create, no handler, no executable URL.

const IMG = '<img src=x onerror="window.__pwned=1">';
const SCRIPT = "<script>window.__pwned=1</script>";
const JS = "javascript:window.__pwned=1";
const b = (path: string) => ({ projectionId: "p", path });

function hostile() {
  const blueprint = blueprint$({
    id: `${IMG}`,
    title: IMG,
    layout: stack({
      title: SCRIPT,
      children: [
        MetricCard({ id: IMG, title: IMG, binding: b("m"), unit: IMG }),
        StatusBadge({ id: "badge", title: IMG, binding: b("badge") }),
        ProgressBar({ id: "pb", title: IMG, binding: b("n") }),
        Timeline({ id: "tl", title: IMG, binding: b("tl") }),
        DataTable({ id: "dt", title: IMG, binding: b("rows"), columns: [IMG, "ok"] }),
        // @ts-expect-error intentionally invalid severity: the renderer must neutralise hostile strings
        AlertCard({ id: "al", title: IMG, binding: b("m"), severity: IMG }),
        ApprovalCard({
          id: "ap",
          title: IMG,
          binding: b("yes"),
          approveLabel: IMG,
          rejectLabel: JS,
        }),
        StreamingText({ id: "st", title: IMG, binding: b("m") }),
        customWidget$({ kind: IMG, id: "unknown", binding: b("m") }) as never,
      ],
    }),
    projections: ["p"],
  });
  const state = new Map<string, unknown>([
    [
      "p",
      {
        m: IMG,
        badge: `x" onmouseover="window.__pwned=1`,
        n: IMG,
        tl: [{ timestamp: IMG, message: SCRIPT, level: `" onclick="x` }],
        rows: [{ [IMG]: IMG, ok: JS }],
        yes: true,
      },
    ],
  ]);
  return { blueprint, state };
}

describe("hostile data renders inert", () => {
  const { blueprint, state } = hostile();
  const el = renderBlueprintToDom(blueprint, state);
  const all = [el, ...el.querySelectorAll("*")];

  it("creates no element a renderer did not write (no img, script, iframe, style, link)", () => {
    expect(el.querySelector("img, script, iframe, object, embed, style, link, svg")).toBeNull();
  });

  it("sets no event-handler attribute and no style attribute from data", () => {
    for (const node of all) {
      for (const a of node.getAttributeNames()) {
        expect(a.startsWith("on"), `${node.tagName} has ${a}`).toBe(false);
      }
    }
    // The only inline style is the layout's, whose numbers are validated.
    for (const node of el.querySelectorAll("[style]")) {
      expect(node.getAttribute("style")).not.toMatch(/url|expression|onerror/i);
    }
  });

  it("puts no executable URL in any href/src/action attribute", () => {
    for (const node of all) {
      for (const name of ["href", "src", "action", "formaction", "srcdoc", "xlink:href"]) {
        expect(node.getAttribute(name), `${node.tagName}[${name}]`).toBeNull();
      }
    }
    expect(el.innerHTML.toLowerCase()).not.toContain('href="javascript');
  });

  it("shows the hostile strings as literal text", () => {
    expect(el.querySelector("h1")?.textContent).toBe(IMG);
    expect(el.querySelector("section h2")?.textContent).toBe(SCRIPT);
    expect(el.querySelector(".metric-value")?.textContent).toContain(IMG);
    expect(el.querySelector(".timeline-msg")?.textContent).toBe(SCRIPT);
    expect(el.querySelector(".approval-actions")?.textContent).toContain(JS);
    expect(el.textContent).toContain(IMG);
  });

  it("never lets data author a class or attribute value", () => {
    expect(el.querySelector(".badge")?.className).toBe("badge badge--unknown");
    expect(el.querySelector(".alert")?.getAttribute("data-severity")).toBe("info");
    expect(el.querySelector(".timeline-entry")?.hasAttribute("data-level")).toBe(false);
  });

  it("executes nothing", () => {
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe("safeDom", () => {
  it("h refuses what a renderer author must not write", () => {
    expect(() => h(document, "iframe")).toThrow(/not allowed/);
    expect(() => h(document, "script")).toThrow(/not allowed/);
    expect(() => h(document, "div", { onclick: "x" })).toThrow(/not allowed/);
    expect(() => h(document, "div", { style: "color:red" })).toThrow(/not allowed/);
    expect(() => h(document, "div", { srcdoc: "x" })).toThrow(/not allowed/);
  });

  it("h makes string children text nodes", () => {
    const el = h(document, "div", {}, IMG);
    expect(el.children).toHaveLength(0);
    expect(el.textContent).toBe(IMG);
  });

  it("h drops an unsafe href and keeps a safe one", () => {
    expect(h(document, "a", { href: JS }).hasAttribute("href")).toBe(false);
    expect(h(document, "a", { href: "https://example.com/x" }).getAttribute("href")).toBe(
      "https://example.com/x"
    );
  });

  it("safeUrl: allowlist of schemes, with disguises stripped", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " \tjava\nscript:alert(1)",
      "java\u0000script:1",
      "​javascript:1",
      "data:text/html,<script>1</script>",
      "vbscript:1",
      "file:///etc/passwd",
      "//evil.example/x",
      42,
      undefined,
    ]) {
      expect(safeUrl(bad), String(bad)).toBeUndefined();
    }
    for (const ok of [
      "https://a.example/x?y=1",
      "http://a.example",
      "mailto:a@b.c",
      "tel:+1",
      "/rel/path",
      "#frag",
      "rel",
      "?q=1",
    ]) {
      expect(safeUrl(ok), ok).toBe(ok);
    }
  });

  it("token and display", () => {
    expect(token("Ready", "x")).toBe("ready");
    expect(token('a" b', "x")).toBe("x");
    expect(token(5, "x")).toBe("x");
    expect(display({ a: 1 })).toBe('{"a":1}');
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(display(cyc)).toBe("[unserializable]");
    expect(display(null)).toBe("");
  });

  it("a custom renderer built on h inherits the guarantees", () => {
    const registry = defaultDomRegistry.merge(
      new RendererRegistry<DomWidgetRenderer>().register("Link", ({ doc, value }) =>
        h(doc, "a", { href: String(value) }, String(value))
      )
    );
    const bp = blueprint$({
      id: "l",
      title: "L",
      layout: stack({
        children: [customWidget$({ kind: "Link", id: "l1", binding: b("u") }) as never],
      }),
      projections: ["p"],
    });
    const el = renderBlueprintToDom(bp, new Map([["p", { u: JS }]]), { registry });
    expect(el.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(el.querySelector("a")?.textContent).toBe(JS);
  });
});
