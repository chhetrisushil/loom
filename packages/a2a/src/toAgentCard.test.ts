import { agent$, tool$ } from "@loom/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentCard } from "./types";
import { toAgentCard } from "./toAgentCard";

const MetricsTool = tool$({
  id: "db-metrics",
  name: "DB Metrics",
  description: "Reads live database metrics",
  kind: "tool",
  inputSchema: z.object({ target: z.string() }),
  outputSchema: z.object({ cpuPct: z.number() }),
});

// The agent$ definition carries the card metadata; the derived card must match
// what db-command-center previously hand-authored, byte-for-byte.
const DiagnosticsAgent = agent$({
  id: "diagnostics-agent",
  name: "Diagnostics Agent",
  description: "Root-causes performance incidents from live metrics and replica status",
  tools: [MetricsTool],
  version: "1.0.0",
  capabilities: { streaming: true },
  skills: [
    { id: "diagnose-cpu", name: "Diagnose CPU saturation" },
    { id: "diagnose-replica-lag", name: "Diagnose replica lag" },
  ],
});

describe("toAgentCard", () => {
  it("derives the exact hand-authored card from an enriched agent$", () => {
    const expected: AgentCard = {
      name: "Diagnostics Agent",
      description: "Root-causes performance incidents from live metrics and replica status",
      url: "loom+inproc://diagnostics-agent",
      version: "1.0.0",
      capabilities: { streaming: true },
      skills: [
        { id: "diagnose-cpu", name: "Diagnose CPU saturation" },
        { id: "diagnose-replica-lag", name: "Diagnose replica lag" },
      ],
    };
    expect(toAgentCard(DiagnosticsAgent)).toEqual(expected);
  });

  it("fills sane defaults when the agent omits card metadata", () => {
    const bare = agent$({ id: "bare-agent", name: "Bare", tools: [] });
    expect(toAgentCard(bare)).toEqual({
      name: "Bare",
      description: "",
      url: "loom+inproc://bare-agent",
      version: "1.0.0",
      capabilities: { streaming: false },
      skills: [],
    });
  });

  it("lets options override url/version/capabilities without touching the definition", () => {
    const bare = agent$({ id: "bare-agent", name: "Bare", tools: [] });
    const card = toAgentCard(bare, {
      url: "https://agents.example.com/bare",
      version: "2.3.0",
      capabilities: { streaming: true },
    });
    expect(card.url).toBe("https://agents.example.com/bare");
    expect(card.version).toBe("2.3.0");
    expect(card.capabilities).toEqual({ streaming: true });
  });

  it("prefers definition metadata over option fallbacks", () => {
    const card = toAgentCard(DiagnosticsAgent, { version: "9.9.9", capabilities: { streaming: false } });
    expect(card.version).toBe("1.0.0");
    expect(card.capabilities).toEqual({ streaming: true });
  });
});
