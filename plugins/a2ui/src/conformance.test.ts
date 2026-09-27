import { SURFACE_PATCH } from "@loom/agent-surface";
import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { A2UISurfaceBridge } from "./A2UISurfaceBridge";
import {
  DEFAULT_CATALOG_ID,
  column,
  defaultCatalog,
  defineCatalog,
  list,
  row,
  text,
} from "./catalog";
import { validateCatalog, validateComponents, validateFunctionCall } from "./conformance";
import type { A2UIServerMessage, ComponentInstance, UpdateComponentsPayload } from "./messages";

const view: ComponentInstance[] = [column("root", ["t"]), text("t", "hello")];

const bridge = (over: Record<string, unknown> = {}) =>
  new A2UISurfaceBridge({ executionId: "exec-1", components: view, ...over } as never);

const patch = (seq: number, path: string, value: unknown): EventEnvelope => ({
  id: `e${seq}`,
  workflowId: "wf",
  executionId: "exec-1",
  eventType: SURFACE_PATCH,
  sequence: seq,
  timestamp: 1,
  payload: { surface: "ui", patches: [{ op: "set", path, value }] },
});

const codes = (r: { findings: readonly { code: string }[] }) => r.findings.map((f) => f.code);

const asUpdate = (m: A2UIServerMessage) =>
  (m as { updateComponents: UpdateComponentsPayload }).updateComponents;

// ── validateComponents ────────────────────────────────────────────────────────

describe("validateComponents", () => {
  it("passes a tree drawn from the catalogue", () => {
    const report = validateComponents(view, defaultCatalog, { requireRoot: true });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.components).toBe(2);
  });

  it("FAILS a component type the catalogue does not define", () => {
    const report = validateComponents(
      [column("root", ["x"]), { id: "x", component: "Sparkline" }],
      defaultCatalog,
      { requireRoot: true }
    );
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["unknown-component"]);
  });

  it("FAILS a prop the component does not declare", () => {
    const report = validateComponents(
      [{ id: "root", component: "Text", text: "hi", rows: [{ secret: 1 }] }],
      defaultCatalog,
      { requireRoot: true }
    );
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["undeclared-prop"]);
    expect(report.findings[0]?.message).toContain("rows");
  });

  it("FAILS two components sharing an id", () => {
    const report = validateComponents(
      [column("root", ["t"]), text("t", "a"), text("t", "b")],
      defaultCatalog,
      { requireRoot: true }
    );
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["duplicate-component-id"]);
  });

  it("FAILS a createSurface tree with no root", () => {
    const report = validateComponents([text("t", "hi")], defaultCatalog, { requireRoot: true });
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["missing-root"]);
  });

  it("does NOT require a root for an updateComponents batch", () => {
    // An update may legitimately replace a subtree. A check that rejects correct
    // usage gets turned off, and a turned-off check protects nobody.
    const report = validateComponents([text("t", "hi")], defaultCatalog, { requireRoot: false });
    expect(report.ok).toBe(true);
  });

  it("WARNS, without failing, when an entry declares no properties to check", () => {
    // The absent-input rule: a catalogue that declined to declare its props is
    // reported as unchecked rather than silently passing as verified.
    const loose = defineCatalog({
      id: "loose.v1",
      components: { Widget: { component: { const: "Widget" } } },
    });
    const report = validateComponents([{ id: "root", component: "Widget", anything: 1 }], loose, {
      requireRoot: true,
    });
    expect(report.ok).toBe(true);
    expect(codes(report)).toEqual(["unchecked-props"]);
  });

  it("reports ONE finding for an unknown component, not a cascade of prop findings", () => {
    const report = validateComponents(
      [{ id: "root", component: "Sparkline", a: 1, b: 2, c: 3 }],
      defaultCatalog,
      { requireRoot: true }
    );
    expect(report.findings).toHaveLength(1);
  });
});

// ── validateComponents — structural checks (dangling ids, cycles, reachability) ──

describe("validateComponents — dangling references", () => {
  it("FAILS a Column/Row child id that no component defines", () => {
    const report = validateComponents([column("root", ["ghost"])], defaultCatalog, {
      requireRoot: true,
    });
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("dangling-child");
  });

  it("FAILS a List whose templated child id no component defines", () => {
    const report = validateComponents([list("root", "/items", "ghost")], defaultCatalog, {
      requireRoot: true,
    });
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("dangling-template");
  });

  it("passes a child id that resolves within the same tree", () => {
    const report = validateComponents(view, defaultCatalog, { requireRoot: true });
    expect(report.ok).toBe(true);
  });
});

describe("validateComponents — cycles", () => {
  it("FAILS a component that references itself", () => {
    const report = validateComponents([column("root", ["root"])], defaultCatalog, {
      requireRoot: true,
    });
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("child-cycle");
  });

  it("FAILS a longer cycle (root -> a -> root)", () => {
    const report = validateComponents([column("root", ["a"]), row("a", ["root"])], defaultCatalog, {
      requireRoot: true,
    });
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("child-cycle");
  });

  it("does not run forever on a large, deliberately cyclic chain (iterative, not recursive)", () => {
    // A composer-generated payload is exactly where an accidental cycle across
    // thousands of nodes would show up; a recursive walk would blow the stack
    // before this array is even fully built out. This proves the walk is
    // iterative rather than merely "correct on small inputs".
    const n = 50_000;
    const chain: ComponentInstance[] = [column("root", ["n0"])];
    for (let i = 0; i < n; i++) {
      chain.push(row(`n${i}`, [i + 1 < n ? `n${i + 1}` : "root"]));
    }
    const report = validateComponents(chain, defaultCatalog, { requireRoot: true });
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("child-cycle");
  });
});

describe("validateComponents — reachability", () => {
  it("WARNS, without failing, on a component no path from root reaches", () => {
    const report = validateComponents(
      [column("root", []), text("orphan", "unreachable")],
      defaultCatalog,
      { requireRoot: true }
    );
    expect(report.ok).toBe(true);
    expect(codes(report)).toContain("unreachable-component");
  });

  it("does NOT check reachability for an updateComponents batch (requireRoot: false)", () => {
    // A batch may legitimately touch only part of the tree; "unreachable from
    // root" is meaningless for a fragment that was never claiming completeness.
    const report = validateComponents([text("orphan", "x")], defaultCatalog, {
      requireRoot: false,
    });
    expect(codes(report)).not.toContain("unreachable-component");
  });

  it("does not pile 'unreachable' findings on top of 'missing-root'", () => {
    const report = validateComponents([text("t", "hi")], defaultCatalog, { requireRoot: true });
    expect(codes(report)).toEqual(["missing-root"]);
  });
});

describe("validateComponents — knownComponents (the recompose merge)", () => {
  // THE positive case that keeps this check from being turned off: a subtree
  // batch that references an already-delivered sibling is correct A2UI usage,
  // because a client MERGES `updateComponents` by id rather than replacing.
  it("passes a batch whose child id resolves only via knownComponents, not the batch itself", () => {
    const known = new Map<string, ComponentInstance>([
      ["root", column("root", ["t"])],
      ["t", text("t", "hello")],
    ]);
    const report = validateComponents([row("panel", ["t"])], defaultCatalog, {
      requireRoot: false,
      knownComponents: known,
    });
    expect(report.ok).toBe(true);
    expect(codes(report)).not.toContain("dangling-child");
  });

  it("FAILS a batch that closes a cycle back through a previously sent component", () => {
    const known = new Map<string, ComponentInstance>([
      ["root", column("root", ["a"])],
      ["a", text("a", "x")],
    ]);
    // The batch replaces "a" with something that points back at "root" — a
    // cycle that only exists once this batch is combined with what the client
    // already holds.
    const report = validateComponents([row("a", ["root"])], defaultCatalog, {
      requireRoot: false,
      knownComponents: known,
    });
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("child-cycle");
  });

  it("still catches a dangling child that neither the batch nor knownComponents define", () => {
    const known = new Map<string, ComponentInstance>([["root", column("root", ["a"])]]);
    const report = validateComponents([row("a", ["ghost"])], defaultCatalog, {
      requireRoot: false,
      knownComponents: known,
    });
    expect(report.ok).toBe(false);
    expect(codes(report)).toContain("dangling-child");
  });
});

// ── validateCatalog ──────────────────────────────────────────────────────────

describe("validateCatalog", () => {
  it("passes the shipped default catalogue", () => {
    expect(validateCatalog(defaultCatalog).ok).toBe(true);
  });

  it("FAILS an entry keyed differently than its own discriminator const", () => {
    const bad = defineCatalog({
      id: "bad.v1",
      components: { Text: { component: { const: "Txt" }, properties: { text: {} } } },
    });
    const report = validateCatalog(bad);
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["catalog-entry-key-mismatch"]);
  });

  it("FAILS a function keyed differently than its own declared name", () => {
    const bad = defineCatalog({
      id: "bad.v1",
      components: {},
      functions: { getLocale: { name: "other" } },
    });
    const report = validateCatalog(bad);
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["catalog-function-key-mismatch"]);
  });
});

// ── validateFunctionCall ──────────────────────────────────────────────────────

describe("validateFunctionCall", () => {
  it("FAILS against a catalogue that declares no functions", () => {
    // Absence is a refusal, not a blanket permission. This is the live defect:
    // the shipped default catalogue declares no `functions`, so every call
    // against it was unverifiable — and therefore unverified.
    const report = validateFunctionCall("getLocale", defaultCatalog);
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["unknown-function"]);
  });

  it("FAILS a name outside a catalogue that does declare functions", () => {
    const cat = defineCatalog({
      ...defaultCatalog,
      functions: { getLocale: { name: "getLocale" } },
    });
    expect(validateFunctionCall("submit", cat).ok).toBe(false);
    expect(validateFunctionCall("getLocale", cat).ok).toBe(true);
  });
});

// ── The bridge seam ───────────────────────────────────────────────────────────

describe("A2UISurfaceBridge — construction refuses what it cannot verify", () => {
  it("REFUSES a catalogId named without the catalogue behind it", () => {
    // The original defect in one line: the bridge stamped this id on every
    // message and checked nothing against it.
    expect(() => bridge({ catalogId: "acme.console.v3" })).toThrow(/was named but the catalogue/);
  });

  it("REFUSES a catalogId that disagrees with the supplied catalogue", () => {
    expect(() => bridge({ catalog: defaultCatalog, catalogId: "other.v1" })).toThrow(/disagrees/);
  });

  it("accepts the default catalogId, which the default catalogue backs", () => {
    expect(() => bridge({ catalogId: DEFAULT_CATALOG_ID })).not.toThrow();
  });

  it("REFUSES an initial tree that does not conform", () => {
    expect(() => bridge({ components: [{ id: "root", component: "Sparkline" }] })).toThrow(
      /unknown-component/
    );
  });

  it("REFUSES an initial tree with a dangling child id", () => {
    expect(() => bridge({ components: [column("root", ["ghost"])] })).toThrow(/dangling-child/);
  });

  it("REFUSES an initial tree with a cycle", () => {
    expect(() => bridge({ components: [column("root", ["root"])] })).toThrow(/child-cycle/);
  });

  it("REFUSES a mis-keyed catalogue", () => {
    const mismatched = defineCatalog({
      id: "acme.v1",
      components: { Text: { component: { const: "Txt" }, properties: { text: {} } } },
    });
    expect(() =>
      bridge({ catalog: mismatched, components: [{ id: "root", component: "Text", text: "hi" }] })
    ).toThrow(/is not well-formed/);
  });
});

describe("A2UISurfaceBridge.recompose — the structural update", () => {
  it("emits updateComponents for an open session", () => {
    // `updateComponents` has been a declared, exported payload type with no
    // producer since the adapter shipped: the component tree was fixed for the
    // life of a session, so nothing could add a panel to a surface already open.
    const b = bridge();
    b.snapshot();
    const next = [column("root", ["t", "t2"]), text("t", "a"), text("t2", "b")];

    const messages = b.recompose(next);
    expect(messages).toHaveLength(1);
    expect(asUpdate(messages[0] as A2UIServerMessage)).toEqual({
      surfaceId: "ui:exec-1",
      components: next,
    });
  });

  it("emits nothing before the session opens, and the new tree is what createSurface carries", () => {
    // There is no client to update yet; emitting an update for a surface the
    // client has never seen would be the wrong message, not a missing one.
    const b = bridge();
    const next = [column("root", ["t2"]), text("t2", "b")];
    expect(b.recompose(next)).toEqual([]);

    const [created] = b.snapshot();
    expect(
      (created as { createSurface: { components: ComponentInstance[] } }).createSurface.components
    ).toEqual(next);
  });

  it("REFUSES an off-catalogue tree and emits NOTHING", () => {
    // The acceptance criterion. Asserted on the message stream, because a bridge
    // that returned [] on a bad tree would turn an authoring bug into a surface
    // that silently never updates.
    const b = bridge();
    const emitted = b.snapshot();
    expect(() => b.recompose([{ id: "root", component: "Sparkline" }])).toThrow(
      /does not conform to catalogue/
    );

    // The session is untouched: nothing further was produced, and the tree the
    // client holds is still the one it was given.
    expect(b.handleEvent(patch(1, "x", 1)).every((m) => !("updateComponents" in m))).toBe(true);
    expect(emitted).toHaveLength(1);
  });

  it("PASSES a subtree batch that references an already-sent sibling", () => {
    // THE positive case that keeps this check from being turned off (ADR 0088's
    // own rule): the client MERGES `updateComponents` by id, so a batch that
    // names an id from an EARLIER batch (not this one) is correct usage, not a
    // dangling reference — even though `recompose` itself replaces the bridge's
    // stored `components` wholesale.
    const b = bridge(); // view = [column("root", ["t"]), text("t", "hello")]
    b.snapshot();
    const messages = b.recompose([row("panel", ["t"])]);
    expect(messages).toHaveLength(1);
  });

  it("REFUSES a batch that closes a cycle through a component sent in an EARLIER batch", () => {
    const b = bridge({ components: [column("root", ["a"]), text("a", "x")] });
    b.snapshot();
    // "a" was a leaf Text; this batch turns it into a Row pointing back at
    // "root" — only a cycle once combined with the "root" the client already
    // holds, which `this.components` (the previous batch only) would not show.
    expect(() => b.recompose([row("a", ["root"])])).toThrow(/child-cycle/);
  });
});

describe("A2UISurfaceBridge.callFunction — checked against the catalogue", () => {
  it("REFUSES a function the catalogue does not declare", () => {
    // A request no compliant client can honour, after which the flow waits on a
    // response that is never coming.
    expect(() => bridge().callFunction("getLocale", {}, { callId: "c1" })).toThrow(
      /declares no client-callable functions/
    );
  });

  it("passes a declared function through unchanged", () => {
    const cat = defineCatalog({
      ...defaultCatalog,
      functions: { getLocale: { name: "getLocale" } },
    });
    const msg = bridge({ catalog: cat }).callFunction("getLocale", { a: 1 }, { callId: "c1" });
    expect((msg as { callFunction: { name: string } }).callFunction.name).toBe("getLocale");
  });
});

describe("A2UISurfaceBridge — provenance stays server-side", () => {
  it("does not forward a patch's author to the wire", () => {
    // `by` names internal actors — an agent id, a model version. It rides the
    // SURFACE_PATCH payload so a projection can answer "who placed this", and the
    // bridge reads `patches` only, so it never reaches a viewer.
    const b = bridge();
    const attributed: EventEnvelope = {
      ...patch(1, "total", 42),
      payload: {
        surface: "ui",
        patches: [{ op: "set", path: "total", value: 42 }],
        by: { by: "planner-agent", note: "model=opus-5" },
      },
    };

    const wire = JSON.stringify(b.handleEvent(attributed));
    expect(wire).toContain("42");
    expect(wire).not.toContain("planner-agent");
    expect(wire).not.toContain("opus-5");
  });
});
