import { TypedFailure } from "@loom/core";
import { describe, expect, it } from "vitest";
import { SandboxEvalEffect } from "./SandboxEvalEffect";

const ctx = {
  executionId: "e",
  stepId: "s",
  workflowId: "w",
  attempt: 1,
  emit: () => {},
};
const reader = (script: string) => ({
  get: async () => new TextEncoder().encode(script),
});
const run = (script: string, limits = {}) =>
  new SandboxEvalEffect(reader(script), limits).execute(
    { scriptRef: { __loomContent: "ref" }, input: {} },
    ctx as never
  );

describe("SandboxEvalEffect — output size limit", () => {
  it("kills a script that returns more than the ceiling", async () => {
    // A script's return value becomes a durable STEP_COMPLETED payload, so an unbounded one
    // lets an adversarial script bloat an append-only log — the same threat the 2 KB cap on
    // error text already covers. This returned 5 MB before the limit existed.
    const script = '(() => { const s = "x".repeat(1024*1024); return { blob: [s,s,s,s,s] }; })()';
    await expect(run(script)).rejects.toBeInstanceOf(TypedFailure);
    await expect(run(script)).rejects.toMatchObject({
      channel: "limitExceeded",
      payload: { kind: "output" },
    });
  }, 30_000);

  it("reports the resource kill rather than a shape mismatch", async () => {
    const script = '(() => { const s = "x".repeat(1024*1024); return { blob: [s,s,s] }; })()';
    // Ordering matters: an oversized output is a limit kill, not a contract violation, so a
    // planner sees the channel that tells it to shrink the request.
    await expect(
      new SandboxEvalEffect(reader(script), {}).execute(
        { scriptRef: { __loomContent: "ref" }, input: {}, expectedOutputShapeHash: "nope" },
        ctx as never
      )
    ).rejects.toMatchObject({ channel: "limitExceeded", payload: { kind: "output" } });
  }, 30_000);

  it("lets ordinary outputs through untouched", async () => {
    await expect(run("(() => ({ ok: true, n: 42 }))()")).resolves.toEqual({ ok: true, n: 42 });
    // The bound is configurable for callers that genuinely return large documents.
    const big = '(() => ({ s: "y".repeat(200_000) }))()';
    await expect(run(big, { maxOutputBytes: 1024 })).rejects.toMatchObject({
      channel: "limitExceeded",
      payload: { kind: "output" },
    });
    await expect(run(big, { maxOutputBytes: 4 * 1024 * 1024 })).resolves.toMatchObject({
      s: expect.any(String),
    });
  }, 30_000);
});
