import { describe, expect, it } from "vitest";
import { InMemoryKillSwitch, type KillSwitchRegistry } from "./killSwitchRegistry";

describe("KillSwitchRegistry.scope", () => {
  it("InMemoryKillSwitch declares itself process-local, and a subclass inherits that", () => {
    expect(new InMemoryKillSwitch().scope).toBe("process");
    class Sub extends InMemoryKillSwitch {}
    expect(new Sub().scope).toBe("process");
  });

  it("the marker is optional: a bare registry is still a valid KillSwitchRegistry", () => {
    const bare: KillSwitchRegistry = { check: () => undefined };
    const shared: KillSwitchRegistry = { scope: "shared", check: () => undefined };
    expect(bare.scope).toBeUndefined();
    expect(shared.scope).toBe("shared");
  });
});
