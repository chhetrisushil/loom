import { GrantTable } from "@loom/effect-runtime";
import { signedResumeAuthenticator } from "@loom/workflow-runtime";
import type { ExecutionAuthorizer } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { defineConfig as defineConfigRaw } from "./defineConfig";
import { withPrincipalCodec } from "./principalTestSupport";
import { STRICT_DEFAULTS } from "./strict";

// ADR 0113 D3 (R7) — the replay-divergence detector's mode: `warn` by default, `fail` under strict,
// an explicit `kernel.divergence` always wins. (The behaviour of each mode is pinned in
// workflow-runtime's r7-divergence.test.ts; this proves the config REACHES the runtime.)

const allowAll: ExecutionAuthorizer = { authorize: () => ({ allowed: true }) };
const strictSecurity = {
  strict: true,
  authorizer: new GrantTable({ f: ["t"] }),
  executionAuthorizer: allowAll,
  resumeAuthenticator: signedResumeAuthenticator({ gates: ["Approval"], keys: {} }),
} as const;

const modeOf = (app: { runtime: unknown }): string =>
  (app.runtime as { divergenceMode: string }).divergenceMode;

describe("kernel.divergence", () => {
  it("defaults to warn outside strict", async () => {
    const app = defineConfigRaw({
      storage: { kind: "memory" },
      autostart: false,
      security: { strict: false },
    });
    expect(modeOf(app)).toBe("warn");
    await app.close();
  });

  it("an explicit setting reaches the runtime", async () => {
    for (const mode of ["off", "warn", "fail"] as const) {
      const app = defineConfigRaw({
        storage: { kind: "memory" },
        autostart: false,
        security: { strict: false },
        kernel: { divergence: mode },
      });
      expect(modeOf(app)).toBe(mode);
      await app.close();
    }
  });

  it("security.strict defaults it to fail", async () => {
    expect(STRICT_DEFAULTS.divergence).toBe("fail");
    const app = defineConfigRaw(
      withPrincipalCodec({
        storage: { kind: "memory" },
        autostart: false,
        security: strictSecurity,
      })
    );
    expect(modeOf(app)).toBe("fail");
    await app.close();
  });

  it("…and an explicit kernel.divergence wins over strict", async () => {
    const app = defineConfigRaw(
      withPrincipalCodec({
        storage: { kind: "memory" },
        autostart: false,
        security: strictSecurity,
        kernel: { divergence: "warn" },
      })
    );
    expect(modeOf(app)).toBe("warn");
    await app.close();
  });
});
