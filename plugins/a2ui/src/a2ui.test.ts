import { SURFACE_PATCH } from "@loom/agent-surface";
import type { SurfacePatch } from "@loom/agent-surface";
import type { EventEnvelope } from "@loom/core";
import { EffectModeViolationError, EffectRuntime } from "@loom/effect-runtime";
import type { Effect, EffectContext } from "@loom/effect-runtime";
import { describe, expect, it } from "vitest";
import { A2UISurfaceBridge, type A2UISurfaceBridgeOptions } from "./A2UISurfaceBridge";
import type { A2UICallFunctionInput } from "./callFunction";
import { A2UI_CALL_FUNCTION_TOOL_ID, registerA2UICallFunction } from "./callFunction";
import {
  DEFAULT_CATALOG_ID,
  bind,
  column,
  defaultCatalog,
  defineCatalog,
  row,
  text,
} from "./catalog";
import type { A2UIServerMessage, CallFunctionPayload, FunctionResponsePayload } from "./messages";
import { A2UI_VERSION } from "./messages";
import { dotPathToParts, dotPathToPointer } from "./pointer";

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

function newBridge(over: Partial<A2UISurfaceBridgeOptions> = {}) {
  return makeBridge({ executionId: "exec-1", components: view, ...over });
}

// A catalogue that declares the client-callable functions these tests invoke.
// `defaultCatalog` declares none — and a catalogue that declares nothing callable
// is a refusal, not a blanket permission, so `callFunction` needs this.
const callableCatalog = defineCatalog({
  ...defaultCatalog,
  functions: {
    getLocale: { name: "getLocale" },
    ping: { name: "ping" },
    f: { name: "f" },
  },
});

function callableBridge(over: Partial<A2UISurfaceBridgeOptions> = {}) {
  return newBridge({ catalog: callableCatalog, ...over });
}
function makeBridge(o: A2UISurfaceBridgeOptions) {
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

  it('set at the root path replaces the whole data model (pointer "")', () => {
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

// ── callFunction (bidirectional RPC) ────────────────────────────────────────────

const asCallFunction = (m: A2UIServerMessage) =>
  (m as { callFunction: CallFunctionPayload }).callFunction;

describe("A2UISurfaceBridge — callFunction / ingestFunctionResponse", () => {
  it("callFunction emits a well-formed request with this surface's id and the caller's callId", () => {
    const b = callableBridge();
    const msg = b.callFunction("getLocale", { hint: "browser" }, { callId: "exec-1:step-7" });
    expect(msg.version).toBe(A2UI_VERSION);
    expect(asCallFunction(msg)).toEqual({
      surfaceId: "ui:exec-1",
      callId: "exec-1:step-7",
      name: "getLocale",
      args: { hint: "browser" },
    });
  });

  it("callFunction omits args when undefined and forwards callableFrom", () => {
    const b = callableBridge();
    const msg = b.callFunction("ping", undefined, { callId: "c1", callableFrom: "root" });
    expect(asCallFunction(msg)).toEqual({
      surfaceId: "ui:exec-1",
      callId: "c1",
      name: "ping",
      callableFrom: "root",
    });
  });

  it("callId is a pure echo of the caller's key — stable across bridge instances (replay-safe)", () => {
    // The bridge is clock/random-free: two independently constructed bridges for
    // the same execution produce byte-identical requests for the same callId.
    const a = callableBridge();
    const b = callableBridge();
    const ma = asCallFunction(a.callFunction("f", { x: 1 }, { callId: "exec-1:s1" }));
    const mb = asCallFunction(b.callFunction("f", { x: 1 }, { callId: "exec-1:s1" }));
    expect(ma).toEqual(mb);
  });

  it("ingestFunctionResponse returns the payload when it targets this surface", () => {
    const b = newBridge();
    const functionResponse: FunctionResponsePayload = {
      surfaceId: "ui:exec-1",
      callId: "exec-1:step-7",
      name: "getLocale",
      result: "en-GB",
    };
    expect(b.ingestFunctionResponse({ version: A2UI_VERSION, functionResponse })).toEqual(
      functionResponse
    );
  });

  it("ingestFunctionResponse returns null for another surface or a non-response", () => {
    const b = newBridge();
    expect(
      b.ingestFunctionResponse({
        version: A2UI_VERSION,
        functionResponse: { surfaceId: "other", callId: "c", name: "f" },
      })
    ).toBeNull();
    expect(
      b.ingestFunctionResponse({
        version: A2UI_VERSION,
        action: { surfaceId: "ui:exec-1", action: "x" },
      })
    ).toBeNull();
    expect(b.ingestFunctionResponse({ version: A2UI_VERSION, error: "boom" })).toBeNull();
  });

  it("ingestFunctionResponse rejects a forged/replayed callId when expectedCallId is given", () => {
    const b = newBridge();
    const msg = {
      version: A2UI_VERSION,
      functionResponse: {
        surfaceId: "ui:exec-1",
        callId: "exec-1:getLocale#1",
        name: "getLocale",
        result: { locale: "en-GB" },
      },
    };
    // Matches the outstanding request → accepted.
    expect(b.ingestFunctionResponse(msg, "exec-1:getLocale#1")?.result).toEqual({
      locale: "en-GB",
    });
    // Surface matches but callId doesn't (forged / stale) → rejected.
    expect(b.ingestFunctionResponse(msg, "exec-1:getLocale#2")).toBeNull();
  });
});

// ── Grain B — registerA2UICallFunction effect ───────────────────────────────────

// A capturing fake so we can drive the registered effect directly.
function captureEffect(): {
  runtime: EffectRuntime;
  get(): Effect<A2UICallFunctionInput, unknown>;
} {
  let captured: Effect<A2UICallFunctionInput, unknown> | undefined;
  const runtime = {
    register(_id: string, effect: Effect) {
      captured = effect as Effect<A2UICallFunctionInput, unknown>;
    },
  } as unknown as EffectRuntime;
  return {
    runtime,
    get() {
      if (captured === undefined) throw new Error("no effect registered");
      return captured;
    },
  };
}

function effectCtx(over: Partial<EffectContext> = {}): EffectContext {
  return {
    executionId: "exec-1",
    stepId: "step-7",
    workflowId: "wf",
    attempt: 1,
    idempotencyKey: "exec-1:step-7",
    emit() {},
    ...over,
  };
}

describe("registerA2UICallFunction (grain B)", () => {
  it("registers under the default tool id and declares the effect non-idempotent", () => {
    const cap = captureEffect();
    const toolId = registerA2UICallFunction(cap.runtime, {
      call: async () => ({ surfaceId: "ui:exec-1", callId: "c", name: "f", result: null }),
    });
    expect(toolId).toBe("a2ui.callFunction");
    // K9.3 — mutating client call: recovery must not silently re-run.
    expect(cap.get().idempotent).toBe(false);
    expect(cap.get().kind).toBe("a2a");
  });

  it("keys the request by ctx.idempotencyKey and returns the client's result", async () => {
    const cap = captureEffect();
    let seen: CallFunctionPayload | undefined;
    registerA2UICallFunction(cap.runtime, {
      call: async (req) => {
        seen = req;
        return { surfaceId: req.surfaceId, callId: req.callId, name: req.name, result: "en-GB" };
      },
    });
    const out = await cap
      .get()
      .execute(
        { surfaceId: "ui:exec-1", name: "getLocale", args: { hint: "browser" } },
        effectCtx()
      );
    expect(out).toBe("en-GB");
    expect(seen).toEqual({
      surfaceId: "ui:exec-1",
      callId: "exec-1:step-7", // = ctx.idempotencyKey
      name: "getLocale",
      args: { hint: "browser" },
    });
  });

  it("derives the same callId across a crash-recovery re-issue (at-least-once dedup)", async () => {
    const cap = captureEffect();
    const ids: string[] = [];
    registerA2UICallFunction(cap.runtime, {
      call: async (req) => {
        ids.push(req.callId);
        return { surfaceId: req.surfaceId, callId: req.callId, name: req.name, result: 1 };
      },
    });
    const input = { surfaceId: "ui:exec-1", name: "confirm" };
    // First attempt, then a recovery re-run: attempt advances but the key is stable.
    await cap.get().execute(input, effectCtx({ attempt: 1 }));
    await cap.get().execute(input, effectCtx({ attempt: 2 }));
    expect(ids).toEqual(["exec-1:step-7", "exec-1:step-7"]);
  });

  it("throws when the client returns the error leg", async () => {
    const cap = captureEffect();
    registerA2UICallFunction(cap.runtime, {
      call: async (req) => ({
        surfaceId: req.surfaceId,
        callId: req.callId,
        name: req.name,
        error: "user cancelled",
      }),
    });
    await expect(
      cap.get().execute({ surfaceId: "ui:exec-1", name: "confirm" }, effectCtx())
    ).rejects.toThrow(/user cancelled/);
  });

  it("rejects a mis-correlated response (wrong callId) instead of adopting it", async () => {
    const cap = captureEffect();
    registerA2UICallFunction(cap.runtime, {
      // A mis-wiring transport that returns some OTHER call's reply.
      call: async (req) => ({
        surfaceId: req.surfaceId,
        callId: "some-other-call",
        name: req.name,
        result: "leaked",
      }),
    });
    await expect(
      cap.get().execute({ surfaceId: "ui:exec-1", name: "confirm" }, effectCtx())
    ).rejects.toThrow(/mis-correlated/);
  });

  it("times out a transport that never resolves (bounds the effect)", async () => {
    const cap = captureEffect();
    registerA2UICallFunction(
      cap.runtime,
      { call: () => new Promise(() => {}) }, // never resolves
      { requestTimeoutMs: 20 }
    );
    await expect(
      cap.get().execute({ surfaceId: "ui:exec-1", name: "confirm" }, effectCtx())
    ).rejects.toThrow(/timed out after 20ms/);
  });

  // ADR 0073 — this effect's recovery story IS the journal: `idempotent: false`
  // means a crash mid-call parks at EFFECT_INDOUBT, and the deterministic callId
  // is `ctx.idempotencyKey`. Neither exists transiently, so the seam is pinned.
  it("is declared journaled, and refuses a transient invocation", async () => {
    const runtime = new EffectRuntime();
    registerA2UICallFunction(runtime, {
      call: async (req) => ({
        surfaceId: req.surfaceId,
        callId: req.callId,
        name: req.name,
        result: 1,
      }),
    });

    await expect(
      runtime.invokeTransient(A2UI_CALL_FUNCTION_TOOL_ID, {
        surfaceId: "ui:exec-1",
        name: "confirm",
      })
    ).rejects.toThrow(EffectModeViolationError);
  });
});

// ── recompose across multiple batches — the client's merged view ──────────────
//
// A client MERGES `updateComponents` by id, so a component sent in one batch is
// still there when a LATER batch arrives — even though the bridge's own
// `components` field is replaced wholesale by each `recompose` call. Structural
// validation has to track that merge, not just the latest batch.
describe("A2UISurfaceBridge — validation tracks the client's MERGED tree across recomposes", () => {
  it("a third batch may reference a sibling introduced by an EARLIER batch, not just the first one", () => {
    const b = newBridge(); // view = [column("root", ["status"]), text("status", bind("/status"))]
    b.snapshot();
    // Batch 1 adds "panel", unconnected to root (fine — requireRoot is false).
    expect(b.recompose([row("panel", ["status"])])).toHaveLength(1);
    // Batch 2 references "panel" from batch 1, not anything in batch 2 itself.
    const messages = b.recompose([text("panelLabel", "hi")]);
    expect(messages).toHaveLength(1);
    // Batch 3 finally wires "panel" to "panelLabel" — both from earlier batches.
    expect(b.recompose([row("panel", ["panelLabel"])])).toHaveLength(1);
  });

  it("REFUSES a batch referencing an id that was never sent in any batch", () => {
    const b = newBridge();
    b.snapshot();
    b.recompose([row("panel", ["status"])]);
    expect(() => b.recompose([row("other", ["never-sent"])])).toThrow(/dangling-child/);
  });
});
