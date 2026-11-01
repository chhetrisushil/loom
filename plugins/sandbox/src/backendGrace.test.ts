import { describe, expect, it } from "vitest";
import { interpretQuickJsOutcome } from "./QuickJsSandboxBackend";
import { SandboxEvalEffect } from "./SandboxEvalEffect";

// ── ADR 0144 D2 — the effect's "backend never settled" deadline must not undercut the worker pool ──

const grace = (e: SandboxEvalEffect) => (e as unknown as { backendGraceMs: number }).backendGraceMs;

describe("SandboxEvalEffect backendGraceMs", () => {
  const scripts = { get: async () => null };

  it("keeps the 60 s default for the in-process engine and the default pool", () => {
    expect(grace(new SandboxEvalEffect(scripts))).toBe(60_000);
    expect(grace(new SandboxEvalEffect(scripts, {}, { count: 1 }))).toBe(60_000);
  });

  it("covers a pool configured with long cold-start, liveness and kill allowances", async () => {
    const e = new SandboxEvalEffect(
      scripts,
      {},
      { count: 1, coldStartMs: 90_000, startupLivenessMs: 30_000, hardKillGraceMs: 20_000 }
    );
    expect(grace(e)).toBeGreaterThanOrEqual(90_000 + 30_000 + 20_000);
    await e.close();
  });
});

describe("QuickJS seed failures keep their historical text", () => {
  it("a non-OOM seed failure still reads `sandbox: input marshalling failed:`", () => {
    const out = interpretQuickJsOutcome({
      ok: false,
      message: "unexpected token",
      duringSeed: true,
    });
    expect(out).toMatchObject({ ok: false, kind: "infrastructure" });
    expect((out as { message: string }).message).toContain("sandbox: input marshalling failed:");
  });
});
