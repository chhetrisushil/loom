import type { EffectContext } from "@loom/effect-runtime";
import { describe, expect, it } from "vitest";
import {
  type ClaimCheckAccess,
  type ClaimCheckEnvelope,
  claimCheckMiddleware,
  resolveClaimCheck,
  resolveClaimCheckBytes,
  resolveClaimChecks,
  streamResult,
} from "./claimCheck";

// ADR 0143 - the owning execution travels with every put/get, so a store that seals per subject knows whose
// key to use. A plain store (one-argument put/get) is unaffected.

const ctx = (executionId: string): EffectContext =>
  ({
    executionId,
    stepId: "s",
    workflowId: "wf-9",
    toolId: "t",
  }) as unknown as EffectContext;

function recordingStore() {
  const calls: Array<{ op: string; access: ClaimCheckAccess | undefined }> = [];
  const blobs = new Map<string, Uint8Array>();
  const store = {
    calls,
    async put(bytes: Uint8Array, access?: ClaimCheckAccess) {
      calls.push({ op: "put", access });
      blobs.set("a:1", bytes);
      return { __loomContent: "a:1" };
    },
    async putStream(stream: AsyncIterable<Uint8Array>, access?: ClaimCheckAccess) {
      calls.push({ op: "putStream", access });
      const parts: Uint8Array[] = [];
      for await (const c of stream) parts.push(c);
      blobs.set("a:2", Buffer.concat(parts));
      return { __loomContent: "a:2" };
    },
    async get(ref: { __loomContent: string }, access?: ClaimCheckAccess) {
      calls.push({ op: "get", access });
      return blobs.get(ref.__loomContent) ?? null;
    },
    async getMany(refs: readonly { __loomContent: string }[], access?: ClaimCheckAccess) {
      calls.push({ op: "getMany", access });
      return refs.map((r) => blobs.get(r.__loomContent) ?? null);
    },
  };
  return store;
}

describe("claim-check passes the owning execution to the store (ADR 0143)", () => {
  const owner = { executionId: "exec-7", workflowId: "wf-9" };

  it("put and putStream receive the running effect's execution and workflow", async () => {
    const store = recordingStore();
    const mw = claimCheckMiddleware({ store, inlineCapBytes: 4 });
    await mw(ctx("exec-7"), {}, async () => ({ big: "x".repeat(50) }));
    await mw(ctx("exec-7"), {}, async () =>
      streamResult(
        (async function* () {
          yield new Uint8Array([1, 2, 3]);
        })()
      )
    );
    expect(store.calls).toEqual([
      { op: "put", access: owner },
      { op: "putStream", access: owner },
    ]);
  });

  it("the resolvers forward the owner to get and getMany", async () => {
    const store = recordingStore();
    const mw = claimCheckMiddleware({ store, inlineCapBytes: 4 });
    const env = (await mw(ctx("exec-7"), {}, async () => ({
      big: "x".repeat(50),
    }))) as ClaimCheckEnvelope;
    store.calls.length = 0;
    expect(await resolveClaimCheck(store, env, owner)).toEqual({ big: "x".repeat(50) });
    await resolveClaimCheckBytes(store, env, owner);
    await resolveClaimChecks(store, [env, env], owner);
    expect(store.calls).toEqual([
      { op: "get", access: owner },
      { op: "get", access: owner },
      { op: "getMany", access: owner },
    ]);
  });

  it("without an owner the resolvers call the store exactly as before (a plain store sees one argument)", async () => {
    const store = recordingStore();
    const env = {
      __loomClaimCheck: true,
      ref: { __loomContent: "a:1" },
      size: 1,
    } as ClaimCheckEnvelope;
    await resolveClaimCheck(store, env);
    expect(store.calls).toEqual([{ op: "get", access: undefined }]);
  });
});
