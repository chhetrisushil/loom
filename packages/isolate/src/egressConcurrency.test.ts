import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IsolatedToolEffect } from "./IsolatedToolEffect";

// ── K7.3 bounds WHERE, not HOW MANY ──────────────────────────────────────────
//
// The egress allowlist is a static host:port set checked kernel-side before any
// connection. It says nothing about volume, and the broker fires each `fetch`
// message from the child as `void this.handleFetch(...)` — unawaited, uncounted.
//
// The tool inside the isolate is UNTRUSTED by construction; that is the entire
// premise of K7. So a tool that issues fetches in a loop without awaiting them
// drives unbounded concurrent host-side requests against an allowlisted target,
// and grows a parent-side promise per request. The containment boundary holds
// for destination and for credentials, and had no answer for volume.

function fakeChild(): { sent: unknown[]; child: { send: (m: unknown) => void } } {
  const sent: unknown[] = [];
  return { sent, child: { send: (m: unknown) => sent.push(m) } };
}

// The allowlisted target is a loopback server that HOLDS every request until the test releases
// it (L18). These tests used to send the admitted fetches to example.com:443 — a real DNS lookup
// and TLS handshake over the internet, awaited inside vitest's 5 s hang detector, so a slow
// network or a saturated host failed a test about counting. Holding the admitted requests open
// also makes "in flight" a fact rather than a race: every admitted fetch is provably still open
// when the excess is refused.
interface HoldingServer {
  target: string;
  url: string;
  /** Resolves once `n` requests have arrived (and are being held). */
  arrived(n: number): Promise<void>;
  hits(): number;
  /** Resolves once `n` client connections have been closed by the client. */
  closed(n: number): Promise<void>;
  release(): void;
  close(): Promise<void>;
}

async function holdingServer(): Promise<HoldingServer> {
  const held: http.ServerResponse[] = [];
  const waiters: { n: number; resolve: () => void }[] = [];
  let released = false;
  let hits = 0;
  let closedCount = 0;
  const closeWaiters: { n: number; resolve: () => void }[] = [];
  const server = http.createServer((_req, res) => {
    hits += 1;
    res.on("close", () => {
      closedCount += 1;
      for (const w of closeWaiters.splice(0)) {
        if (closedCount >= w.n) w.resolve();
        else closeWaiters.push(w);
      }
    });
    if (released) {
      res.end("ok");
      return;
    }
    held.push(res);
    for (const w of waiters.splice(0)) {
      if (held.length >= w.n) w.resolve();
      else waiters.push(w);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    target: `127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/x`,
    arrived: (n) =>
      held.length >= n ? Promise.resolve() : new Promise((resolve) => waiters.push({ n, resolve })),
    hits: () => hits,
    closed: (n) =>
      closedCount >= n
        ? Promise.resolve()
        : new Promise((resolve) => closeWaiters.push({ n, resolve })),
    release: () => {
      released = true;
      for (const res of held.splice(0)) res.end("ok");
    },
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

let server: HoldingServer | undefined;
afterEach(async () => {
  server?.release();
  await server?.close();
  server = undefined;
});

describe("brokered egress is bounded (K7.3)", () => {
  it("refuses a flood of concurrent fetches instead of issuing them", async () => {
    server = await holdingServer();
    const effect = new IsolatedToolEffect({
      id: "flooder",
      modulePath: "/nonexistent.js",
      egress: [server.target],
      maxConcurrentFetches: 4,
    });
    const { sent, child } = fakeChild();
    const ctx = {
      executionId: "e",
      stepId: "s",
      workflowId: "w",
      attempt: 1,
      emit: vi.fn(),
    };

    const url = server.url;
    // Twenty at once from a tool that never awaits.
    const fetches = Array.from({ length: 20 }, (_, i) =>
      // biome-ignore lint/suspicious/noExplicitAny: reaching the private broker path under test
      (effect as any).handleFetch(child, i, url, undefined, ctx)
    );

    // The four admitted requests reach the target and are held open there…
    await server.arrived(4);
    const replies = sent as { ok: boolean; error?: string }[];
    // …while every one of the other sixteen was refused, with a reason that names the limit —
    // not a generic network failure the tool could mistake for flakiness.
    expect(replies).toHaveLength(16);
    expect(replies.every((r) => r.ok === false && r.error?.includes("4 concurrent"))).toBe(true);

    server.release();
    await Promise.all(fetches);
    expect(replies).toHaveLength(20);
    expect(replies.filter((r) => r.ok)).toHaveLength(4);
    expect(server.hits()).toBe(4); // the refused sixteen never opened a connection
  });

  it("emits a durable fact for a refusal, like every other K7 denial", async () => {
    server = await holdingServer();
    const effect = new IsolatedToolEffect({
      id: "flooder",
      modulePath: "/nonexistent.js",
      egress: [server.target],
      maxConcurrentFetches: 1,
    });
    const { child } = fakeChild();
    const emit = vi.fn();
    const ctx = { executionId: "e", stepId: "s", workflowId: "w", attempt: 1, emit };

    const url = server.url;
    const fetches = Array.from({ length: 5 }, (_, i) =>
      // biome-ignore lint/suspicious/noExplicitAny: reaching the private broker path under test
      (effect as any).handleFetch(child, i, url, undefined, ctx)
    );
    await server.arrived(1);
    server.release();
    await Promise.all(fetches);

    // EGRESS_DENIED is the existing fact for "the boundary said no"; a volume
    // refusal is the same kind of event and must be as auditable.
    expect(emit).toHaveBeenCalledWith(
      "EGRESS_DENIED",
      expect.objectContaining({ toolId: "flooder" })
    );
  });
});

// ── L24 — a brokered fetch is bounded in TIME as well as in count ────────────
//
// A host that accepts the connection and never answers used to hold a `maxConcurrentFetches`
// slot forever; enough of them and every fetch the tool made was refused.
describe("a brokered fetch has a deadline (L24)", () => {
  const mkCtx = () => ({
    executionId: "e",
    stepId: "s",
    workflowId: "w",
    attempt: 1,
    emit: vi.fn(),
  });

  it("times out a hung host, replies with a typed failure and releases the slot", async () => {
    server = await holdingServer(); // never released: the host hangs
    const effect = new IsolatedToolEffect({
      id: "hung",
      modulePath: "/nonexistent.js",
      egress: [server.target],
      maxConcurrentFetches: 1,
      fetchTimeoutMs: 100,
    });
    const { sent, child } = fakeChild();
    const handle = (i: number) =>
      // biome-ignore lint/suspicious/noExplicitAny: reaching the private broker path under test
      (effect as any).handleFetch(child, i, server?.url, undefined, mkCtx());

    await handle(0);
    const first = sent[0] as { ok: boolean; code?: string; error?: string };
    expect(first.ok).toBe(false);
    expect(first.code).toBe("FETCH_TIMEOUT");
    expect(first.error).toMatch(/fetchTimeoutMs=100/);
    // biome-ignore lint/suspicious/noExplicitAny: slot counter under test
    expect((effect as any).inFlightFetches).toBe(0);

    // The slot is free: a second fetch is ADMITTED (reaches the host) rather than refused.
    await handle(1);
    expect(server.hits()).toBe(2);
    expect((sent[1] as { code?: string }).code).toBe("FETCH_TIMEOUT");
  });

  it("aborts the underlying request when the run ends", async () => {
    server = await holdingServer();
    const effect = new IsolatedToolEffect({
      id: "killed",
      modulePath: "/nonexistent.js",
      egress: [server.target],
      fetchTimeoutMs: 60_000,
    });
    const { sent, child } = fakeChild();
    const run = new AbortController();
    // biome-ignore lint/suspicious/noExplicitAny: reaching the private broker path under test
    const p = (effect as any).handleFetch(child, 0, server.url, undefined, mkCtx(), run.signal);
    await server.arrived(1);
    run.abort(new Error("run ended"));
    await p;
    expect((sent[0] as { ok: boolean }).ok).toBe(false);
    // biome-ignore lint/suspicious/noExplicitAny: slot counter under test
    expect((effect as any).inFlightFetches).toBe(0);
    await server.closed(1); // the host saw the connection torn down
  });

  it("end to end: a tool awaiting a hung host gets the typed failure and the run completes", async () => {
    server = await holdingServer();
    const effect = new IsolatedToolEffect({
      id: "e2e",
      modulePath: path.join(__dirname, "__fixtures__", "fetcher.cjs"),
      egress: [server.target],
      fetchTimeoutMs: 200,
    });
    try {
      await expect(effect.execute({ url: server.url }, mkCtx())).rejects.toThrow(
        /fetchTimeoutMs=200/
      );
    } finally {
      effect.close();
    }
  });

  it("fetchTimeoutMs must be a finite number > 0", () => {
    for (const bad of [0, -5, Number.NaN]) {
      expect(
        () => new IsolatedToolEffect({ id: "x", modulePath: "/x", fetchTimeoutMs: bad })
      ).toThrow(/fetchTimeoutMs must be a finite number > 0/);
    }
  });
});
