import { SURFACE_PATCH } from "@loom/agent-surface";
import type { SurfacePatch } from "@loom/agent-surface";
import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { A2UISurfaceBridge } from "./A2UISurfaceBridge";
import { DEFAULT_CATALOG_ID, bind, column, text } from "./catalog";
import { dotPathToParts, dotPathToPointer } from "./pointer";
import type { A2UIServerMessage } from "./messages";
import { A2UI_VERSION } from "./messages";

// ── pointer conversion ──────────────────────────────────────────────────────

describe("dotPathToPointer", () => {
  it("converts a dot-path to a JSON Pointer", () => {
    expect(dotPathToPointer("a.b.c")).toBe("/a/b/c");
    expect(dotPathToPointer("status")).toBe("/status");
  });
  it("maps the empty path to the whole-document pointer", () => {
    expect(dotPathToPointer("")).toBe("");
  });
  it("escapes RFC 6901 reserved characters", () => {
    expect(dotPathToPointer("a~b")).toBe("/a~0b");
    expect(dotPathToPointer("a/b")).toBe("/a~1b");
  });
  it("dotPathToParts splits (and empties the root)", () => {
    expect(dotPathToParts("a.b")).toEqual(["a", "b"]);
    expect(dotPathToParts("")).toEqual([]);
  });
});

// ── fixtures ──────────────────────────────────────────────────────────────────

function patchEvent(
  patches: SurfacePatch[],
  opts: { surface?: string; executionId?: string; eventType?: string } = {}
): EventEnvelope {
  return {
    id: "e",
    workflowId: "wf",
    executionId: opts.executionId ?? "exec-1",
    eventType: opts.eventType ?? SURFACE_PATCH,
    sequence: 0,
    timestamp: 1,
    payload: { ...(opts.surface !== undefined && { surface: opts.surface }), patches },
  };
}

const view = [column("root", ["status"]), text("status", bind("/status"))];

function newBridge(over: Partial<Parameters<typeof makeBridge>[0]> = {}) {
  return makeBridge({ executionId: "exec-1", components: view, ...over });
}
function makeBridge(o: {
  executionId: string;
  components: typeof view;
  surface?: string;
  redact?: readonly string[];
}) {
  return new A2UISurfaceBridge(o);
}

// Narrowers for terse assertions.
const asUpdate = (m: A2UIServerMessage) =>
  (m as { updateDataModel: { surfaceId: string; path: string; contents: unknown } })
    .updateDataModel;
const asCreate = (m: A2UIServerMessage) =>
  (m as { createSurface: { surfaceId: string; catalogId: string; dataModel: unknown } })
    .createSurface;

// ── snapshot / createSurface ────────────────────────────────────────────────

describe("A2UISurfaceBridge — handshake", () => {
  it("snapshot() emits one createSurface with catalog, components and current data", () => {
    const b = newBridge();
    const [msg, ...rest] = b.snapshot();
    expect(rest).toHaveLength(0);
    expect(msg?.version).toBe(A2UI_VERSION);
    const cs = asCreate(msg!);
    expect(cs.surfaceId).toBe("ui:exec-1"); // default `${surface}:${executionId}`
    expect(cs.catalogId).toBe(DEFAULT_CATALOG_ID);
    expect(cs.dataModel).toEqual({});
    expect((msg as { createSurface: { components: unknown } }).createSurface.components).toEqual(
      view
    );
  });

  it("the first event auto-opens the session with a createSurface carrying folded data", () => {
    const b = newBridge();
    const msgs = b.handleEvent(patchEvent([{ op: "set", path: "status", value: "running" }]));
    expect(msgs).toHaveLength(1);
    expect(asCreate(msgs[0]!).dataModel).toEqual({ status: "running" });
  });
});

// ── delta → absolute updateDataModel translation ──────────────────────────────

describe("A2UISurfaceBridge — patch translation (after open)", () => {
  function opened() {
    const b = newBridge();
    b.snapshot(); // opened, empty state
    return b;
  }

  it("set → updateDataModel at the pointer with the value", () => {
    const b = opened();
    const [m] = b.handleEvent(patchEvent([{ op: "set", path: "status", value: "ok" }]));
    expect(asUpdate(m!)).toEqual({ surfaceId: "ui:exec-1", path: "/status", contents: "ok" });
  });

  it("append emits the whole folded array (A2UI has no delta append)", () => {
    const b = opened();
    b.handleEvent(patchEvent([{ op: "append", path: "log", value: "a" }]));
    const [m] = b.handleEvent(patchEvent([{ op: "append", path: "log", value: "b" }]));
    expect(asUpdate(m!)).toEqual({ surfaceId: "ui:exec-1", path: "/log", contents: ["a", "b"] });
  });

  it("increment emits the folded number", () => {
    const b = opened();
    b.handleEvent(patchEvent([{ op: "increment", path: "n", by: 2 }]));
    const [m] = b.handleEvent(patchEvent([{ op: "increment", path: "n", by: 3 }]));
    expect(asUpdate(m!).contents).toBe(5);
  });

  it("merge emits the folded object at the path", () => {
    const b = opened();
    b.handleEvent(patchEvent([{ op: "set", path: "cfg", value: { a: 1 } }]));
    const [m] = b.handleEvent(patchEvent([{ op: "merge", path: "cfg", value: { b: 2 } }]));
    expect(asUpdate(m!).contents).toEqual({ a: 1, b: 2 });
  });

  it("remove → contents null (A2UI upsert-to-null removal)", () => {
    const b = opened();
    b.handleEvent(patchEvent([{ op: "set", path: "x", value: 1 }]));
    const [m] = b.handleEvent(patchEvent([{ op: "remove", path: "x" }]));
    expect(asUpdate(m!)).toEqual({ surfaceId: "ui:exec-1", path: "/x", contents: null });
  });

  it("a batch of patches becomes an ordered run of updates", () => {
    const b = opened();
    const msgs = b.handleEvent(
      patchEvent([
        { op: "set", path: "status", value: "run" },
        { op: "append", path: "log", value: "x" },
        { op: "increment", path: "progress", by: 10 },
      ])
    );
    expect(msgs.map((m) => asUpdate(m).path)).toEqual(["/status", "/log", "/progress"]);
    expect(msgs.map((m) => asUpdate(m).contents)).toEqual(["run", ["x"], 10]);
  });

  it("set at the root path replaces the whole data model (pointer \"\")", () => {
    const b = opened();
    const [m] = b.handleEvent(patchEvent([{ op: "set", path: "", value: { fresh: true } }]));
    expect(asUpdate(m!)).toEqual({ surfaceId: "ui:exec-1", path: "", contents: { fresh: true } });
  });
});

// ── filtering ─────────────────────────────────────────────────────────────────

describe("A2UISurfaceBridge — filtering", () => {
  it("ignores non-surface events", () => {
    const b = newBridge();
    expect(b.handleEvent(patchEvent([], { eventType: "STEP_COMPLETED" }))).toEqual([]);
  });
  it("ignores other executions", () => {
    const b = newBridge();
    expect(
      b.handleEvent(patchEvent([{ op: "set", path: "x", value: 1 }], { executionId: "exec-2" }))
    ).toEqual([]);
  });
  it("ignores other surfaces", () => {
    const b = newBridge({ surface: "ui" });
    expect(
      b.handleEvent(patchEvent([{ op: "set", path: "x", value: 1 }], { surface: "sidebar" }))
    ).toEqual([]);
  });
});

// ── egress redaction (K10-R6) ─────────────────────────────────────────────────

describe("A2UISurfaceBridge — egress redaction", () => {
  it("masks a declared path before it leaves, while folding stays correct", () => {
    const b = newBridge({ redact: ["token"] });
    b.snapshot();
    const [m] = b.handleEvent(patchEvent([{ op: "set", path: "token", value: "sk_live_1" }]));
    expect(asUpdate(m!).contents).toBe("[redacted]");
    // A non-redacted sibling is untouched.
    const [m2] = b.handleEvent(patchEvent([{ op: "set", path: "label", value: "ok" }]));
    expect(asUpdate(m2!).contents).toBe("ok");
  });

  it("createSurface data model is redacted too", () => {
    const b = newBridge({ redact: ["secret"] });
    const [m] = b.handleEvent(patchEvent([{ op: "set", path: "secret", value: "x" }]));
    expect(asCreate(m!).dataModel).toEqual({ secret: "[redacted]" });
  });
});

// ── close + inbound actions ───────────────────────────────────────────────────

describe("A2UISurfaceBridge — close and ingestAction", () => {
  it("close emits deleteSurface", () => {
    const b = newBridge();
    expect(b.close()).toEqual([
      { version: A2UI_VERSION, deleteSurface: { surfaceId: "ui:exec-1" } },
    ]);
  });

  it("ingestAction returns the action when it targets this surface", () => {
    const b = newBridge();
    const action = { surfaceId: "ui:exec-1", action: "approve", context: { id: 7 } };
    expect(b.ingestAction({ version: A2UI_VERSION, action })).toEqual(action);
  });

  it("ingestAction returns null for another surface or a non-action", () => {
    const b = newBridge();
    expect(
      b.ingestAction({ version: A2UI_VERSION, action: { surfaceId: "other", action: "x" } })
    ).toBeNull();
    expect(b.ingestAction({ version: A2UI_VERSION, error: "boom" })).toBeNull();
  });
});
