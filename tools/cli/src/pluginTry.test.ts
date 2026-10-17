import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { CustomStorage } from "@loom/plugin-kit";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it, vi } from "vitest";
import { EXIT_USAGE } from "./args";
import { run } from "./cli";
import { cmdPluginTry, trySmoke } from "./pluginTry";

describe("trySmoke", () => {
  it("runs a durable smoke flow through a storage descriptor and confirms replay", async () => {
    const storage: CustomStorage = {
      kind: "custom",
      eventStore: new InMemoryAsyncEventStore(),
      snapshotStore: new InMemoryAsyncSnapshotStore(),
    };
    const r = await trySmoke(storage, "memoryStorage");
    expect(r.completed).toBe(true);
    expect(r.eventsPersisted).toBeGreaterThan(0);
    expect(r.replayOk).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.preset).toBe("memoryStorage");
  });
});

describe("cmdPluginTry load failure", () => {
  it("is a short actionable usage error with the original kept as cause, no require stack", async () => {
    let caught: unknown;
    try {
      await cmdPluginTry({ module: "./definitely-not-here/index.js" });
    } catch (e) {
      caught = e;
    }
    const err = caught as Error & { exitCode?: number };
    expect(err).toBeInstanceOf(Error);
    expect(err.exitCode).toBe(EXIT_USAGE);
    expect(err.message).toMatch(/cannot load/);
    expect(err.message).toMatch(/built/);
    expect(err.message).toMatch(/--verbose/);
    expect(err.message).not.toMatch(/Require stack/);
    expect(err.message.split("\n").length).toBeLessThanOrEqual(3);
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe("loom plugin try --verbose (end to end through run)", () => {
  async function runCaptured(argv: string[]): Promise<{ code: number; err: string }> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.join(" "));
    });
    const prevDebug = process.env.LOOM_DEBUG;
    // biome-ignore lint/performance/noDelete: an env var must be unset, not the string "undefined"
    delete process.env.LOOM_DEBUG;
    try {
      const code = await run(argv);
      return { code, err: lines.join("\n") };
    } finally {
      spy.mockRestore();
      if (prevDebug !== undefined) process.env.LOOM_DEBUG = prevDebug;
    }
  }

  it("accepts --verbose (and -v) and prints the cause stack; exit 2", async () => {
    for (const flag of ["--verbose", "-v"]) {
      const { code, err } = await runCaptured(["plugin", "try", "--module", "./nope", flag]);
      expect(code).toBe(EXIT_USAGE);
      expect(err).toMatch(/cannot load/);
      expect(err).not.toMatch(/unknown flag/i);
      expect(err).toMatch(/\n\s+at /); // a stack frame
    }
  });
  it("prints no stack without --verbose, but still hints at it", async () => {
    const { code, err } = await runCaptured(["plugin", "try", "--module", "./nope"]);
    expect(code).toBe(EXIT_USAGE);
    expect(err).toMatch(/--verbose/);
    expect(err).not.toMatch(/\n\s+at /);
  });
});
