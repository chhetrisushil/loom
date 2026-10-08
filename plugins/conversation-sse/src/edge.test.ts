import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Booted,
  Latch,
  type SseConn,
  boot,
  get,
  openSse,
  post,
  until,
} from "./__fixtures__/harness";

// Fix round 1: the edge hardening items (P2-1, P3-4, P3-5, P3-6).

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
async function up(opts: Parameters<typeof boot>[0] = {}): Promise<Booted> {
  const b = await boot(opts);
  cleanup.push(() => b.server.stop());
  return b;
}
const track = (c: SseConn): SseConn => {
  cleanup.push(() => c.close());
  return c;
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
async function startConv(b: Booted, token = "tok-alice"): Promise<string> {
  return (await post(`${b.url}/conversations`, token, {})).body.conversationId as string;
}

/** A raw request, so the `Host` header can be chosen. */
function raw(url: string, headers: Record<string, string>): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("P2-1 a connection dropped while it is being authorized does not keep its slot", () => {
  it("the slot is released at once and the next stream is admitted", async () => {
    const gate = new Latch();
    const entered = new Latch();
    const b = await up({ server: { maxConnectionsPerPrincipal: 1 } });
    const id = await startConv(b);
    // slow the authorization step down
    const real = b.conversations.status.bind(b.conversations);
    (b.conversations as { status: typeof real }).status = async (...a) => {
      entered.release();
      await gate.promise;
      return real(...a);
    };
    const client = http.request(`${b.url}/conversations/${id}/events`, {
      headers: bearer("tok-alice"),
      agent: false,
    });
    client.on("error", () => undefined);
    client.end();
    await entered.promise; // the request is on the server, parked in `status`
    client.destroy(); // the client hangs up
    // wait until the SERVER has seen the socket go, then let the authorization finish
    await until(
      () => new Promise<boolean>((r) => b.server.http.getConnections((_e, n) => r(n === 0))),
      "the server to see the hang-up"
    );
    gate.release();
    await until(() => b.server.connections === 0, "no connection is counted");
    (b.conversations as { status: typeof real }).status = real;
    const next = track(await openSse(`${b.url}/conversations/${id}/events`, bearer("tok-alice")));
    expect(next.status).toBe(200); // not 429: the dropped one did not hold the per-principal slot
    expect(b.server.connections).toBe(1);
  });
});

describe("history reads stop when the client goes away", () => {
  it("the signal handed to the read aborts on disconnect", async () => {
    const b = await up();
    const id = await startConv(b);
    let seen: AbortSignal | undefined;
    const started = new Latch();
    const real = b.conversations.history.bind(b.conversations);
    (b.conversations as { history: typeof real }).history = async (cid, o) => {
      seen = o?.signal;
      started.release();
      await new Promise((r) => setTimeout(r, 60));
      return real(cid, o);
    };
    const ctl = new AbortController();
    const p = fetch(`${b.url}/conversations/${id}/history`, {
      headers: bearer("tok-alice"),
      signal: ctl.signal,
    }).catch(() => undefined);
    await started.promise;
    expect(seen?.aborted).toBe(false);
    ctl.abort();
    await p;
    await until(() => seen?.aborted === true, "the read to be told");
  });
});

describe("P3-4 DNS rebinding", () => {
  it("an unauthenticated (insecure) server answers only loopback Host names", async () => {
    const b = await up({
      openRuntime: true,
      server: { insecure: true, authenticate: undefined as never },
    });
    const good = await raw(`${b.url}/conversations/nope`, { host: "localhost" });
    expect(good.status).toBe(404); // reached the router
    for (const host of ["evil.example", "attacker.com:80", "127.0.0.1.evil.example"]) {
      expect((await raw(`${b.url}/conversations/nope`, { host })).status).toBe(421);
    }
    expect((await raw(`${b.url}/conversations/nope`, { host: "127.0.0.1:1234" })).status).toBe(404);
  });

  it("an allowlist can be set on an authenticated server too", async () => {
    const b = await up({ server: { allowedHosts: ["chat.example"] } });
    expect(
      (await raw(`${b.url}/conversations/nope`, { host: "evil.example", ...bearer("tok-alice") }))
        .status
    ).toBe(421);
    expect(
      (await raw(`${b.url}/conversations/nope`, { host: "chat.example", ...bearer("tok-alice") }))
        .status
    ).toBe(404);
  });
});

describe("P3-5 CORS", () => {
  it("rides error responses, and carries credentials only when allowed for listed origins", async () => {
    const b = await up({
      server: { allowedOrigins: ["https://app.example"], allowCredentials: true },
    });
    const err = await fetch(`${b.url}/conversations/conv-nope`, {
      headers: { ...bearer("tok-alice"), origin: "https://app.example" },
    });
    expect(err.status).toBe(404);
    expect(err.headers.get("access-control-allow-origin")).toBe("https://app.example"); // a browser can READ the 404
    expect(err.headers.get("access-control-allow-credentials")).toBe("true");
    const unauth = await fetch(`${b.url}/conversations/conv-nope`, {
      headers: { origin: "https://app.example" },
    });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("access-control-allow-origin")).toBe("https://app.example");
    // NEGATIVE: an unlisted origin gets neither, and credentials are off by default
    const plain = await up({ server: { allowedOrigins: ["https://app.example"] } });
    const r = await fetch(`${plain.url}/conversations/conv-nope`, {
      headers: { ...bearer("tok-alice"), origin: "https://app.example" },
    });
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
    const bad = await fetch(`${b.url}/conversations/conv-nope`, {
      headers: { ...bearer("tok-alice"), origin: "https://evil.example" },
    });
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("P3-6 request budgets", () => {
  it("rate-limits POSTs per principal (a window), not GETs, not other principals", async () => {
    let t = 1_000_000;
    const b = await up({ server: { rateLimit: { max: 3, windowMs: 60_000 }, now: () => t } });
    const id = await startConv(b); // 1
    expect(
      (await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "a" })).status
    ).toBe(202); // 2
    expect(
      (await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "b" })).status
    ).toBe(202); // 3
    const limited = await fetch(`${b.url}/conversations/${id}/turns`, {
      method: "POST",
      headers: { ...bearer("tok-alice"), "content-type": "application/json" },
      body: JSON.stringify({ text: "c" }),
    });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await get(`${b.url}/conversations/${id}`, "tok-alice")).status).toBe(200); // reads are not limited
    expect((await post(`${b.url}/conversations`, "tok-bob", {})).status).toBe(201); // another principal has its own budget
    t += 60_001; // the window rolls over
    expect(
      (await post(`${b.url}/conversations/${id}/turns`, "tok-alice", { text: "d" })).status
    ).toBe(202);
  });

  it("sets the server's request/header timeouts and socket cap", async () => {
    const b = await up({
      server: { requestTimeoutMs: 1234, headersTimeoutMs: 567, maxSockets: 99 },
    });
    expect(b.server.http.requestTimeout).toBe(1234);
    expect(b.server.http.headersTimeout).toBe(567);
    expect(b.server.http.maxConnections).toBe(99);
    const d = await up();
    expect(d.server.http.requestTimeout).toBeGreaterThan(0);
    expect(d.server.http.maxConnections).toBeGreaterThan(0);
  });
});
