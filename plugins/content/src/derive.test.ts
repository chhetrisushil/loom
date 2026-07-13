import { externalized } from "@loom/classify";
import { step$ } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ContentResolvingEventStore } from "./ContentResolvingEventStore";
import { InMemoryContentStore } from "./ContentStore";
import { externalizePathsFromSteps } from "./derive";

const reportStep = step$({
  id: "report",
  inputSchema: z.object({ q: z.string() }),
  outputSchema: z.object({ doc: externalized(z.object({ body: z.string() })), ok: z.boolean() }),
});
const plainStep = step$({
  id: "plain",
  inputSchema: z.object({}),
  outputSchema: z.object({ count: z.number() }),
});

describe("externalizePathsFromSteps (ADR 0046)", () => {
  it("derives STEP_COMPLETED output paths from externalized() marks, deduped", () => {
    expect(externalizePathsFromSteps([reportStep, plainStep])).toEqual({
      STEP_COMPLETED: ["output.doc"],
    });
    expect(externalizePathsFromSteps([reportStep, reportStep])).toEqual({
      STEP_COMPLETED: ["output.doc"],
    });
  });

  it("returns an empty map when nothing is marked (zero-overhead unwired, G2)", () => {
    expect(externalizePathsFromSteps([plainStep])).toEqual({});
  });

  it("feeds ContentResolvingEventStore end-to-end: mark once, externalization derived", async () => {
    const inner = new InMemoryAsyncEventStore();
    const content = new InMemoryContentStore();
    const store = new ContentResolvingEventStore(inner, content, {
      externalize: externalizePathsFromSteps([reportStep]),
    });
    await store.append({
      id: "e0",
      workflowId: "wf",
      executionId: "x1",
      eventType: "STEP_COMPLETED",
      sequence: 0,
      timestamp: 1,
      payload: { stepId: "report", output: { doc: { body: "PII text" }, ok: true } },
    });

    // Externalized: the raw log holds a ref, not the body.
    expect(JSON.stringify(await inner.read("x1"))).not.toContain("PII text");
    expect(content.size).toBe(1);
    // Resolved back through the wrapper.
    const [e] = await store.read("x1");
    expect((e?.payload as { output: { doc: unknown } }).output.doc).toEqual({ body: "PII text" });
  });
});
