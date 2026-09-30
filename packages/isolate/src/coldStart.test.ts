import * as path from "node:path";
import type { EffectContext } from "@loom/effect-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IsolatedToolEffect, IsolatedToolStartupError } from "./IsolatedToolEffect";
import type { IsolatedToolSpec } from "./types";

// ── L23 — timeoutMs must not charge the child's cold start ───────────────────
//
// `slow-load.cjs` pays 600 ms at require time, deterministically standing in for a cold child
// under load. The tool itself returns immediately, so any timeoutMs well under 600 ms can only
// fire if startup is charged to it.

const fixture = (name: string) => path.join(__dirname, "__fixtures__", name);
const ctx = (): EffectContext => ({
  executionId: "e",
  stepId: "s",
  workflowId: "w",
  attempt: 1,
  emit: vi.fn(),
});
const open: IsolatedToolEffect[] = [];
const make = (spec: Partial<IsolatedToolSpec> & { modulePath: string }): IsolatedToolEffect => {
  const e = new IsolatedToolEffect({ id: "cold", ...spec });
  open.push(e);
  return e;
};
afterEach(() => {
  for (const e of open.splice(0)) e.close();
});

describe("isolate cold start is not charged to timeoutMs (L23)", () => {
  it("a tool that runs well inside timeoutMs succeeds although the child took far longer to start", async () => {
    const effect = make({ modulePath: fixture("slow-load.cjs"), timeoutMs: 150 });
    await expect(effect.execute({ n: 1 }, ctx())).resolves.toEqual({ echoed: { n: 1 } });
  });

  it("does not loop: the next call reuses the same warm child (no re-spawn)", async () => {
    const effect = make({ modulePath: fixture("slow-load.cjs"), timeoutMs: 150 });
    await effect.execute({ n: 1 }, ctx());
    // biome-ignore lint/suspicious/noExplicitAny: reading the private child under test
    const pid = (effect as any).child?.pid;
    expect(pid).toBeTypeOf("number");
    await effect.execute({ n: 2 }, ctx());
    // biome-ignore lint/suspicious/noExplicitAny: reading the private child under test
    expect((effect as any).child?.pid).toBe(pid);
  });

  it("a cold start that outlasts coldStartMs fails with a typed startup error (phase spawn)", async () => {
    const effect = make({ modulePath: fixture("slow-load.cjs"), coldStartMs: 100 });
    const err = await effect.execute({}, ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IsolatedToolStartupError);
    expect((err as IsolatedToolStartupError).phase).toBe("spawn");
    expect((err as IsolatedToolStartupError).limitMs).toBe(100);
  });

  it("any exit during warm-up is death with the typed error, not a hang or a generic crash", async () => {
    const effect = make({ modulePath: fixture("die-on-load.cjs") });
    await expect(effect.execute({}, ctx())).rejects.toBeInstanceOf(IsolatedToolStartupError);
  });

  it("an abort while the child is still warming rejects with the abort reason", async () => {
    const effect = make({ modulePath: fixture("slow-load.cjs") });
    const ac = new AbortController();
    const p = effect.execute({}, { ...ctx(), signal: ac.signal });
    ac.abort(new Error("cancelled"));
    await expect(p).rejects.toThrow("cancelled");
  });

  it("coldStartMs must be a finite number > 0", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new IsolatedToolEffect({ id: "x", modulePath: "/x", coldStartMs: bad })).toThrow(
        /coldStartMs must be a finite number > 0/
      );
    }
  });
});
