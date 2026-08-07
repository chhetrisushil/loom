// ── The ONE surface-host template ────────────────────────────────────────────
//
// MCP Apps ships CODE — an HTML resource the host renders in a sandboxed iframe.
// That is the property A2UI deliberately lacks, and the one that looked fatal
// for a replayable system. It is neutralised by never generating markup per
// flow: this module exports a SINGLE static template whose only job is to render
// a declarative payload (the A2UI catalog component tree + data model) delivered
// as `structuredContent`, and to route user actions back as `tools/call`.
//
// The consequences of that choice are the whole design:
//
//   • No code is generated per app, so the template is a fixed, versioned,
//     reviewable build artifact — exactly what the extension's pre-declaration
//     security model assumes (hosts prefetch and review templates up front).
//   • The rendered UI is a pure function of (pinned template hash, logged
//     `structuredContent`). Both halves are in the log, so a replay cannot
//     silently render different markup than the original run.
//   • MCP Apps becomes a second TRANSPORT BINDING for a surface protocol loom
//     already ships, not a second UI protocol to maintain.
//
// The template is deliberately dependency-free and CSP-friendly: no external
// fetches, no inline event handlers, no `eval`. It reads its data from the
// host's `ui/notifications/tool-result` and re-reads via the ambient surface
// cursor tool.

import { hashResourceBody } from "@loom/plugin-mcp";

/** The URI the surface-host template is published under. */
export const SURFACE_HOST_URI = "ui://loom/surface-host";

/** MIME type required by the extension for HTML apps. */
export const SURFACE_HOST_MIME_TYPE = "text/html;profile=mcp-app";

/**
 * The static template source.
 *
 * Rendering is a straight walk of the A2UI adjacency-list component tree: nodes
 * reference children by id, exactly one node has `id: "root"`, and a prop is
 * either a literal or a `{ path }` binding resolved against the data model by
 * JSON Pointer. Anything the catalog does not define is skipped rather than
 * guessed — an unknown component type renders nothing, never raw HTML.
 */
export const SURFACE_HOST_TEMPLATE = `<!-- @loom/plugin-mcp-app surface host (static; pinned by content hash) -->
<div id="loom-root" data-empty="true"></div>
<style>
  #loom-root { font: 14px/1.5 var(--font-sans, system-ui, sans-serif); color: var(--color-text-primary, CanvasText); }
  .loom-row { display: flex; gap: 8px; align-items: center; }
  .loom-col { display: flex; flex-direction: column; gap: 8px; }
  .loom-badge { display: inline-block; padding: 2px 8px; border-radius: var(--border-radius-small, 999px); background: var(--color-background-subtle, rgba(127,127,127,.15)); }
  .loom-btn { padding: 6px 12px; border-radius: var(--border-radius-small, 6px); border: 1px solid var(--color-border-primary, currentColor); background: transparent; color: inherit; cursor: pointer; font: inherit; }
</style>
<script>
(function () {
  "use strict";
  var root = document.getElementById("loom-root");
  var model = {};
  var components = [];
  var nextId = 1;
  var pending = {};
  // Decision provenance: the surface sequence this View has folded. Echoed on
  // every action so a flow can tell what the user was actually looking at.
  var sequence = 0;
  var executionId = null;
  var poller = null;
  var POLL_MS = 2000;

  // ── JSON-RPC over postMessage (the extension's bridge) ────────────────────
  function send(msg) { window.parent.postMessage(msg, "*"); }
  function request(method, params) {
    var id = nextId++;
    send({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) { pending[id] = { resolve: resolve, reject: reject }; });
  }
  function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params || {} }); }

  // ── JSON Pointer (RFC 6901) resolution for data bindings ──────────────────
  function resolvePointer(doc, pointer) {
    if (pointer === "" || pointer == null) return doc;
    var parts = String(pointer).replace(/^\\//, "").split("/");
    var cur = doc;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i].replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return cur;
  }
  // A prop is a literal, or a binding { path }. Bindings never execute anything.
  function value(prop) {
    if (prop && typeof prop === "object" && typeof prop.path === "string") return resolvePointer(model, prop.path);
    return prop;
  }
  function text(prop) {
    var v = value(prop);
    return v == null ? "" : String(v);
  }

  function byId(id) {
    for (var i = 0; i < components.length; i++) if (components[i].id === id) return components[i];
    return null;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  // textContent everywhere — a surface value is agent/user data and is never
  // interpreted as markup, so a data model can't inject DOM into the host page.
  function render(node) {
    if (!node) return null;
    var el;
    switch (node.component) {
      case "Text":
        el = document.createElement("div");
        el.textContent = text(node.text);
        return el;
      case "Badge":
        el = document.createElement("span");
        el.className = "loom-badge";
        el.textContent = text(node.label);
        return el;
      case "Row":
      case "Column":
        el = document.createElement("div");
        el.className = node.component === "Row" ? "loom-row" : "loom-col";
        (node.children || []).forEach(function (cid) {
          var child = render(byId(cid));
          if (child) el.appendChild(child);
        });
        return el;
      case "List": {
        el = document.createElement("div");
        el.className = "loom-col";
        var items = value(node.items);
        if (Array.isArray(items)) {
          items.forEach(function (item) {
            var line = document.createElement("div");
            line.textContent = typeof item === "object" ? JSON.stringify(item) : String(item);
            el.appendChild(line);
          });
        }
        return el;
      }
      case "Button":
        el = document.createElement("button");
        el.className = "loom-btn";
        el.type = "button";
        el.textContent = text(node.label);
        el.addEventListener("click", function () {
          // A user action is a JOURNALED call: it names the action the surface
          // declared, and the server decides whether an app may make it.
          //
          // seenSequence is the point of this: a gate can sit open for days
          // while the surface advances, so the flow needs to know WHICH version
          // of the data the human was looking at when they decided. Without it
          // an approval is indistinguishable from one made against arbitrarily
          // stale state.
          request("tools/call", {
            name: node.action,
            arguments: {
              surfaceId: model.__surfaceId,
              action: node.action,
              seenSequence: sequence
            }
          }).catch(function () { /* the host surfaces the failure */ });
        });
        return el;
      default:
        return null;
    }
  }

  function paint() {
    root.setAttribute("data-empty", components.length === 0 ? "true" : "false");
    root.textContent = "";
    var tree = render(byId("root"));
    if (tree) root.appendChild(tree);
    notify("ui/notifications/size-changed", { width: document.body.scrollWidth, height: document.body.scrollHeight });
  }

  function adopt(payload) {
    if (!payload || typeof payload !== "object") return;
    if (payload.changed === false) return; // cursor says nothing advanced
    if (Array.isArray(payload.components)) components = payload.components;
    // The payload is always a COMPLETE model, never a delta — a partial surface
    // fold cannot express a removal and cannot be merged without corrupting
    // nested paths, so replacing wholesale is the correct move.
    if (payload.dataModel && typeof payload.dataModel === "object") model = payload.dataModel;
    if (typeof payload.surfaceId === "string") model.__surfaceId = payload.surfaceId;
    if (typeof payload.executionId === "string") executionId = payload.executionId;
    if (typeof payload.sequence === "number") sequence = payload.sequence;
    paint();
  }

  // The extension has no server push, so the View polls its own cursor. The
  // no-change reply is cheap by design (the server only reads the tail past the
  // cursor), which is what makes a poll this frequent acceptable.
  function poll() {
    if (executionId == null) return;
    request("tools/call", {
      name: "loom.surface.since",
      arguments: { executionId: executionId, fromSequence: sequence }
    }).then(function (res) {
      adopt((res && res.structuredContent) || null);
    }).catch(function () { /* transient; the next tick retries */ });
  }

  function startPolling() {
    if (poller == null) poller = setInterval(poll, POLL_MS);
  }
  function stopPolling() {
    if (poller != null) { clearInterval(poller); poller = null; }
  }

  window.addEventListener("message", function (event) {
    var msg = event.data;
    if (!msg || msg.jsonrpc !== "2.0") return;

    if (msg.id != null && pending[msg.id]) {
      var slot = pending[msg.id];
      delete pending[msg.id];
      if (msg.error) slot.reject(msg.error); else slot.resolve(msg.result);
      return;
    }
    if (msg.method === "ui/notifications/tool-result") {
      var result = (msg.params && msg.params.result) || msg.params || {};
      adopt(result.structuredContent);
      return;
    }
    if (msg.method === "ui/resource-teardown") {
      stopPolling();
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }
  });

  // Handshake, then announce readiness. The extension has no server push, so a
  // refresh is a view-initiated ambient read via the surface cursor tool.
  request("ui/initialize", {
    capabilities: {},
    clientInfo: { name: "loom-surface-host", version: "1" },
    protocolVersion: "2026-01-26",
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] }
  }).then(function (res) {
    if (res && res.hostContext && res.hostContext.toolInfo) { /* reserved for future use */ }
    notify("ui/notifications/initialized", {});
    startPolling();
  }).catch(function () { /* a host that refuses the handshake leaves the view inert */ });
})();
</script>`;

/**
 * The template's content pin — `fnv1a64:<hex16>` over the template source.
 *
 * Capture this at plan time and verify it before rendering. It is the same
 * discipline ADR 0063 applies to tool input schemas, for the same reason: a
 * pinned artifact that silently changes turns a deterministic replay into a
 * different observable outcome, and nothing else in the system would notice.
 *
 * Deliberately delegates to `@loom/plugin-mcp`'s `hashResourceBody` — the SAME
 * function the ingress side applies to a fetched `ui://` resource. A pin is only
 * useful if the value captured at plan time is the value a reader recomputes;
 * two hashing implementations that mostly agree is precisely how a pin stops
 * detecting the drift it exists to detect (ADR 0063 D1).
 */
export function surfaceHostPin(template: string = SURFACE_HOST_TEMPLATE): string {
  return `fnv1a64:${hashResourceBody({ uri: SURFACE_HOST_URI, text: template })}`;
}

/** Raised when a pinned template no longer matches what is about to be served. */
export class TemplateDriftError extends Error {
  readonly expected: string;
  readonly observed: string;
  constructor(expected: string, observed: string) {
    super(
      `MCP App surface-host template drifted: pinned ${expected}, found ${observed}. A replay would render different markup than the original run; re-pin deliberately.`
    );
    this.name = "TemplateDriftError";
    this.expected = expected;
    this.observed = observed;
  }
}

/**
 * Verify a pin, throwing {@link TemplateDriftError} on mismatch. Returns the
 * observed pin so a caller can record it.
 */
export function verifySurfaceHostPin(
  expected: string,
  template: string = SURFACE_HOST_TEMPLATE
): string {
  const observed = surfaceHostPin(template);
  if (observed !== expected) throw new TemplateDriftError(expected, observed);
  return observed;
}
