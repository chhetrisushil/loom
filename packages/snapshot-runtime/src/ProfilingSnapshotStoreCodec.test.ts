import { describe, expect, it } from "vitest";
import { InMemoryAsyncSnapshotStore } from "./InMemoryAsyncSnapshotStore";
import { ProfilingSnapshotStore } from "./ProfilingSnapshotStore";
import { encodeState, zstdAvailable } from "./snapshotCodec";
import type { Snapshot } from "./types";

const state = { pad: "the same words again ".repeat(500) } as unknown as Snapshot["state"];
const snap: Snapshot = {
  id: "x-1",
  executionId: "x",
  workflowId: "wf",
  sequence: 1,
  state,
  createdAt: 1,
};

describe("ProfilingSnapshotStore size = stored bytes (ADR 0140)", () => {
  it("measures the JSON text when the wrapped store writes no codec (unchanged)", async () => {
    const p = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore());
    await p.save(snap);
    expect(p.profile().maxBytes).toBe(Buffer.byteLength(JSON.stringify(state)));
  });

  it('measure: "stored" without a codec adds only the format byte', async () => {
    const p = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore(), { measure: "stored" });
    await p.save(snap);
    expect(p.profile().maxBytes).toBe(Buffer.byteLength(JSON.stringify(state)) + 1);
  });

  describe.skipIf(!zstdAvailable())("zstd", () => {
    it("measures the compressed frame by default when the wrapped store reports zstd", async () => {
      const p = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore({ codec: "zstd" }));
      await p.save(snap);
      const stored = encodeState(state, "zstd").length;
      expect(p.profile().maxBytes).toBe(stored);
      expect(stored).toBeLessThan(Buffer.byteLength(JSON.stringify(state)) / 5);
    });

    it('measure: "json" still reports the text size under zstd', async () => {
      const p = new ProfilingSnapshotStore(new InMemoryAsyncSnapshotStore({ codec: "zstd" }), {
        measure: "json",
      });
      await p.save(snap);
      expect(p.profile().maxBytes).toBe(Buffer.byteLength(JSON.stringify(state)));
    });
  });

  describe.skipIf(!zstdAvailable())("over a store that seals the whole state (ADR 0140 D3)", () => {
    const sealing = () =>
      Object.assign(new InMemoryAsyncSnapshotStore({ codec: "zstd" }), {
        sealsWholeState: true as const,
      });

    it("never reports stored (compressed) size: the default is the JSON text size", async () => {
      const p = new ProfilingSnapshotStore(sealing());
      await p.save(snap);
      expect(p.profile().maxBytes).toBe(Buffer.byteLength(JSON.stringify(state)));
    });

    it('an explicit measure: "stored" throws (a length oracle must not reach metrics)', () => {
      expect(() => new ProfilingSnapshotStore(sealing(), { measure: "stored" })).toThrow(
        /seals the whole state/
      );
    });
  });
});
