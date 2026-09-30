import * as path from "node:path";
import type { EffectContext } from "@loom/effect-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IsolatedToolDisconnectedError,
  IsolatedToolEffect,
  IsolatedToolInputError,
} from "./IsolatedToolEffect";

const fixture = (n: string) => path.join(__dirname, "__fixtures__", n);
const ctxWith = (emit: EffectContext["emit"] = vi.fn()): EffectContext => ({
  executionId: "e",
  stepId: "s",
  workflowId: "w",
  attempt: 1,
  emit,
});
const open: IsolatedToolEffect[] = [];
afterEach(() => {
  for (const e of open.splice(0)) e.close();
});

describe("an emit that throws inside the fetch handler is contained", () => {
  const boom = (): never => {
    throw new Error("emit after settle");
  };
  it("allowlist refusal: no unhandled rejection, tool still answered, run faulted", async () => {
    const effect = new IsolatedToolEffect({ id: "em", modulePath: "/nonexistent.js", egress: [] });
    const sent: unknown[] = [];
    const onFault = vi.fn();
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: reaching the private broker path under test
      (effect as any).handleFetch(
        { send: (m: unknown) => sent.push(m) },
        0,
        "http://denied.test/",
        undefined,
        ctxWith(boom),
        undefined,
        onFault
      )
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(onFault).toHaveBeenCalledWith(expect.objectContaining({ message: "emit after settle" }));
  });

  it("concurrency-limit refusal: same", async () => {
    const effect = new IsolatedToolEffect({
      id: "em2",
      modulePath: "/nonexistent.js",
      maxConcurrentFetches: 1,
    });
    // biome-ignore lint/suspicious/noExplicitAny: forcing the limit branch
    (effect as any).inFlightFetches = 1;
    const sent: unknown[] = [];
    const onFault = vi.fn();
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: reaching the private broker path under test
      (effect as any).handleFetch(
        { send: (m: unknown) => sent.push(m) },
        0,
        "http://x.test/",
        undefined,
        ctxWith(boom),
        undefined,
        onFault
      )
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(onFault).toHaveBeenCalledTimes(1);
  });

  it("end to end: a tool fetching a denied URL with a throwing emit fails the run cleanly", async () => {
    const effect = new IsolatedToolEffect({
      id: "em3",
      modulePath: fixture("fetcher.cjs"),
      egress: [],
      timeoutMs: 5000,
    });
    open.push(effect);
    await expect(effect.execute({ url: "http://denied.test/" }, ctxWith(boom))).rejects.toThrow(
      "emit after settle"
    );
  });
});

describe("crash attribution survives the disconnect handling", () => {
  it("a child killed mid-run is reported as crashed, not as a lost channel", async () => {
    const effect = new IsolatedToolEffect({
      id: "cr",
      modulePath: fixture("crasher.cjs"),
      timeoutMs: 5000,
    });
    open.push(effect);
    await expect(effect.execute({}, ctxWith())).rejects.toThrow(/crashed mid-run/);
  });

  it("a tool that severs its own channel is still IsolatedToolDisconnectedError", async () => {
    const effect = new IsolatedToolEffect({
      id: "cr2",
      modulePath: fixture("disconnecting.cjs"),
      timeoutMs: 5000,
    });
    open.push(effect);
    await expect(
      effect.execute({ mode: "fetch-then-disconnect", url: "http://x.test/" }, ctxWith())
    ).rejects.toBeInstanceOf(IsolatedToolDisconnectedError);
  });
});

describe("a non-serializable input is a typed, side-effect-free rejection", () => {
  it("circular and BigInt inputs reject with IsolatedToolInputError; the child and listeners are untouched", async () => {
    const effect = new IsolatedToolEffect({
      id: "in",
      modulePath: fixture("echo.cjs"),
      timeoutMs: 5000,
    });
    open.push(effect);
    await expect(effect.execute({ n: 1 }, ctxWith())).resolves.toMatchObject({ echoed: { n: 1 } });
    // biome-ignore lint/suspicious/noExplicitAny: reading the private child under test
    const child = (effect as any).child;
    const pid = child.pid;
    const before = ["message", "exit", "disconnect"].map((e) => child.listenerCount(e));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const bad of [circular, { n: 1n }]) {
      const err = await effect.execute(bad, ctxWith()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IsolatedToolInputError);
    }
    expect(["message", "exit", "disconnect"].map((e) => child.listenerCount(e))).toEqual(before);
    // the healthy child was NOT killed and serves the next run
    await expect(effect.execute({ n: 2 }, ctxWith())).resolves.toMatchObject({ echoed: { n: 2 } });
    // biome-ignore lint/suspicious/noExplicitAny: reading the private child under test
    expect((effect as any).child.pid).toBe(pid);
  });
});
