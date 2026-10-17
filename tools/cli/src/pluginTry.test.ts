import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { CustomStorage } from "@loom/plugin-kit";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { EXIT_USAGE } from "./args";
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
