import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { INSPECTOR_PAGE_FOR_TEST, serveInspector } from "./inspector";

// The inspector serves `/api/trace/:id` — an execution's ENTIRE durable log, every step
// input and output — with no authentication. `server.listen(port)` with no host binds all
// interfaces, so running `loom inspect` published that to anyone who could reach the port,
// while the banner printed "http://localhost:…".

/** A non-loopback IPv4 address of this host, if it has one. */
function externalAddress(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return undefined;
}

/** Whether a TCP connect to host:port succeeds within the timeout. */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 1500 });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

describe("inspector — network exposure", () => {
  it("binds loopback only, and says so", async () => {
    const server = serveInspector(new InMemoryAsyncEventStore());
    await server.start();
    try {
      expect(server.url).toContain("localhost");
      // Reachable on loopback.
      expect(await reachable("127.0.0.1", server.port)).toBe(true);
      // NOT reachable on this host's own LAN address — the property that matters, and the
      // one that was false before: anyone on the network could read every event log.
      const external = externalAddress();
      if (external !== undefined) {
        expect(await reachable(external, server.port)).toBe(false);
      }
    } finally {
      await server.stop();
    }
  });

  it("exposes all interfaces only when asked, and reports it honestly", async () => {
    const server = serveInspector(new InMemoryAsyncEventStore(), { host: "0.0.0.0" });
    await server.start();
    try {
      // The banner must not claim loopback while listening on everything.
      expect(server.url).toContain("0.0.0.0");
      const external = externalAddress();
      if (external !== undefined) {
        expect(await reachable(external, server.port)).toBe(true);
      }
    } finally {
      await server.stop();
    }
  });
});

// `eventType` is free-form log data: `ctx.emit(type, …)` is flow-authored, and the A2A
// `provideInput` path takes a ResumeEvent whose eventType comes from the caller. Building
// markup from it let stored content execute in the inspector page — which can read
// /api/trace/* for EVERY execution and exfiltrate it.
describe("inspector — timeline rendering", () => {
  it("does not build the timeline with innerHTML", () => {
    expect(INSPECTOR_PAGE_FOR_TEST).not.toMatch(/timeline'\)\.innerHTML\s*=/);
    expect(INSPECTOR_PAGE_FOR_TEST).toContain("sp.textContent=");
  });

  it("routes event-derived text through textContent only", () => {
    // Every place eventType appears must be a textContent assignment, never string-concatenated
    // markup.
    for (const line of INSPECTOR_PAGE_FOR_TEST.split("\n").filter((l) => l.includes("eventType"))) {
      expect(line).toMatch(/textContent/);
      expect(line).not.toMatch(/<span/);
    }
  });
});
