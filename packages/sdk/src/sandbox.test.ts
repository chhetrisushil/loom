import { createHash } from "node:crypto";
import * as spi from "@loom/sandbox";
import { describe, expect, it } from "vitest";
import {
  QuickJsSandboxBackend,
  SANDBOX_BACKEND_SPI_VERSION,
  SandboxEffect,
  SandboxEvalEffect,
  registerSandboxBackend,
} from "./sandbox";

// `@loom/sdk/sandbox` carries the backend SPI (ADR 0144) next to the QuickJS plugin, so an app
// wiring its own backend imports one subpath. These are the SAME values as `@loom/sandbox`'s, not
// copies: a second `SandboxEffect` class would split `instanceof` across the two import paths.

describe("@loom/sdk/sandbox", () => {
  it("re-exports the backend SPI as the same values @loom/sandbox exports", () => {
    expect(SandboxEffect).toBe(spi.SandboxEffect);
    expect(registerSandboxBackend).toBe(spi.registerSandboxBackend);
    expect(SANDBOX_BACKEND_SPI_VERSION).toBe(spi.SANDBOX_BACKEND_SPI_VERSION);
    expect(SandboxEvalEffect.prototype).toBeInstanceOf(SandboxEffect);
  });

  it("runs a script through SandboxEffect on the QuickJS reference backend", async () => {
    const source = new TextEncoder().encode("({ doubled: input.n * 2 })");
    const ref = { __loomContent: `sha256:${createHash("sha256").update(source).digest("hex")}` };
    const effect = new SandboxEffect({ get: async () => source }, new QuickJsSandboxBackend());
    try {
      const out = await effect.execute({ scriptRef: ref, input: { n: 21 } }, {
        executionId: "e",
        stepId: "s",
        attempt: 1,
      } as never);
      expect(out).toEqual({ doubled: 42 });
    } finally {
      await effect.close();
    }
  });
});
