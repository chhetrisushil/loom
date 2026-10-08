import { describe, expect, it } from "vitest";
import { type PromotionVerdict, promotionGate } from "./promote";
import {
  InMemoryPolicyKv,
  PolicyAccessDeniedError,
  PolicyConflictError,
  PolicyNotFoundError,
  PolicyRegistry,
  PolicyVersionConflictError,
  PromotionRefusedError,
} from "./registry";
import type { EvalReport } from "./types";
import { contentHash } from "./versions";

const H = (s: string) => contentHash({ v: s });

function report(id: string, version: string): EvalReport {
  return {
    policy: { id, version },
    evaluated: 5000,
    skipped: { noContext: 0, noActions: 0, noReward: 0 },
    agreement: 0.5,
    loggedValue: 0.5,
    estimatedValue: 0.7,
    estimator: "snips",
    lift: 0.2,
    effectiveSampleSize: 2000,
    warnings: [],
  };
}
const OK: PromotionVerdict = { ok: true, reasons: [] };

async function seeded(kv = new InMemoryPolicyKv(), scope = "tenant-a") {
  const reg = new PolicyRegistry({ kv, scope });
  for (const v of ["1", "2", "3"]) {
    await reg.register({ id: "router", version: v, contentHash: H(v), now: 10 });
  }
  await reg.bootstrap({ id: "router", version: "1", now: 11 });
  return { reg, kv };
}

describe("PolicyRegistry (R18)", () => {
  it("registers immutable versions: same content is idempotent, different content is refused", async () => {
    const { reg } = await seeded();
    await reg.register({ id: "router", version: "2", contentHash: H("2"), now: 99 });
    expect((await reg.version("router", "2"))?.registeredAt).toBe(10);
    await expect(
      reg.register({ id: "router", version: "2", contentHash: H("other"), now: 12 })
    ).rejects.toThrow(PolicyVersionConflictError);
    await expect(
      reg.register({ id: "router", version: "9", contentHash: "sha256:nothex", now: 1 })
    ).rejects.toThrow(/contentHash/);
  });

  it("bootstrap installs the first incumbent exactly once", async () => {
    const { reg } = await seeded();
    expect((await reg.resolve("router"))?.incumbent).toBe("1");
    await expect(reg.bootstrap({ id: "router", version: "2", now: 1 })).rejects.toThrow(
      /already has an incumbent/
    );
  });

  it("promote needs a PASSING verdict for exactly that version", async () => {
    const { reg } = await seeded();
    const bad = promotionGate(report("router", "2"), { minLift: 0.5 });
    expect(bad.ok).toBe(false);
    await expect(
      reg.promote({
        id: "router",
        version: "2",
        report: report("router", "2"),
        verdict: bad,
        mode: "full",
        now: 20,
      })
    ).rejects.toThrow(PromotionRefusedError);
    // a good verdict for ANOTHER version does not transfer
    await expect(
      reg.promote({
        id: "router",
        version: "2",
        report: report("router", "3"),
        verdict: OK,
        mode: "full",
        now: 20,
      })
    ).rejects.toThrow(/evaluation is of router@3/);
    // and an unregistered version cannot be promoted
    await expect(
      reg.promote({
        id: "router",
        version: "7",
        report: report("router", "7"),
        verdict: OK,
        mode: "full",
        now: 20,
      })
    ).rejects.toThrow(PolicyNotFoundError);
    // none of the refusals moved anything
    expect((await reg.resolve("router"))?.incumbent).toBe("1");
    expect((await reg.history("router")).some((h) => h.action === "promote")).toBe(false);
  });

  it("canary and shadow keep the incumbent and record the candidate; full replaces it", async () => {
    const { reg } = await seeded();
    const canary = await reg.promote({
      id: "router",
      version: "2",
      report: report("router", "2"),
      verdict: OK,
      mode: "canary",
      canaryFraction: 0.1,
      now: 20,
    });
    expect(canary).toMatchObject({
      mode: "canary",
      incumbent: "1",
      candidate: "2",
      canaryFraction: 0.1,
    });
    expect((await reg.version("router", "2"))?.evidence?.canary).toBe(0.1);
    const shadow = await reg.promote({
      id: "router",
      version: "3",
      report: report("router", "3"),
      verdict: OK,
      mode: "shadow",
      now: 21,
    });
    expect(shadow).toMatchObject({ mode: "shadow", incumbent: "1", candidate: "3" });
    const full = await reg.promote({
      id: "router",
      version: "3",
      report: report("router", "3"),
      verdict: OK,
      mode: "full",
      now: 22,
    });
    expect(full).toMatchObject({ mode: "full", incumbent: "3" });
    expect(full.candidate).toBeUndefined();
  });

  it("canary needs a fraction in (0,1) and an incumbent to canary against", async () => {
    const { reg } = await seeded();
    for (const f of [undefined, 0, 1, -0.2, 1.5, Number.NaN]) {
      await expect(
        reg.promote({
          id: "router",
          version: "2",
          report: report("router", "2"),
          verdict: OK,
          mode: "canary",
          ...(f !== undefined && { canaryFraction: f }),
          now: 1,
        })
      ).rejects.toThrow(/canaryFraction/);
    }
    const bare = new PolicyRegistry({ kv: new InMemoryPolicyKv(), scope: "t" });
    await bare.register({ id: "p", version: "1", contentHash: H("1"), now: 1 });
    await expect(
      bare.promote({
        id: "p",
        version: "1",
        report: report("p", "1"),
        verdict: OK,
        mode: "shadow",
        now: 1,
      })
    ).rejects.toThrow(/no incumbent/);
  });

  it("rollback restores the previous incumbent in one write, and again after a canary", async () => {
    const { reg } = await seeded();
    await reg.promote({
      id: "router",
      version: "2",
      report: report("router", "2"),
      verdict: OK,
      mode: "full",
      now: 20,
    });
    await reg.promote({
      id: "router",
      version: "3",
      report: report("router", "3"),
      verdict: OK,
      mode: "full",
      now: 21,
    });
    expect((await reg.resolve("router"))?.incumbent).toBe("3");
    expect(await reg.rollback({ id: "router", now: 30, note: "p99 regression" })).toMatchObject({
      mode: "full",
      incumbent: "2",
    });
    // a canary in flight: rollback drops the candidate, keeps the incumbent
    await reg.promote({
      id: "router",
      version: "3",
      report: report("router", "3"),
      verdict: OK,
      mode: "canary",
      canaryFraction: 0.5,
      now: 31,
    });
    const r = await reg.rollback({ id: "router", now: 32 });
    expect(r).toMatchObject({ mode: "full", incumbent: "2" });
    expect(r.candidate).toBeUndefined();
    // explicit target, and a target that does not exist
    expect((await reg.rollback({ id: "router", to: "1", now: 33 })).incumbent).toBe("1");
    await expect(reg.rollback({ id: "router", to: "nope", now: 34 })).rejects.toThrow(
      PolicyNotFoundError
    );
    const last = (await reg.history("router")).at(-1);
    expect(last).toMatchObject({ action: "rollback", to: "1", from: "2" });
  });

  it("ramp moves the canary fraction and nothing else", async () => {
    const { reg } = await seeded();
    await expect(reg.ramp({ id: "router", canaryFraction: 0.5, now: 1 })).rejects.toThrow(
      /no canary/
    );
    await reg.promote({
      id: "router",
      version: "2",
      report: report("router", "2"),
      verdict: OK,
      mode: "canary",
      canaryFraction: 0.05,
      now: 20,
    });
    const before = await reg.resolve("router");
    const after = await reg.ramp({ id: "router", canaryFraction: 0.25, now: 21 });
    expect(after).toMatchObject({
      candidate: "2",
      incumbent: "1",
      canaryFraction: 0.25,
      salt: before?.salt,
    });
    await expect(reg.ramp({ id: "router", canaryFraction: 1, now: 1 })).rejects.toThrow(/\(0,1\)/);
  });

  it("is durable: a second registry over the same store sees the state, and stale writers retry", async () => {
    const { reg, kv } = await seeded();
    await reg.promote({
      id: "router",
      version: "2",
      report: report("router", "2"),
      verdict: OK,
      mode: "full",
      now: 20,
    });
    const other = new PolicyRegistry({ kv, scope: "tenant-a" });
    expect((await other.resolve("router"))?.incumbent).toBe("2");
    // two concurrent writers both land (CAS retry), neither is lost
    await Promise.all([
      reg.register({ id: "router", version: "4", contentHash: H("4"), now: 40 }),
      other.register({ id: "router", version: "5", contentHash: H("5"), now: 41 }),
    ]);
    expect((await reg.versions("router")).map((v) => v.version).sort()).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });

  it("gives up with a typed error when the store never lets a write through", async () => {
    const kv = new InMemoryPolicyKv();
    const hostile = {
      load: (k: string) => kv.load(k),
      save: async () => {
        const e = new Error("conflict");
        e.name = "RevisionConflictError";
        throw e;
      },
    };
    const reg = new PolicyRegistry({ kv: hostile, scope: "t" });
    await expect(
      reg.register({ id: "p", version: "1", contentHash: H("1"), now: 1 })
    ).rejects.toThrow(PolicyConflictError);
  });

  it("scopes by tenant: another tenant sees nothing, and a swapped-in document is refused", async () => {
    const { kv } = await seeded(undefined, "tenant-a");
    const b = new PolicyRegistry({ kv, scope: "tenant-b" });
    expect(await b.resolve("router")).toBeUndefined();
    expect(await b.versions("router")).toEqual([]);
    // tenant-b cannot move tenant-a's rollout, because there is none for it
    await expect(b.rollback({ id: "router", now: 1 })).rejects.toThrow(PolicyNotFoundError);

    // an attacker (or a bug) copies tenant-a's document under tenant-b's key
    const a = (await kv.load("loom.policies/tenant-a/router")) as { payload: unknown };
    await kv.save("loom.policies/tenant-b/router", { contractVersion: 1, payload: a.payload }, 0);
    await expect(b.resolve("router")).rejects.toThrow(PolicyAccessDeniedError);
    await expect(
      b.register({ id: "router", version: "9", contentHash: H("9"), now: 1 })
    ).rejects.toThrow(PolicyAccessDeniedError);
  });

  it("refuses unsafe names, which would otherwise address another key", async () => {
    const kv = new InMemoryPolicyKv();
    expect(() => new PolicyRegistry({ kv, scope: "" })).toThrow();
    const reg = new PolicyRegistry({ kv, scope: "t" });
    await expect(reg.resolve("../x")).rejects.toThrow(/policy id/);
    await expect(reg.resolve("a b")).rejects.toThrow(/policy id/);
  });
});
