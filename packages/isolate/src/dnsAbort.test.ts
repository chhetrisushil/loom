import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

// A stalled getaddrinfo must not hold a fetch (and its concurrency slot) past the deadline.
const lookupImpl = vi.hoisted(() => ({
  fn: (_host: string): Promise<{ address: string; family: number }> => new Promise(() => {}),
}));
vi.mock("node:dns/promises", () => ({ lookup: (h: string) => lookupImpl.fn(h) }));

import { IsolatedToolEffect } from "./IsolatedToolEffect";
import { brokeredFetch } from "./broker";

let server: http.Server | undefined;
afterEach(async () => {
  lookupImpl.fn = () => new Promise(() => {});
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server?.close(r));
    server = undefined;
  }
});

describe("DNS lookup is bound by the fetch deadline", () => {
  it("replies FETCH_TIMEOUT at once but holds the slot until the stalled lookup settles", async () => {
    let finishLookup: (() => void) | undefined;
    lookupImpl.fn = () =>
      new Promise((resolve) => {
        finishLookup = () => resolve({ address: "127.0.0.1", family: 4 });
      });
    const effect = new IsolatedToolEffect({
      id: "dns",
      modulePath: "/nonexistent.js",
      egress: ["stalled.test:80"],
      fetchTimeoutMs: 100,
    });
    const sent: unknown[] = [];
    const child = { send: (m: unknown) => sent.push(m) };
    const t0 = Date.now();
    const ctx = { executionId: "e", stepId: "s", workflowId: "w", attempt: 1, emit: vi.fn() };
    // biome-ignore lint/suspicious/noExplicitAny: reaching the private broker path under test
    await (effect as any).handleFetch(child, 0, "http://stalled.test/", undefined, ctx);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((sent[0] as { code?: string }).code).toBe("FETCH_TIMEOUT");
    // The tool was answered, but getaddrinfo is still occupying a thread: the slot stays held.
    // biome-ignore lint/suspicious/noExplicitAny: slot counter under test
    expect((effect as any).inFlightFetches).toBe(1);
    finishLookup?.();
    await new Promise((r) => setTimeout(r, 20));
    // biome-ignore lint/suspicious/noExplicitAny: slot counter under test
    expect((effect as any).inFlightFetches).toBe(0);
  });

  it("pending lookups never exceed maxConcurrentFetches, even after every fetch timed out", async () => {
    const finish: (() => void)[] = [];
    let lookups = 0;
    lookupImpl.fn = () =>
      new Promise((resolve) => {
        lookups += 1;
        finish.push(() => resolve({ address: "127.0.0.1", family: 4 }));
      });
    const effect = new IsolatedToolEffect({
      id: "dns2",
      modulePath: "/nonexistent.js",
      egress: ["stalled.test:80"],
      fetchTimeoutMs: 30,
      maxConcurrentFetches: 2,
    });
    const sent: { code?: string; error?: string }[] = [];
    const child = { send: (m: unknown) => sent.push(m as { code?: string }) };
    const emit = vi.fn();
    const ctx = { executionId: "e", stepId: "s", workflowId: "w", attempt: 1, emit };
    const fetchOnce = (id: number) =>
      // biome-ignore lint/suspicious/noExplicitAny: reaching the private broker path under test
      (effect as any).handleFetch(child, id, "http://stalled.test/", undefined, ctx);
    await Promise.all([fetchOnce(0), fetchOnce(1)]);
    expect(sent.map((m) => m.code)).toEqual(["FETCH_TIMEOUT", "FETCH_TIMEOUT"]);
    // Both lookups are still pending, so a third fetch is refused instead of starting lookup #3.
    await fetchOnce(2);
    expect(lookups).toBe(2);
    expect(sent[2]?.error).toContain("concurrent");
    expect(emit).toHaveBeenCalledWith("EGRESS_DENIED", expect.anything());
    for (const f of finish) f();
    await new Promise((r) => setTimeout(r, 20));
    // biome-ignore lint/suspicious/noExplicitAny: slot counter under test
    expect((effect as any).inFlightFetches).toBe(0);
  });

  it("an abort that lands during the lookup never opens a connection", async () => {
    let hits = 0;
    server = http.createServer((_q, r) => {
      hits += 1;
      r.end("ok");
    });
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    lookupImpl.fn = () =>
      new Promise((resolve) => setTimeout(() => resolve({ address: "127.0.0.1", family: 4 }), 80));
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error("gone")), 10);
    await expect(
      brokeredFetch("t", new Set([`svc.test:${port}`]), `http://svc.test:${port}/`, {}, ac.signal)
    ).rejects.toThrow("gone");
    await new Promise((r) => setTimeout(r, 150)); // outlive the lookup
    expect(hits).toBe(0);
  });
});
