import { describe, expect, it } from "vitest";
import { type ClaimCheckEnvelope, type ClaimCheckReader, resolveClaimChecks } from "./claimCheck";

// ── TS-10 (ADR 0062) — the batch twin of resolveClaimCheck ───────────────────

function makeReader(blobs: Record<string, unknown>, supportsGetMany: boolean) {
  const encoded = new Map(
    Object.entries(blobs).map(([k, v]) => [k, new TextEncoder().encode(JSON.stringify(v))])
  );
  const calls = { get: 0, getMany: 0 };
  const reader: ClaimCheckReader = {
    async get(ref) {
      calls.get++;
      return encoded.get(ref.__loomContent) ?? null;
    },
  };
  if (supportsGetMany) {
    reader.getMany = async (refs) => {
      calls.getMany++;
      return refs.map((r) => encoded.get(r.__loomContent) ?? null);
    };
  }
  return { reader, calls };
}

const envelope = (address: string): ClaimCheckEnvelope => ({
  __loomClaimCheck: true,
  ref: { __loomContent: address },
  size: 1,
});

describe("resolveClaimChecks (TS-10, ADR 0062)", () => {
  it("resolves a batch in one getMany, deduped by address, null per absent entry", async () => {
    const { reader, calls } = makeReader({ "sha256:a": { a: 1 }, "sha256:b": { b: 2 } }, true);
    const results = await resolveClaimChecks(reader, [
      envelope("sha256:a"),
      envelope("sha256:missing"),
      envelope("sha256:b"),
      envelope("sha256:a"), // duplicate — one fetch, own decoded instance
    ]);
    expect(results).toEqual([{ a: 1 }, null, { b: 2 }, { a: 1 }]);
    expect(results[0]).not.toBe(results[3]); // decoded per occurrence — never aliased
    expect(calls.getMany).toBe(1);
    expect(calls.get).toBe(0);
  });

  it("falls back to coalesced gets on a reader without getMany", async () => {
    const { reader, calls } = makeReader({ "sha256:a": { a: 1 } }, false);
    const results = await resolveClaimChecks(reader, [envelope("sha256:a"), envelope("sha256:a")]);
    expect(results).toEqual([{ a: 1 }, { a: 1 }]);
    expect(calls.get).toBe(1); // deduped by address even on the fallback path
  });

  it("refuses non-JSON codecs loudly, like resolveClaimCheck", async () => {
    const { reader } = makeReader({}, true);
    const streamed: ClaimCheckEnvelope = { ...envelope("sha256:s"), codec: "bytes" };
    await expect(resolveClaimChecks(reader, [streamed])).rejects.toThrow(
      /not JSON — use resolveClaimCheckBytes/
    );
  });
});
