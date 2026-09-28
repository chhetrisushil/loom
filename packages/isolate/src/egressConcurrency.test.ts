import * as http from "node:http";
import type { AddressInfo } from "node:net";
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
  release(): void;
  close(): Promise<void>;
}

async function holdingServer(): Promise<HoldingServer> {
  const held: http.ServerResponse[] = [];
  const waiters: { n: number; resolve: () => void }[] = [];
  let released = false;
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
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
