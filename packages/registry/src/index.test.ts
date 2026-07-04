import { describe, expect, it } from "vitest";
import { agent$ } from "@loom/core";
import { AgentRegistry } from "./index";

const supportAgent = agent$({ id: "support", name: "Support Agent", tools: [] });
const billingAgent = agent$({ id: "billing", name: "Billing Agent", tools: [] });

describe("AgentRegistry", () => {
  it("registers and retrieves an agent", () => {
    const reg = new AgentRegistry();
    reg.register(supportAgent);
    expect(reg.get("support")?.definition.name).toBe("Support Agent");
  });

  it("stores an optional agent card", () => {
    const reg = new AgentRegistry();
    reg.register(supportAgent, {
      name: "Support Agent",
      version: "1.0.0",
      capabilities: { streaming: true },
    });
    expect(reg.get("support")?.card?.capabilities?.streaming).toBe(true);
  });

  it("register() is fluent", () => {
    const reg = new AgentRegistry();
    expect(reg.register(supportAgent)).toBe(reg);
  });

  it("has() and ids() reflect registration", () => {
    const reg = new AgentRegistry();
    reg.register(supportAgent).register(billingAgent);
    expect(reg.has("billing")).toBe(true);
    expect(reg.ids().sort()).toEqual(["billing", "support"]);
  });

  it("all() returns every registered agent", () => {
    const reg = new AgentRegistry();
    reg.register(supportAgent).register(billingAgent);
    expect(reg.all()).toHaveLength(2);
  });
});
