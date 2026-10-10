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
import { defaultRegistry as reactRegistry } from "@loom/plugin-renderer-react";
import { defaultTerminalRegistry, renderBlueprintToString } from "@loom/plugin-renderer-terminal";
import { describe, expect, it } from "vitest";
import { defaultDomRegistry } from "./defaultRegistry";
import { renderBlueprintToDom } from "./renderBlueprint";

// The three first-party surfaces over one Blueprint IR must handle the same vocabulary. A kind
// added to the catalogue and rendered by two of them, or a kind one registers that another
// does not, is the drift this fails on (ADR 0088: does each surface cover the catalogue?).

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
    }
  });
});
