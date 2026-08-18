import { describe, expect, it, vi } from "vitest";
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

describe("brokered egress is bounded (K7.3)", () => {
  it("refuses a flood of concurrent fetches instead of issuing them", async () => {
    const effect = new IsolatedToolEffect({
      id: "flooder",
      modulePath: "/nonexistent.js",
      egress: ["example.com:443"],
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

    // Twenty at once from a tool that never awaits.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        // biome-ignore lint/suspicious/noExplicitAny: reaching the private broker path under test
        (effect as any).handleFetch(child, i, "https://example.com/x", undefined, ctx)
      )
    );

    const replies = sent as { ok: boolean; error?: string }[];
    expect(replies).toHaveLength(20);
    const refused = replies.filter((r) => r.ok === false && r.error?.includes("concurrent"));
    // The excess is refused — and refused with a reason that names the limit,
    // not a generic network failure the tool could mistake for flakiness.
    expect(refused.length).toBeGreaterThan(0);
  });

  it("emits a durable fact for a refusal, like every other K7 denial", async () => {
    const effect = new IsolatedToolEffect({
      id: "flooder",
      modulePath: "/nonexistent.js",
      egress: ["example.com:443"],
      maxConcurrentFetches: 1,
    });
    const { child } = fakeChild();
    const emit = vi.fn();
    const ctx = { executionId: "e", stepId: "s", workflowId: "w", attempt: 1, emit };

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        // biome-ignore lint/suspicious/noExplicitAny: reaching the private broker path under test
        (effect as any).handleFetch(child, i, "https://example.com/x", undefined, ctx)
      )
    );

    // EGRESS_DENIED is the existing fact for "the boundary said no"; a volume
    // refusal is the same kind of event and must be as auditable.
    expect(emit).toHaveBeenCalledWith(
      "EGRESS_DENIED",
      expect.objectContaining({ toolId: "flooder" })
    );
  });
});
