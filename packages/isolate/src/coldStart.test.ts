import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { EffectContext } from "@loom/effect-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IsolatedToolEffect, IsolatedToolStartupError } from "./IsolatedToolEffect";
import type { IsolatedToolSpec } from "./types";

// ── L23 — timeoutMs must not charge the child's cold start ───────────────────
//
// `slow-load.cjs` pays 1300 ms at require time, deterministically standing in for a cold child
// under load. The tool itself returns immediately, so any timeoutMs under 1300 ms can only
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
    const effect = make({ modulePath: fixture("slow-load.cjs"), timeoutMs: 1000 });
    await expect(effect.execute({ n: 1 }, ctx())).resolves.toEqual({ echoed: { n: 1 } });
  });

  it("does not loop: the next call reuses the same warm child (no re-spawn)", async () => {
    const effect = make({ modulePath: fixture("slow-load.cjs"), timeoutMs: 1000 });
    await effect.execute({ n: 1 }, ctx());
    // biome-ignore lint/suspicious/noExplicitAny: reading the private child under test
    const pid = (effect as any).child?.pid;
    expect(pid).toBeTypeOf("number");
    await effect.execute({ n: 2 }, ctx());
    // biome-ignore lint/suspicious/noExplicitAny: reading the private child under test
    expect((effect as any).child?.pid).toBe(pid);
  });

  it("a runner that has not booted within coldStartMs fails in the SPAWN phase", async () => {
    // 1 ms is shorter than any process spawn, so the runner cannot have booted.
    const effect = make({ modulePath: fixture("echo.cjs"), coldStartMs: 1 });
    const err = await effect.execute({}, ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IsolatedToolStartupError);
    expect((err as IsolatedToolStartupError).phase).toBe("spawn");
    expect((err as IsolatedToolStartupError).limitMs).toBe(1);
  });

  it("untrusted top-level code that outlasts coldStartMs fails in the LOAD phase", async () => {
    const effect = make({ modulePath: fixture("hang-on-load.cjs"), coldStartMs: 800 });
    const err = await effect.execute({}, ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IsolatedToolStartupError);
    expect((err as IsolatedToolStartupError).phase).toBe("load");
  });

  it("any exit during module load is death with the typed error, phase load", async () => {
    const effect = make({ modulePath: fixture("die-on-load.cjs") });
    const err = await effect.execute({}, ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IsolatedToolStartupError);
    expect((err as IsolatedToolStartupError).phase).toBe("load");
  });

  it("a module that THROWS at load fails in the load phase as a tool error, its top-level code run ONCE", async () => {
    const log = path.join(mkdtempSync(path.join(tmpdir(), "isolate-load-")), "log");
    const effect = make({
      modulePath: fixture("throws-on-load.cjs"),
      env: { LOAD_LOG: log },
    });
    const err = await effect.execute({}, ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(IsolatedToolStartupError);
    expect((err as Error).message).toMatch(/boom at load/);
    expect((err as Error).message).toMatch(/failed to load/);
    expect(readFileSync(log, "utf8")).toBe("x"); // not re-executed by the run
  });

  it("an abort while the child is still warming rejects with the abort reason", async () => {
    const effect = make({ modulePath: fixture("slow-load.cjs") });
    const ac = new AbortController();
    const p = effect.execute({}, { ...ctx(), signal: ac.signal });
    ac.abort(new Error("cancelled"));
    await expect(p).rejects.toThrow("cancelled");
  });

  it("an abort DURING warm-up (after spawn) kills the child and rejects with the reason", async () => {
    const effect = make({ modulePath: fixture("slow-load.cjs") });
    const ac = new AbortController();
    const p = effect.execute({}, { ...ctx(), signal: ac.signal });
    const settled = p.catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 300)); // well past spawn, inside the 1300 ms load
    // biome-ignore lint/suspicious/noExplicitAny: reading the private child under test
    const proc = (effect as any).child;
    expect(proc).toBeDefined();
    ac.abort(new Error("cancelled mid-warm"));
    expect(((await settled) as Error).message).toBe("cancelled mid-warm");
    await new Promise((r) =>
      proc.exitCode !== null || proc.signalCode ? r(0) : proc.once("exit", r)
    );
    // biome-ignore lint/suspicious/noExplicitAny: reading the private child under test
    expect((effect as any).child).toBeUndefined();
  });

  it("coldStartMs must be a finite number > 0", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new IsolatedToolEffect({ id: "x", modulePath: "/x", coldStartMs: bad })).toThrow(
        /coldStartMs must be a finite number > 0/
      );
    }
  });
});
