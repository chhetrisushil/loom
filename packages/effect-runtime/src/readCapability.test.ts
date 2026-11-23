import { describe, expect, it } from "vitest";
import { EffectRuntime } from "./EffectRuntime";
import type { CapabilityRequest } from "./authz";
import { ToolEffect } from "./effects/ToolEffect";

// ADR 0150 D8: `capabilities.read` is snapshotted at register and validated there.
const ctx = { executionId: "e", workflowId: "w", stepId: "s", emit: () => {} } as never;
const rt = () => {
  const seen: CapabilityRequest[] = [];
  const runtime = new EffectRuntime([], {
    authorizer: {
      authorize: (r) => {
        seen.push(r);
        return { allowed: true };
      },
    },
  });
  return { runtime, seen };
};

describe("capabilities.read at register", () => {
  // kills: reading `capabilities` live per call (a flipped flag would unmark a registered read)
  it("a mutation of capabilities after register does not unmark the read", async () => {
    const { runtime, seen } = rt();
    const caps = { read: true };
    runtime.register("r", new ToolEffect(async () => 1, { capabilities: caps }));
    caps.read = false;
    await runtime.execute("r", {}, ctx);
    expect(seen[0]?.read).toBe(true);
  });

  // kills: accepting a truthy non-boolean (`"true"`, 1) that the runtime would never treat as a read
  it("a non-boolean read is refused at register", () => {
    const { runtime } = rt();
    for (const bad of ["true", 1, {}]) {
      expect(() =>
        runtime.register(
          "r",
          new ToolEffect(async () => 1, { capabilities: { read: bad as never } })
        )
      ).toThrow(/must be a boolean/);
    }
  });

  // kills: a stale mark surviving re-registration
  it("re-registering re-snapshots", async () => {
    const { runtime, seen } = rt();
    runtime.register("r", new ToolEffect(async () => 1, { capabilities: { read: true } }));
    runtime.register("r", new ToolEffect(async () => 1));
    await runtime.execute("r", {}, ctx);
    expect(seen[0]?.read).toBeUndefined();
  });
});
