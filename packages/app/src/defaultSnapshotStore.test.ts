import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { describe, expect, it } from "vitest";
import { defineConfig } from "./defineConfig";

// ADR 0130 D8 (user ruling 2026-10-14): with encrypting events, the DEFAULT snapshot store is built
// with `sealState` on the same KeyStore (not refused at boot); an explicit plaintext store is refused.

const encrypted = () => {
  const keys = new InMemoryKeyStore();
  const events = new EncryptingEventStore(new InMemoryAsyncEventStore(), keys, {
    sensitive: { INBOX_MESSAGE: ["payload"] },
    subjectOf: (e) => e.executionId,
  });
  return { keys, events };
};

describe("defineConfig default snapshot store under encrypting events", () => {
  it("builds the default with sealState on the SAME KeyStore", () => {
    const { keys, events } = encrypted();
    const app = defineConfig({
      storage: { kind: "custom", eventStore: events },
      autostart: false,
      security: { strict: false, crypto: { events } },
    });
    const snaps = app.stores.snapshotStore as { sealsWholeState?: unknown; keys?: unknown };
    expect(snaps.sealsWholeState).toBe(true);
    expect(snaps.keys).toBe(keys);
  });

  it("an explicit plaintext snapshot store is still refused", () => {
    const { events } = encrypted();
    expect(() =>
      defineConfig({
        storage: {
          kind: "custom",
          eventStore: events,
          snapshotStore: new InMemoryAsyncSnapshotStore(),
        },
        autostart: false,
        security: { strict: false, crypto: { events } },
      })
    ).toThrow(/PlaintextCheckpointError|allowPlaintextCheckpoints/);
  });

  it("allowPlaintextCheckpoints: true boots with the explicit plaintext store", () => {
    const { events } = encrypted();
    const app = defineConfig({
      storage: {
        kind: "custom",
        eventStore: events,
        snapshotStore: new InMemoryAsyncSnapshotStore(),
      },
      autostart: false,
      security: { strict: false, crypto: { events, allowPlaintextCheckpoints: true } },
    });
    expect(app.security?.crypto?.allowPlaintextCheckpoints).toBe(true);
  });

  it("a plain event store keeps the plain in-memory default (golden)", () => {
    const app = defineConfig({
      storage: { kind: "custom", eventStore: new InMemoryAsyncEventStore() },
      autostart: false,
    });
    expect((app.stores.snapshotStore as { sealsWholeState?: unknown }).sealsWholeState).toBe(
      undefined
    );
  });
});
