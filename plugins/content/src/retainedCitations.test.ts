import { describe, expect, it } from "vitest";
import { visitCitedAddresses } from "./citations";

// ADR 0140 - a `retain: true` claim-check envelope's ref is load-bearing; a plain one stays reclaimable.
describe("visitCitedAddresses and retained envelopes", () => {
  const collect = (value: unknown) => {
    const seen: Array<[string, boolean]> = [];
    visitCitedAddresses(value, (a, inEnvelope) => seen.push([a, inEnvelope]));
    return seen;
  };
  const env = (address: string, extra: object = {}) => ({
    __loomClaimCheck: true,
    ref: { __loomContent: address },
    size: 9,
    ...extra,
  });
  it("reports a plain envelope as in-envelope (reclaimable) and a retained one as load-bearing", () => {
    expect(collect(env("a"))).toEqual([["a", true]]);
    expect(collect(env("b", { retain: true }))).toEqual([["b", false]]);
  });
  it("finds a retained envelope nested under a taint wrapper", () => {
    expect(
      collect({ __loomTainted: { origin: "mcp:x" }, value: env("c", { retain: true }) })
    ).toEqual([["c", false]]);
  });
});
