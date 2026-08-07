import { SURFACE_PATCH } from "@loom/agent-surface";
import type { EventEnvelope } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { McpClient, createMcpServer, servedEffect } from "@loom/plugin-mcp";
import type { McpServer } from "@loom/plugin-mcp";
import { afterEach, describe, expect, it } from "vitest";
import { surfaceHostResource } from "./serve";
import { surfacePayload } from "./surfaceBridge";
import { surfaceCursorTool } from "./surfaceCursor";
import {
  SURFACE_HOST_MIME_TYPE,
  SURFACE_HOST_TEMPLATE,
  SURFACE_HOST_URI,
  TemplateDriftError,
  surfaceHostPin,
  verifySurfaceHostPin,
} from "./template";

const COMPONENTS = [
  { id: "root", component: "Column", children: ["title", "count"] },
  { id: "title", component: "Text", text: { path: "/title" } },
  { id: "count", component: "Badge", label: { path: "/count" } },
];

function patch(executionId: string, sequence: number, patches: unknown): EventEnvelope {
  return {
    id: `e${sequence}`,
    workflowId: "wf",
    executionId,
    eventType: SURFACE_PATCH,
    sequence,
    timestamp: 0,
    payload: { patches },
  };
}

let server: McpServer | undefined;
afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
});

describe("the static surface-host template", () => {
  // The template is the ONE piece of code that ships. Its whole justification is
  // that it is fixed and reviewable, so these assert the properties that make it
  // safe rather than what it renders.
  it("ships no per-app code: one template, stable pin", () => {
    expect(surfaceHostPin()).toBe(surfaceHostPin());
    expect(surfaceHostPin()).toMatch(/^fnv1a64:[0-9a-f]{16}$/);
  });

  it("is self-contained — no external fetches for a CSP to have to allow", () => {
    expect(SURFACE_HOST_TEMPLATE).not.toMatch(/\bsrc\s*=\s*["']https?:/i);
    expect(SURFACE_HOST_TEMPLATE).not.toMatch(/\bimport\s*\(/);
    expect(SURFACE_HOST_TEMPLATE).not.toMatch(/\bfetch\s*\(/);
    expect(SURFACE_HOST_TEMPLATE).not.toMatch(/\beval\s*\(/);
    expect(SURFACE_HOST_TEMPLATE).not.toMatch(/new Function/);
  });

  // Surface values are agent/user data. Rendering them as markup would make any
  // logged string a script-injection vector into the host page.
  it("renders values as text, never as markup", () => {
    expect(SURFACE_HOST_TEMPLATE).toContain("textContent");
    expect(SURFACE_HOST_TEMPLATE).not.toContain("innerHTML");
    expect(SURFACE_HOST_TEMPLATE).not.toContain("outerHTML");
    expect(SURFACE_HOST_TEMPLATE).not.toContain("insertAdjacentHTML");
  });

  it("verifies a matching pin and refuses a drifted one", () => {
    expect(verifySurfaceHostPin(surfaceHostPin())).toBe(surfaceHostPin());
    expect(() => verifySurfaceHostPin("fnv1a64:0000000000000000")).toThrow(TemplateDriftError);
  });

  // A replay that renders different markup than the original run is a silent
  // correctness bug — the pin is what turns it into a loud one.
  it("detects drift when the template body changes", () => {
    const pinned = surfaceHostPin();
    expect(() => verifySurfaceHostPin(pinned, `${SURFACE_HOST_TEMPLATE}<!-- edit -->`)).toThrow(
      TemplateDriftError
    );
  });

  it("publishes as a resource, verifying the pin before serving", () => {
    const res = surfaceHostResource({ pin: surfaceHostPin() });
    expect(res.uri).toBe(SURFACE_HOST_URI);
    expect(res.mimeType).toBe(SURFACE_HOST_MIME_TYPE);
    expect(res.text).toBe(SURFACE_HOST_TEMPLATE);

    expect(() => surfaceHostResource({ pin: "fnv1a64:0000000000000000" })).toThrow(
      TemplateDriftError
    );
  });

  it("declares no CSP domains by default, so a host applies its restrictive default", () => {
    expect(surfaceHostResource().meta).toBeUndefined();
    expect(surfaceHostResource({ connectDomains: ["https://a.example"] }).meta?.csp).toEqual({
      connectDomains: ["https://a.example"],
    });
  });
});

describe("surface payload", () => {
  it("folds SURFACE_PATCH events into a data model plus a cursor", () => {
    const payload = surfacePayload(
      [
        patch("x1", 1, [{ op: "set", path: "title", value: "Report" }]),
        patch("x1", 2, [{ op: "set", path: "count", value: 1 }]),
        patch("x1", 3, [{ op: "increment", path: "count", by: 4 }]),
      ],
      { executionId: "x1", components: COMPONENTS, redact: [] }
    );

    expect(payload.dataModel).toEqual({ title: "Report", count: 5 });
    expect(payload.sequence).toBe(3);
    expect(payload.surfaceId).toBe("ui:x1");
    expect(payload.components).toEqual(COMPONENTS);
  });

  it("ignores unrelated events but still advances the cursor", () => {
    const other: EventEnvelope = {
      id: "e2",
      workflowId: "wf",
      executionId: "x1",
      eventType: "STEP_COMPLETED",
      sequence: 2,
      timestamp: 0,
      payload: {},
    };
    const payload = surfacePayload(
      [patch("x1", 1, [{ op: "set", path: "title", value: "T" }]), other],
      { executionId: "x1", components: COMPONENTS, redact: [] }
    );

    expect(payload.dataModel).toEqual({ title: "T" });
    // The cursor must track the LOG, not just surface events, or a poll would
    // re-read every non-surface event forever.
    expect(payload.sequence).toBe(2);
  });

  it("ignores patches aimed at a different surface", () => {
    const sidebar: EventEnvelope = {
      ...patch("x1", 2, [{ op: "set", path: "title", value: "SIDEBAR" }]),
      payload: { surface: "sidebar", patches: [{ op: "set", path: "title", value: "SIDEBAR" }] },
    };
    const payload = surfacePayload(
      [patch("x1", 1, [{ op: "set", path: "title", value: "MAIN" }]), sidebar],
      { executionId: "x1", components: COMPONENTS, redact: [] }
    );
    expect(payload.dataModel).toEqual({ title: "MAIN" });
  });

  // K10-R6: the payload crosses the trust boundary into a rendered iframe.
  it("masks redacted paths on egress while folding true values internally", () => {
    const payload = surfacePayload(
      [
        patch("x1", 1, [{ op: "set", path: "secretCount", value: 10 }]),
        patch("x1", 2, [{ op: "increment", path: "secretCount", by: 5 }]),
        patch("x1", 3, [{ op: "set", path: "title", value: "ok" }]),
      ],
      { executionId: "x1", components: COMPONENTS, redact: ["secretCount"] }
    );

    // The increment folded against the TRUE value (10+5), then the result was
    // masked — masking before the fold would have corrupted the arithmetic.
    expect(payload.dataModel.secretCount).not.toBe(15);
    expect(payload.dataModel.title).toBe("ok");
  });
});

describe("the app-visibility surface cursor", () => {
  it("is declared ambient and app-only", () => {
    const tool = surfaceCursorTool({
      store: new InMemoryAsyncEventStore(),
      components: COMPONENTS,
      redact: [],
    });
    // The two declarations that make it safe: never journaled, never offered to
    // the model.
    expect(tool.mode).toBe("ambient");
    expect(tool.ui?.visibility).toEqual(["app"]);
  });

  it("reads a surface from a sequence cursor", async () => {
    const store = new InMemoryAsyncEventStore();
    await store.append(patch("x1", 1, [{ op: "set", path: "title", value: "A" }]));
    await store.append(patch("x1", 2, [{ op: "set", path: "count", value: 3 }]));

    const tool = surfaceCursorTool({ store, components: COMPONENTS, redact: [] });
    const full = (await tool.handler({ executionId: "x1" }, {} as never)) as {
      dataModel: Record<string, unknown>;
      sequence: number;
    };
    expect(full.dataModel).toEqual({ title: "A", count: 3 });
    expect(full.sequence).toBe(2);

    // A cursored read folds only the tail — the View merges it onto what it has.
    const tail = (await tool.handler({ executionId: "x1", fromSequence: 2 }, {} as never)) as {
      dataModel: Record<string, unknown>;
    };
    expect(tail.dataModel).toEqual({ count: 3 });
  });

  it("rejects a missing executionId", async () => {
    const tool = surfaceCursorTool({
      store: new InMemoryAsyncEventStore(),
      components: COMPONENTS,
      redact: [],
    });
    await expect(tool.handler({}, {} as never)).rejects.toThrow(/executionId/);
  });

  // A rendered View is untrusted and execution ids are guessable.
  it("applies the authorize hook, and does not confirm existence when denying", async () => {
    const store = new InMemoryAsyncEventStore();
    await store.append(patch("secret-exec", 1, [{ op: "set", path: "title", value: "T" }]));

    const tool = surfaceCursorTool({
      store,
      components: COMPONENTS,
      redact: [],
      authorize: (id) => id === "allowed",
    });
    await expect(tool.handler({ executionId: "secret-exec" }, {} as never)).rejects.toThrow(
      /no surface for execution/
    );
  });
});

describe("MCP server — audience and seam boundaries", () => {
  async function serve(overrides: Parameters<typeof createMcpServer>[0] = {}) {
    const s = createMcpServer({ port: 0, ...overrides });
    await s.start();
    server = s;
    return s;
  }

  it("serves the template over resources/read", async () => {
    const s = await serve({ resources: [surfaceHostResource({ pin: surfaceHostPin() })] });
    const client = new McpClient({ transport: "http", url: s.url });

    const res = await client.readUiResource(SURFACE_HOST_URI);
    expect(res?.text).toBe(SURFACE_HOST_TEMPLATE);
    // Round-trip: the pin the server published is the pin the client computes.
    expect(res?.contentHash).toBe(surfaceHostPin());
  });

  it("hides app-only tools from the model and vice versa", async () => {
    const s = await serve({
      tools: [
        surfaceCursorTool({
          store: new InMemoryAsyncEventStore(),
          components: COMPONENTS,
          redact: [],
        }),
        {
          name: "summarize",
          inputSchema: { type: "object" },
          ui: { resourceUri: SURFACE_HOST_URI, visibility: ["model"] },
          handler: async () => ({ ok: true }),
        },
      ],
      audienceOf: (req) => (req.headers["x-audience"] === "app" ? "app" : "model"),
    });

    const asModel = new McpClient({ transport: "http", url: s.url });
    expect((await asModel.listTools()).map((t) => t.definition.id)).toEqual(["summarize"]);

    const asApp = new McpClient({
      transport: "http",
      url: s.url,
      headers: { "x-audience": "app" },
    });
    expect((await asApp.listTools()).map((t) => t.definition.id)).toEqual(["loom.surface.since"]);
  });

  // The heart of it: a View can call any tool the host proxies. Enrichment is
  // fine; a call that appends to the log is a state transition requested by the
  // user's UI and must not inherit the flow's authority.
  it("denies app-originated calls to journaled tools by default", async () => {
    const s = await serve({
      tools: [
        {
          name: "approve",
          inputSchema: { type: "object" },
          mode: "journaled",
          ui: { resourceUri: SURFACE_HOST_URI, visibility: ["model", "app"] },
          handler: async () => ({ approved: true }),
        },
      ],
      audienceOf: (req) => (req.headers["x-audience"] === "app" ? "app" : "model"),
    });

    const asApp = new McpClient({
      transport: "http",
      url: s.url,
      headers: { "x-audience": "app" },
    });
    const denied = await asApp.callToolResult("approve", {});
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toMatch(/journaled/);

    // The model's own path is unaffected.
    const asModel = new McpClient({ transport: "http", url: s.url });
    expect(await asModel.callTool("approve", {})).toEqual({ approved: true });
  });

  it("admits an app-originated journaled call when explicitly authorized", async () => {
    const s = await serve({
      tools: [
        {
          name: "approve",
          inputSchema: { type: "object" },
          mode: "journaled",
          handler: async () => ({ approved: true }),
        },
      ],
      audienceOf: () => "app",
      authorizeAppJournaledCall: (tool) => tool.name === "approve",
    });
    const asApp = new McpClient({ transport: "http", url: s.url });
    expect(await asApp.callTool("approve", {})).toEqual({ approved: true });
  });

  it("defaults every request to the model audience, so app-only tools stay closed", async () => {
    const s = await serve({
      tools: [
        surfaceCursorTool({
          store: new InMemoryAsyncEventStore(),
          components: COMPONENTS,
          redact: [],
        }),
      ],
    });
    const client = new McpClient({ transport: "http", url: s.url });
    // Reported as unknown rather than forbidden — a "you may not" reply would
    // confirm the tool exists.
    await expect(client.callTool("loom.surface.since", { executionId: "x" })).rejects.toThrow(
      /unknown tool/
    );
  });

  it("reports a handler throw as an in-band isError result, not a transport error", async () => {
    const s = await serve({
      tools: [
        {
          name: "boom",
          inputSchema: { type: "object" },
          handler: async () => {
            throw new Error("kaboom");
          },
        },
      ],
    });
    const client = new McpClient({ transport: "http", url: s.url });
    const result = await client.callToolResult("boom", {});
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/kaboom/);
  });

  it("returns structuredContent plus a text fallback", async () => {
    const s = await serve({
      tools: [{ name: "t", inputSchema: { type: "object" }, handler: async () => ({ n: 1 }) }],
    });
    const client = new McpClient({ transport: "http", url: s.url });
    const result = await client.callToolResult("t", {});
    expect(result.structuredContent).toEqual({ n: 1 });
    // The extension requires a text-only fallback for hosts without structured
    // output support.
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("gates on the authorize hook", async () => {
    const s = await serve({ authorize: (req) => req.headers["x-key"] === "ok" });
    const bad = new McpClient({ transport: "http", url: s.url });
    await expect(bad.listTools()).rejects.toThrow(/401/);

    const good = new McpClient({
      transport: "http",
      url: s.url,
      headers: { "x-key": "ok" },
    });
    await expect(good.listTools()).resolves.toEqual([]);
  });
});

describe("servedEffect — routing read off the declaration", () => {
  it("routes an ambient tool through invokeTransient, leaving no durable footprint", async () => {
    const rt = new EffectRuntime();
    let calls = 0;
    rt.register(
      "page",
      new ToolEffect(
        async () => {
          calls++;
          return { rows: [1, 2] };
        },
        { mode: "ambient" }
      )
    );

    const tool = servedEffect(rt, "page", { mode: "ambient", inputSchema: { type: "object" } });
    expect(await tool.handler({ page: 2 }, {} as never)).toEqual({ rows: [1, 2] });
    expect(calls).toBe(1);
  });

  it("refuses a journaled tool with no journaled path wired", async () => {
    const rt = new EffectRuntime();
    const tool = servedEffect(rt, "approve", {
      mode: "journaled",
      inputSchema: { type: "object" },
    });
    await expect(tool.handler({}, {} as never)).rejects.toThrow(/no journaled\(\) path/);
  });

  // The declaration is load-bearing, not decorative: routing an ambient tool to
  // the durable path is refused by the boundary check itself.
  it("cannot journal an ambient effect even if a surface tries", async () => {
    const rt = new EffectRuntime();
    rt.register("page", new ToolEffect(async () => null, { mode: "ambient" }));

    await expect(
      rt.execute(
        "page",
        {},
        {
          executionId: "x",
          stepId: "s",
          workflowId: "w",
          attempt: 1,
          emit: () => {},
        }
      )
    ).rejects.toThrow(/ambient/);
  });
});
