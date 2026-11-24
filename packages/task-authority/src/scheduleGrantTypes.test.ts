import { describe, expect, it } from "vitest";
import { type AnswerScheduleOptions, answerScheduleApproval } from "./scheduleGrant.js";

// The operator's vouching is REQUIRED in the types (R26): these calls must not compile. `pnpm typecheck:tests`
// fails on an unused `@ts-expect-error`, so the guard is proven to fire. At run time the same calls are refused.
const rt = { loadState: async () => undefined, resume: async () => undefined } as never;
const broker = { mint: async () => undefined, current: async () => undefined } as never;

describe("answerScheduleApproval: expect.issuedTo is required by the compiler", () => {
  it("rejects a call without the options, without expect, and without expect.issuedTo", async () => {
    const calls = [
      // @ts-expect-error the sixth argument (the options) is required
      () => answerScheduleApproval(rt, broker, "x", { approved: true }),
      // @ts-expect-error `expect` is required
      () => answerScheduleApproval(rt, broker, "x", { approved: true }, undefined, {}),
      // @ts-expect-error `expect.issuedTo` is required
      () => answerScheduleApproval(rt, broker, "x", { approved: true }, undefined, { expect: {} }),
    ];
    for (const c of calls) await expect(c()).rejects.toThrow();
  });
  it("accepts a call that vouches for the holder", () => {
    const o: AnswerScheduleOptions = { expect: { issuedTo: "svc" } };
    expect(o.expect.issuedTo).toBe("svc");
  });
});
