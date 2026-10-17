import { describe, expect, it } from "vitest";
import { baselineRefusal } from "./run";

describe("eval:update-baseline refuses a partial board", () => {
  it("refuses (with a message naming the cause and the escape hatch) when the Postgres leg did not run", () => {
    const msg = baselineRefusal(false, ["--update-baseline"]);
    expect(msg).toMatch(/Postgres leg did not run/);
    expect(msg).toMatch(/LOOM_TEST_POSTGRES_URL/);
    expect(msg).toMatch(/--allow-partial/);
  });
  it("allows it when the leg ran, or when --allow-partial is passed", () => {
    expect(baselineRefusal(true, ["--update-baseline"])).toBeUndefined();
    expect(baselineRefusal(false, ["--update-baseline", "--allow-partial"])).toBeUndefined();
  });
});
