import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineConfig } from "./defineConfig";

// ADR 0147: the option reaches the runtime, and `onEvent` keeps its place ahead of it.
describe("observability.onDurableEvent", () => {
  it("fires for each event, after onEvent has reported it", async () => {
    const order: string[] = [];
    const app = defineConfig({
      storage: { kind: "memory" },
      observability: {
        onEvent: (e) => order.push(`live:${e.sequence}`),
        onDurableEvent: (e) => order.push(`durable:${e.sequence}`),
      },
      flows: [
        {
          definition: {
            _tag: "FlowDefinition",
            id: "durable-flow",
            name: "durable-flow",
            version: "1.0.0",
            inputSchema: z.object({}),
            outputSchema: z.object({}),
            steps: [],
          },
          runner: async () => ({}),
        },
      ],
    });
    const handle = await app.runtime.start("durable-flow", {}, { executionId: "x" });
    await handle.waitForCompletion();
    const events = await app.stores.eventStore.read("x");
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const live = order.indexOf(`live:${event.sequence}`);
      const durable = order.indexOf(`durable:${event.sequence}`);
      expect(live).toBeGreaterThanOrEqual(0);
      expect(durable).toBeGreaterThan(live);
    }
  });
});
