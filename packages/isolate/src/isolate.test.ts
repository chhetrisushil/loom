import * as http from "node:http";
import * as path from "node:path";
import { EffectRuntime } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IsolatedToolEffect } from "./IsolatedToolEffect";
import { EgressDeniedError, brokeredFetch } from "./broker";
import type { IsolatedToolSpec } from "./types";

// NOTE: the child runner is compiled output (dist/runner.js) — the build must
// run before these tests (the repo's test task depends on build).
const fixture = (name: string) => path.join(__dirname, "__fixtures__", name);

function makeCtx(overrides: Partial<EffectContext> = {}): EffectContext {
  return {
    executionId: "iso-exec",
    stepId: "iso-step",
    workflowId: "iso-flow",
    attempt: 1,
    idempotencyKey: "iso-exec:iso-step",
    emit: vi.fn(),
    ...overrides,
  };
}

function makeEffect(spec: Partial<IsolatedToolSpec> & { modulePath: string }): IsolatedToolEffect {
  return new IsolatedToolEffect({ id: spec.id ?? "iso-tool", ...spec });
}

const open: IsolatedToolEffect[] = [];
const track = (e: IsolatedToolEffect): IsolatedToolEffect => {
  open.push(e);
  return e;
};
afterEach(() => {
  for (const e of open.splice(0)) e.close();
});

describe("K7 — isolated execution (child-process boundary)", () => {
  it("runs a tool in the child and forwards its emits before the result (A3)", async () => {
    const effect = track(makeEffect({ modulePath: fixture("echo.cjs") }));
    const emit = vi.fn();
    const ctx = makeCtx({ emit });

    const output = (await effect.execute({ n: 42 }, ctx)) as Record<string, unknown>;
    expect(output.echoed).toEqual({ n: 42 });
    expect(output.key).toBe("iso-exec:iso-step"); // the marshaled ctx shim
    expect(emit).toHaveBeenCalledWith("TOOL_NOTE", { seen: { n: 42 }, stepId: "iso-step" });
  });

  it("stays warm: sequential runs reuse one child (pooled executor, A4)", async () => {
    const effect = track(makeEffect({ modulePath: fixture("echo.cjs") }));
    const first = (await effect.execute({ n: 1 }, makeCtx())) as { attempt: number };
    const second = (await effect.execute({ n: 2 }, makeCtx({ attempt: 2 }))) as {
      attempt: number;
    };
    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
  });

  it("K7.2/K7.4 — the child sees ONLY the credentials injected for this tool", async () => {
    process.env.PARENT_SECRET = "the-parent-crown-jewels";
    try {
      const effect = track(
        makeEffect({ modulePath: fixture("env-probe.cjs"), env: { TOOL_SECRET: "tool-only" } })
      );
      const probe = (await effect.execute({}, makeCtx())) as {
        injected: string | null;
        leakedParentSecret: string | null;
        envKeys: string[];
      };
      expect(probe.injected).toBe("tool-only");
      expect(probe.leakedParentSecret).toBeNull(); // parent env is NOT inherited
      // Nothing beyond the injection + PATH — modulo vars the OS itself stamps
      // on every process (e.g. macOS's __CF_USER_TEXT_ENCODING), which don't
      // come from the parent's environment.
      const osInjected = new Set(["__CF_USER_TEXT_ENCODING", "SYSTEMROOT", "WINDIR"]);
      expect(
        probe.envKeys.filter((k) => k !== "TOOL_SECRET" && k !== "PATH" && !osInjected.has(k))
      ).toEqual([]);
    } finally {
      // biome-ignore lint/performance/noDelete: test cleanup
      delete process.env.PARENT_SECRET;
    }
  });

  it("K7.2a — durable-store drivers are unreachable from the child", async () => {
    const effect = track(makeEffect({ modulePath: fixture("store-probe.cjs") }));
    const probe = (await effect.execute({}, makeCtx())) as { store: string };
    expect(probe.store).toBe("unreachable");
  });

  it("a malicious direct dial (require('http')) is blocked before it can connect", async () => {
    const effect = track(makeEffect({ modulePath: fixture("dialer.cjs") }));
    await expect(effect.execute({}, makeCtx())).rejects.toThrow(/blocked.*ctx\.fetch/);
  });

  it("A5/K8 — the kill path is NON-cooperative: aborting SIGKILLs a hung tool", async () => {
    const effect = track(makeEffect({ modulePath: fixture("hang.cjs") }));
    const controller = new AbortController();
    const ctx = makeCtx({ signal: controller.signal });

    const started = Date.now();
    const pending = effect.execute({}, ctx);
    pending.catch(() => {});
    setTimeout(() => controller.abort(new Error("operator kill")), 30);

    await expect(pending).rejects.toThrow(/operator kill/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("timeoutMs reclaims a hung tool without any signal", async () => {
    const effect = track(makeEffect({ modulePath: fixture("hang.cjs"), timeoutMs: 50 }));
    await expect(effect.execute({}, makeCtx())).rejects.toThrow(/exceeded timeoutMs=50/);
  });

  it("carries the K9 idempotent declaration like any tool effect", () => {
    expect(makeEffect({ modulePath: fixture("echo.cjs"), idempotent: false }).idempotent).toBe(
      false
    );
    expect(makeEffect({ modulePath: fixture("echo.cjs") }).idempotent).toBeUndefined();
  });

  it("pre-warm spawns the child before the first execute (no first-call cold start)", async () => {
    const effect = track(makeEffect({ modulePath: fixture("echo.cjs") }));
    // Lazily: no child yet.
    // biome-ignore lint/suspicious/noExplicitAny: reach into the private child for the test
    expect((effect as any).child).toBeUndefined();

    effect.warm();
    // biome-ignore lint/suspicious/noExplicitAny: private field probe
    const warmed = (effect as any).child;
    expect(warmed).toBeDefined(); // child is up before any execute

    // The first execute reuses the SAME warm child (no re-fork).
    await effect.execute({ n: 1 }, makeCtx());
    // biome-ignore lint/suspicious/noExplicitAny: private field probe
    expect((effect as any).child).toBe(warmed);
  });

  it("warm: true in the spec spawns eagerly at construction and the tool still runs", async () => {
    const effect = track(makeEffect({ modulePath: fixture("echo.cjs"), warm: true }));
    // biome-ignore lint/suspicious/noExplicitAny: private field probe
    expect((effect as any).child).toBeDefined();
    const out = (await effect.execute({ n: 5 }, makeCtx())) as { echoed: unknown };
    expect(out.echoed).toEqual({ n: 5 });
  });

  it("warm() is idempotent — repeated calls reuse the one live child", () => {
    const effect = track(makeEffect({ modulePath: fixture("echo.cjs") }));
    effect.warm();
    // biome-ignore lint/suspicious/noExplicitAny: private field probe
    const first = (effect as any).child;
    effect.warm();
    effect.warm();
    // biome-ignore lint/suspicious/noExplicitAny: private field probe
    expect((effect as any).child).toBe(first);
  });

  it("K7.5 — middleware wraps the boundary: the chain runs kernel-side", async () => {
    const order: string[] = [];
    const runtime = new EffectRuntime([
      async (_ctx, _input, next) => {
        order.push("before");
        const result = await next();
        order.push("after");
        return result;
      },
    ]);
    const effect = track(makeEffect({ modulePath: fixture("echo.cjs") }));
    runtime.register("iso-tool", effect);

    await runtime.execute("iso-tool", { n: 7 }, makeCtx());
    expect(order).toEqual(["before", "after"]); // meter/validate positions surround the isolate
  });
});

describe("K7.3 — kernel-side egress broker", () => {
  function serve(): Promise<{ server: http.Server; port: number; hits: () => number }> {
    return new Promise((resolve) => {
      let hits = 0;
      const server = http.createServer((_req, res) => {
        hits++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve({
          server,
          port: typeof addr === "object" && addr !== null ? addr.port : 0,
          hits: () => hits,
        });
      });
    });
  }

  it("allows a listed target through the brokered ctx.fetch (resolve-and-pin)", async () => {
    const { server, port } = await serve();
    try {
      const effect = track(
        makeEffect({ modulePath: fixture("fetcher.cjs"), egress: [`127.0.0.1:${port}`] })
      );
      const out = (await effect.execute({ url: `http://127.0.0.1:${port}/data` }, makeCtx())) as {
        status: number;
        body: string;
      };
      expect(out.status).toBe(200);
      expect(JSON.parse(out.body)).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });

  it("denies an unlisted target BEFORE any connection, with a durable EGRESS_DENIED fact", async () => {
    const { server, port, hits } = await serve();
    try {
      const effect = track(
        makeEffect({ modulePath: fixture("fetcher.cjs"), egress: ["allowed.internal:9090"] })
      );
      const emit = vi.fn();
      await expect(
        effect.execute({ url: `http://127.0.0.1:${port}/data` }, makeCtx({ emit }))
      ).rejects.toThrow(/egress denied/);

      expect(hits()).toBe(0); // refused pre-connection: the server never saw it
      expect(emit).toHaveBeenCalledWith(
        "EGRESS_DENIED",
        expect.objectContaining({
          toolId: "iso-tool",
          stepId: "iso-step",
          target: `127.0.0.1:${port}`,
        })
      );
    } finally {
      server.close();
    }
  });

  it("no egress list means no egress at all", async () => {
    const effect = track(makeEffect({ modulePath: fixture("fetcher.cjs") }));
    await expect(
      effect.execute({ url: "http://anywhere.example:80/" }, makeCtx())
    ).rejects.toThrow(/egress denied/);
  });

  it("brokeredFetch rejects non-http(s) protocols and malformed URLs pre-connection", async () => {
    const allow = new Set(["files.example:21"]);
    await expect(brokeredFetch("t", allow, "ftp://files.example/x")).rejects.toBeInstanceOf(
      EgressDeniedError
    );
    await expect(brokeredFetch("t", allow, "not a url")).rejects.toBeInstanceOf(EgressDeniedError);
  });
});
