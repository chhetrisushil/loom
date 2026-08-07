import { badge, bind, button, column, list, text } from "@loom/plugin-a2ui";
import type { ComponentInstance } from "@loom/plugin-a2ui";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { SURFACE_HOST_TEMPLATE } from "./template";

// ── Does the template actually render the catalog it claims to render? ────────
//
// The string assertions elsewhere prove the template *mentions* the right things.
// They cannot prove it renders correctly, and they did not: the List branch read a
// `node.items` prop that the A2UI `list()` helper never emits (it emits
// `children: { path, componentId }`), so every list rendered empty and every item
// component was ignored. Nothing caught it until the template was executed against
// a tree built by the real helpers.
//
// So these tests build the view with the SAME helpers an app would use, run the
// SAME published template string, and assert on the DOM. Anything less is testing
// a different program than the one that ships.

interface Rendered {
  root: string;
  html: string;
  window: JSDOM["window"];
}

function mount() {
  const dom = new JSDOM(`<!doctype html><html><body>${SURFACE_HOST_TEMPLATE}</body></html>`, {
    runScripts: "dangerously",
    beforeParse(window: JSDOM["window"]) {
      // The template handshakes on load; swallow its posts and reply to
      // ui/initialize so it reaches steady state.
      Object.defineProperty(window, "parent", {
        configurable: true,
        value: {
          postMessage: (msg: { id?: number; method?: string }) => {
            if (msg.method === "ui/initialize" && msg.id !== undefined) {
              queueMicrotask(() => {
                window.dispatchEvent(
                  new window.MessageEvent("message", {
                    data: { jsonrpc: "2.0", id: msg.id, result: { hostContext: {} } },
                  })
                );
              });
            }
          },
        },
      });
    },
  });
  return dom;
}

async function render(components: ComponentInstance[], dataModel: unknown): Promise<Rendered> {
  const dom = mount();
  const { window } = dom;
  window.dispatchEvent(
    new window.MessageEvent("message", {
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          result: {
            structuredContent: {
              surfaceId: "ui:x1",
              executionId: "x1",
              sequence: 3,
              changed: true,
              components,
              dataModel,
            },
          },
        },
      },
    })
  );
  // Let the template's handlers run.
  await new Promise((r) => setTimeout(r, 0));
  const root = window.document.getElementById("loom-root");
  return {
    root: root?.textContent ?? "",
    html: root?.innerHTML ?? "",
    window,
  };
}

describe("the surface-host template renders the A2UI catalog", () => {
  it("renders Text and Badge bound by JSON Pointer", async () => {
    const out = await render(
      [column("root", ["t", "b"]), text("t", bind("/title")), badge("b", bind("/status"))],
      { title: "Checkout v4.2", status: "awaiting-approval" }
    );
    expect(out.root).toContain("Checkout v4.2");
    expect(out.root).toContain("awaiting-approval");
    out.window.close();
  });

  // The regression. `list()` emits `children: { path, componentId }` — reading a
  // `items` prop silently produced an empty list for every app.
  it("renders a List's items through its declared item component", async () => {
    const out = await render(
      [column("root", ["checks"]), list("checks", "/checks", "item"), text("item", bind(""))],
      { checks: ["build ✓", "unit ✓", "lint ✗"] }
    );
    expect(out.root).toContain("build ✓");
    expect(out.root).toContain("unit ✓");
    expect(out.root).toContain("lint ✗");
    out.window.close();
  });

  it("scopes bindings inside a list item to the element (A2UI collection scope)", async () => {
    const out = await render(
      [column("root", ["rows"]), list("rows", "/rows", "row"), text("row", bind("/name"))],
      { rows: [{ name: "alpha" }, { name: "beta" }], name: "SHOULD-NOT-APPEAR" }
    );
    expect(out.root).toContain("alpha");
    expect(out.root).toContain("beta");
    // A relative binding must NOT fall through to the root data model.
    expect(out.root).not.toContain("SHOULD-NOT-APPEAR");
    out.window.close();
  });

  it("renders an empty list without throwing, and a missing binding as empty", async () => {
    const out = await render(
      [
        column("root", ["l", "t"]),
        list("l", "/nope", "item"),
        text("item", bind("")),
        text("t", bind("/missing")),
      ],
      {}
    );
    expect(out.root.trim()).toBe("");
    out.window.close();
  });

  it("renders a Button carrying its action", async () => {
    const out = await render([column("root", ["go"]), button("go", "Approve", "approve")], {});
    expect(out.html).toContain("loom-btn");
    expect(out.root).toContain("Approve");
    out.window.close();
  });

  // Surface values are agent/user data. If they were ever written as markup, any
  // logged string would be a script-injection vector into the host page.
  it("renders a value containing markup as TEXT, never as DOM", async () => {
    const out = await render([column("root", ["t"]), text("t", bind("/evil"))], {
      evil: "<img src=x onerror=alert(1)>",
    });
    expect(out.root).toContain("<img");
    expect(out.html).not.toContain("<img");
    expect(out.window.document.querySelector("img")).toBeNull();
    out.window.close();
  });

  it("skips an unknown component type rather than guessing", async () => {
    const out = await render(
      [column("root", ["x", "t"]), { id: "x", component: "NotInCatalog" }, text("t", "kept")],
      {}
    );
    expect(out.root).toContain("kept");
    out.window.close();
  });
});
