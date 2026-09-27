import { describe, expect, it } from "vitest";
import { notifyChannels } from "./PostgresEventStore";
import { NOTIFY_CHANNEL } from "./schema";

// Pure and DB-independent, unlike the rest of this package's suites (gated on
// LOOM_TEST_POSTGRES_URL) — this always runs, including in CI with no Postgres service.

describe("notifyChannels", () => {
  it("is the single legacy channel when notifyBuckets is 1", () => {
    expect(notifyChannels(1)).toEqual([NOTIFY_CHANNEL]);
  });

  it("clamps a non-positive notifyBuckets to the legacy channel, matching the store's own floor", () => {
    expect(notifyChannels(0)).toEqual([NOTIFY_CHANNEL]);
    expect(notifyChannels(-5)).toEqual([NOTIFY_CHANNEL]);
  });

  it("enumerates every bucket channel a multi-bucket store publishes on", () => {
    const channels = notifyChannels(16);
    expect(channels).toHaveLength(16);
    expect(new Set(channels).size).toBe(16); // all distinct
    for (let i = 0; i < 16; i++) {
      expect(channels[i]).toBe(`${NOTIFY_CHANNEL}_${i}`);
    }
  });

  it("never includes the bare legacy channel name once bucketed", () => {
    expect(notifyChannels(16)).not.toContain(NOTIFY_CHANNEL);
  });
});
