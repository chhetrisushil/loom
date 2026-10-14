import { runKeyStoreConformance } from "@loom/conformance";
import { describe, expect, it } from "vitest";
import { InMemoryKeyStore } from "./keystore";

// The reference KeyStore must uphold the erasure contract every backing (KMS/HSM/vault) owes.
runKeyStoreConformance(() => new InMemoryKeyStore(), "InMemoryKeyStore");

describe("InMemoryKeyStore.wasDestroyed (ADR 0130 D7 round 5)", () => {
  it("is true only after THIS store destroyed the subject", async () => {
    const s = new InMemoryKeyStore();
    expect(await s.wasDestroyed("never")).toBe(false);
    await s.getOrCreate("alive");
    expect(await s.wasDestroyed("alive")).toBe(false);
    await s.destroy("alive");
    expect(await s.wasDestroyed("alive")).toBe(true);
  });
});
