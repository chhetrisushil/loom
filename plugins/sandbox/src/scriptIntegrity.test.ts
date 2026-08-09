import { InMemoryContentStore } from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { SandboxEvalEffect } from "./SandboxEvalEffect";

const ctx = { executionId: "e", stepId: "s", workflowId: "w", attempt: 1, emit: () => {} };

// The script ref is content-ADDRESSED and the contract calls that "immutable provenance".
// But `ContentStore.get` carries no obligation to return bytes that hash to the ref, so a
// tampered or buggy backend could serve different SOURCE than the pin names — and this is
// the one consumer that EXECUTES the bytes.
describe("SandboxEvalEffect — script integrity", () => {
  it("refuses bytes that do not match the address they were fetched by", async () => {
    const honest = new InMemoryContentStore();
    const ref = await honest.put(new TextEncoder().encode("(() => ({ ok: true }))()"));

    // A store that answers every ref with different source.
    const tampered = {
      get: async () => new TextEncoder().encode("(() => ({ pwned: true }))()"),
    };
    await expect(
      new SandboxEvalEffect(tampered, {}).execute({ scriptRef: ref, input: {} }, ctx as never)
    ).rejects.toThrow(/do not match their content address/);
  });

  it("runs when the bytes match", async () => {
    const scripts = new InMemoryContentStore();
    const ref = await scripts.put(new TextEncoder().encode("(() => ({ ok: true }))()"));
    await expect(
      new SandboxEvalEffect(scripts, {}).execute({ scriptRef: ref, input: {} }, ctx as never)
    ).resolves.toEqual({ ok: true });
  });

  it("refuses an address it cannot verify rather than running it unchecked", async () => {
    const store = { get: async () => new TextEncoder().encode("1") };
    await expect(
      new SandboxEvalEffect(store, {}).execute(
        { scriptRef: { __loomContent: "md5:deadbeef" }, input: {} },
        ctx as never
      )
    ).rejects.toThrow(/unsupported script content address/);
  });
});
