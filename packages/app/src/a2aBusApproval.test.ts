import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import {
  WorkflowRuntime,
  signResume,
  signedResumeAuthenticator,
  viewDigest,
} from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type ApprovalProof,
  InProcessA2ABus,
  approvalPayload,
  unsafeAutoApprove,
} from "./InProcessA2ABus";

// R13 — the bus must not approve on a human's behalf. It used to resume every parked gate with
// `{ approved: true, approvedBy: "auto" }` when no `onApproval` was supplied.

const io = z.any();

const KEY = "alice-secret-0123456789";

function make(gate = "Approval", auth = false, denyAfterPark = false) {
  const inner = new InMemoryAsyncEventStore();
  // Models an audit event (EXECUTION_DENIED) landing right after the park, before the result is read.
  const eventStore = denyAfterPark
    ? Object.assign(Object.create(inner) as InMemoryAsyncEventStore, {
        async append(e: Parameters<InMemoryAsyncEventStore["append"]>[0]) {
          await inner.append(e);
          if (e.eventType === "EXECUTION_SUSPENDED") {
            await inner.append({
              ...e,
              id: `${e.executionId}-${e.sequence + 1}-denied`,
              eventType: "EXECUTION_DENIED",
              sequence: e.sequence + 1,
              payload: { op: "resume" },
            });
          }
        },
      })
    : inner;
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    ...(auth && {
      resumeAuthenticator: signedResumeAuthenticator({ gates: ["Approval"], keys: { alice: KEY } }),
    }),
  });
  let ran = 0;
  const flow = {
    definition: {
      _tag: "FlowDefinition" as const,
      id: "f",
      name: "f",
      version: "1.0.0",
      inputSchema: io,
      outputSchema: io,
      steps: [],
    },
    runner: async (ctx: { suspend: (c: unknown) => Promise<unknown> }) => {
      const r = (await ctx.suspend({
        on: gate,
        ...(gate === "Approval" && { viewDigest: viewDigest({ drop: "users" }) }),
      })) as { approved?: boolean };
      if (r?.approved === true) ran++;
      return { approved: r?.approved === true };
    },
  };
  runtime.registerFlow(flow.definition as never, flow.runner as never);
  const bus = new InProcessA2ABus(runtime);
  bus.registerAgent({ name: "a", description: "a", capabilities: [] } as never);
  bus.registerCapability("cap", "a", flow as never);
  return { runtime, bus, eventStore, ran: () => ran };
}

describe("InProcessA2ABus approvals (R13)", () => {
  it("no onApproval: the gate STAYS suspended — nothing approves it", async () => {
    const { bus, runtime, eventStore, ran } = make();
    const r = await bus.dispatch("cap", {}, "go", { executionId: "x1" });
    expect(r.status).toBe("working");
    expect(r.suspended).toMatchObject({
      gate: "Approval",
      viewDigest: viewDigest({ drop: "users" }),
    });
    const state = await runtime.loadState("x1");
    expect(state?.status).toBe("suspended");
    expect(ran()).toBe(0);
    expect((await eventStore.read("x1")).map((e) => e.eventType)).not.toContain("APPROVAL_GRANTED");
    expect(JSON.stringify(await eventStore.read("x1"))).not.toContain('"auto"');
  });

  it("the legacy gate name the old auto-approve answered (ApprovalGranted) is no longer auto-approved", async () => {
    const { bus, runtime, ran } = make("ApprovalGranted");
    const r = await bus.dispatch("cap", {}, "go", { executionId: "x0" });
    expect(r.status).toBe("working");
    expect((await runtime.loadState("x0"))?.status).toBe("suspended");
    expect(ran()).toBe(0);
  });

  it("an explicit onApproval decides, and its decision is bound to the digest it was shown", async () => {
    const { bus, runtime, ran } = make();
    let seen: unknown;
    const r = await bus.dispatch("cap", {}, "go", {
      executionId: "x2",
      onApproval: async (req) => {
        seen = req;
        return { approved: true, approvedBy: "ops" };
      },
    });
    expect(r.status).toBe("completed");
    expect(seen).toMatchObject({ executionId: "x2", gate: "Approval" });
    expect(ran()).toBe(1);
    expect((await runtime.loadState("x2"))?.status).toBe("completed");
  });

  it("a parked task is resolved later with resolveApproval, still digest-bound", async () => {
    const { bus, ran } = make();
    const parked = await bus.dispatch("cap", {}, "go", { executionId: "x3" });
    expect(parked.status).toBe("working");
    const r = await bus.resolveApproval("x3", { approved: true, approvedBy: "ops" });
    expect(r.status).toBe("completed");
    expect(ran()).toBe(1);
  });

  it("unsafeAutoApprove is the loud opt-in for demos", async () => {
    const { bus, ran } = make();
    const r = await bus.dispatch("cap", {}, "go", {
      executionId: "x4",
      onApproval: unsafeAutoApprove,
    });
    expect(r.status).toBe("completed");
    expect(ran()).toBe(1);
  });

  it("unsafeAutoApprove warns loudly, once per process", async () => {
    vi.resetModules();
    const fresh = await import("./InProcessA2ABus");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await fresh.unsafeAutoApprove();
      await fresh.unsafeAutoApprove();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("unsafeAutoApprove");
    } finally {
      warn.mockRestore();
    }
  });

  it("resolveApproval on an unknown/evicted task names the way out (runtime.resume + answerApproval)", async () => {
    const { bus } = make();
    const err = await bus.resolveApproval("nope", { approved: true, approvedBy: "ops" }).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err?.message).toContain("runtime.resume");
    expect(err?.message).toContain("answerApproval");
  });

  // A strict app wires a signedResumeAuthenticator, so a bare bus approval is refused. The bus
  // echoes the viewDigest BEFORE the payload is signed (approvalPayload), and the request carries
  // the park to bind to, so an approver can sign exactly what the bus will send.
  it("a strict app approves through the bus with a signed proof (onApproval)", async () => {
    const { bus, runtime, ran } = make("Approval", true);
    const bare = await bus
      .dispatch("cap", {}, "go", {
        executionId: "s0",
        onApproval: async () => ({ approved: true, approvedBy: "alice" }),
      })
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(bare?.message).toContain("approval not verified");
    expect(ran()).toBe(0);

    const r = await bus.dispatch("cap", {}, "go", {
      executionId: "s1",
      onApproval: async (req) => {
        const decision = { approved: true, approvedBy: "alice" };
        const signed = signResume(
          { eventType: req.gate, payload: approvalPayload(req, decision) },
          {
            actor: "alice",
            secret: KEY,
            exp: Date.now() + 60_000,
            executionId: req.executionId,
            parkedAtSequence: req.parkedAtSequence!,
          }
        );
        return { ...decision, proof: (signed.payload as { proof: ApprovalProof }).proof };
      },
    });
    expect(r.status).toBe("completed");
    expect(ran()).toBe(1);
    const log = await runtime.loadState("s1");
    expect(log?.status).toBe("completed");
  });

  it("resolveApproval carries a pre-signed proof the same way", async () => {
    const { bus, ran } = make("Approval", true);
    const parked = await bus.dispatch("cap", {}, "go", { executionId: "s2" });
    const req = parked.suspended!;
    const decision = { approved: true, approvedBy: "alice" };
    const signed = signResume(
      { eventType: req.gate, payload: approvalPayload(req, decision) },
      {
        actor: "alice",
        secret: KEY,
        exp: Date.now() + 60_000,
        executionId: req.executionId,
        parkedAtSequence: req.parkedAtSequence!,
      }
    );
    const r = await bus.resolveApproval("s2", {
      ...decision,
      proof: (signed.payload as { proof: ApprovalProof }).proof,
    });
    expect(r.status).toBe("completed");
    expect(ran()).toBe(1);
  });

  // Round 2: the request bound to the result's TIP; an audit event trailing the park moved the tip
  // off the park and every signed bus approval was refused.
  it("the approval request names the PARK, not the tip, when an audit event trails it", async () => {
    const { bus, runtime, ran } = make("Approval", true, true);
    const parked = await bus.dispatch("cap", {}, "go", { executionId: "s3" });
    const req = parked.suspended!;
    expect((await runtime.loadState("s3"))!.sequence).toBeGreaterThan(req.parkedAtSequence!);
    expect(req.parkedAtSequence).toBe(await runtime.parkedAtSequence("s3"));
    const decision = { approved: true, approvedBy: "alice" };
    const signed = signResume(
      { eventType: req.gate, payload: approvalPayload(req, decision) },
      {
        actor: "alice",
        secret: KEY,
        exp: Date.now() + 60_000,
        executionId: req.executionId,
        parkedAtSequence: req.parkedAtSequence!,
      }
    );
    const r = await bus.resolveApproval("s3", {
      ...decision,
      proof: (signed.payload as { proof: ApprovalProof }).proof,
    });
    expect(r.status).toBe("completed");
    expect(ran()).toBe(1);
  });
});
