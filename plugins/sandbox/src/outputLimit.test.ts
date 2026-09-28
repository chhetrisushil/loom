import { TypedFailure } from "@loom/core";
import { InMemoryContentStore } from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { SandboxEvalEffect } from "./SandboxEvalEffect";

const ctx = {
  executionId: "e",
  stepId: "s",
  workflowId: "w",
  attempt: 1,
  emit: () => {},
};
// Store the script for real: the effect now verifies the bytes against the address it was
// pinned to, so a placeholder ref is (correctly) rejected before the script ever runs.
const scripts = new InMemoryContentStore();
const put = (script: string) => scripts.put(new TextEncoder().encode(script));
const run = async (script: string, limits = {}) => {
  const ref = await put(script);
  return new SandboxEvalEffect(scripts, limits).execute(
    { scriptRef: ref, input: {} },
    ctx as never
  );
};

describe("SandboxEvalEffect — output size limit", () => {
  it("refuses a maxOutputBytes option that would silently disable the bound (backlog L19)", () => {
    // `maxInputBytes` (inputLimit.test.ts) refuses `NaN`/negative/non-numeric at
    // construction, mirroring `SandboxWorkerPoolOptions`' own duration validation —
    // `maxOutputBytes` gets the SAME validation now, closing a pre-existing gap where it
    // silently accepted a value that could never fire (`NaN`) or a nonsensical one
    // (negative).
    for (const bad of [Number.NaN, -1, "5" as unknown as number]) {
      expect(
        () => new SandboxEvalEffect(scripts, { maxOutputBytes: bad }),
        `maxOutputBytes=${String(bad)}`
      ).toThrow(/maxOutputBytes must be a finite number >= 0/);
    }
    // 0 IS accepted — "refuse every output", a caller's deliberate choice (a script
    // returning `undefined` still costs 0 bytes, so it is not "refuse every call").
    expect(() => new SandboxEvalEffect(scripts, { maxOutputBytes: 0 })).not.toThrow();
  });

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
    const ref = await put(script);
    await expect(
      new SandboxEvalEffect(scripts, {}).execute(
        { scriptRef: ref, input: {}, expectedOutputShapeHash: "nope" },
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
