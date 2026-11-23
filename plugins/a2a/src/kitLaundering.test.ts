import { InMemoryGrantBroker } from "@loomwork/task-authority";
import {
  type A2ATransport,
  type ConformanceSubject,
  checkTaskAuthorityConformance,
} from "@loomwork/task-authority/conformance";
import { describe, expect, it } from "vitest";
import { LoomAgentExecutor } from "./AgentExecutor";

// ADR 0150 D14 / S11: the conformance kit's `laundering.uncovered.a2a` over the REAL executor, in process (no sockets).
// A task-authority -> plugin-a2a dependency would be a cycle (this package dev-depends on task-authority), so the kit takes
// the transport from the subject and the reference one lives here.
const transport: A2ATransport = {
  serve: (runtime, flow) => {
    const exec = new LoomAgentExecutor(runtime, flow, { taintInbound: true });
    return async (prompt, principal) => {
      const call = { principal };
      const { id } = await exec.submit(
        { id: "kit-1", message: { role: "user", parts: [{ type: "text", text: prompt }] } },
        call
      );
      const deadline = Date.now() + 10_000;
      for (;;) {
        const r = await exec.get(id, call);
        if (r?.status === "completed" || r?.status === "failed") return;
        if (Date.now() > deadline) throw new Error("A2A task did not finish");
        await new Promise((res) => setTimeout(res, 5));
      }
    };
  },
};
const subject: ConformanceSubject = {
  makeBroker: (o) => new InMemoryGrantBroker(o),
  a2a: transport,
};

describe("kit laundering.uncovered.a2a over LoomAgentExecutor", () => {
  it("passes the reference broker; no check is skipped", async () => {
    const r = await checkTaskAuthorityConformance(subject);
    expect(r.results.filter((x) => x.status === "failed")).toEqual([]);
    expect(r.results.find((x) => x.id === "laundering.uncovered.a2a")?.status).toBe("passed");
    expect(r.results.filter((x) => x.status === "skipped")).toEqual([]);
  }, 60_000);

  // kills: a transport that does not deliver (the pass would be vacuous)
  it("fails when the transport never runs the callee", async () => {
    const r = await checkTaskAuthorityConformance({
      ...subject,
      a2a: { serve: () => async () => {} },
    });
    const a = r.results.find((x) => x.id === "laundering.uncovered.a2a");
    expect(a?.status).toBe("failed");
    expect(a?.message).toMatch(/not delivering/);
  }, 60_000);
});
