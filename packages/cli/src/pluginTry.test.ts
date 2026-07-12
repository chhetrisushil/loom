import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { CustomStorage } from "@loom/plugin-kit";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { trySmoke } from "./pluginTry";

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
