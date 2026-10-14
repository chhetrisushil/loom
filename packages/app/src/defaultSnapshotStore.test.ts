import { type EventStore, InMemoryAsyncEventStore } from "@loom/event-runtime";
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

  // A stand-in for a durable backend (not an InMemoryAsyncEventStore, no wrapper to see through).
  const durableLike = () => {
    const mem = new InMemoryAsyncEventStore();
    return {
      append: mem.append.bind(mem),
      read: mem.read.bind(mem),
    } as unknown as EventStore;
  };

  it("WARNS (onWarn) when the in-memory default is chosen for a NON-in-memory event store, naming the fix", () => {
    const warnings: string[] = [];
    defineConfig({
      storage: { kind: "custom", eventStore: durableLike() },
      autostart: false,
      observability: { onWarn: (m) => warnings.push(m) },
    });
    const w = warnings.filter((m) => /snapshotStore/.test(m) && /in-memory/.test(m));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/sealState/);
  });

  it("does NOT warn for an in-memory event store (plain, or an encrypting wrapper over it), nor when a snapshot store is given", () => {
    const warnings: string[] = [];
    const onWarn = (m: string) => warnings.push(m);
    defineConfig({
      storage: { kind: "custom", eventStore: new InMemoryAsyncEventStore() },
      autostart: false,
      observability: { onWarn },
    });
    const { events } = encrypted();
    defineConfig({
      storage: { kind: "custom", eventStore: events },
      autostart: false,
      security: { strict: false, crypto: { events } },
      observability: { onWarn },
    });
    defineConfig({
      storage: {
        kind: "custom",
        eventStore: durableLike(),
        snapshotStore: new InMemoryAsyncSnapshotStore(),
      },
      autostart: false,
      observability: { onWarn },
    });
    expect(warnings.filter((m) => /in-memory/.test(m) && /snapshotStore/.test(m))).toEqual([]);
  });

  it("a malformed `keys` marker is not sealed over: warns and falls back to refusing (plain default)", () => {
    const warnings: string[] = [];
    const store = Object.assign(durableLike(), { keys: { nope: true } });
    defineConfig({
      storage: { kind: "custom", eventStore: store },
      autostart: false,
      observability: { onWarn: (m) => warnings.push(m) },
    });
    expect(warnings.some((m) => /keys/.test(m) && /KeyStore/.test(m))).toBe(true);
  });
});
