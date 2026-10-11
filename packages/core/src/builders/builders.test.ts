import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agent$, flow$, memory$, policy$, projection$, step$, tool$ } from "./index";
import {
  isProjectionHandlersRef,
  loadProjectionHandlers,
  projectionEventTypes,
} from "./projection";

const inputSchema = z.object({ id: z.string() });
const outputSchema = z.object({ result: z.string() });

describe("step$", () => {
  it("returns a StepDefinition with correct _tag", () => {
    const def = step$({ id: "my-step", name: "My Step", inputSchema, outputSchema });
    expect(def._tag).toBe("StepDefinition");
    expect(def.id).toBe("my-step");
    expect(def.name).toBe("My Step");
    expect(def.inputSchema).toBe(inputSchema);
    expect(def.outputSchema).toBe(outputSchema);
  });

  it("attaches retry policy when provided", () => {
    const def = step$({
      id: "retryable",
      name: "Retryable",
      inputSchema,
      outputSchema,
      retry: { maxAttempts: 3, backoffMs: 500 },
    });
    expect(def.retry?.maxAttempts).toBe(3);
  });
});

describe("tool$", () => {
  it("returns a ToolDefinition with correct _tag", () => {
    const def = tool$({
      id: "fetch-metrics",
      name: "Fetch Metrics",
      description: "Fetches metrics",
      inputSchema,
      outputSchema,
    });
    expect(def._tag).toBe("ToolDefinition");
    expect(def.kind).toBe("tool");
  });

  it("accepts custom kind", () => {
    const def = tool$({
      id: "llm-tool",
      name: "LLM",
      description: "LLM tool",
      kind: "llm",
      inputSchema,
      outputSchema,
    });
    expect(def.kind).toBe("llm");
  });

  // ADR 0073 — the declaration half of the determinism-boundary check. The
  // enforced copy lives on the registered effect (`ToolEffect`), the same split
  // as `idempotent`/`errors`.
  it("carries a declared effect mode", () => {
    const def = tool$({
      id: "page",
      name: "Page",
      description: "paginate a table",
      inputSchema,
      outputSchema,
      mode: "ambient",
    });
    expect(def.mode).toBe("ambient");
  });

  it("omits mode when undeclared, so nothing defaults into a boundary", () => {
    const def = tool$({
      id: "plain",
      name: "Plain",
      description: "no mode",
      inputSchema,
      outputSchema,
    });
    expect(def.mode).toBeUndefined();
    expect("mode" in def).toBe(false);
  });
});

describe("flow$", () => {
  it("returns a FlowDefinition with correct _tag and metadata", () => {
    const stepDef = step$({ id: "s1", name: "S1", inputSchema, outputSchema });
    const def = flow$({
      id: "my-flow",
      name: "My Flow",
      version: "1.0.0",
      inputSchema,
      outputSchema,
      steps: [stepDef],
    });
    expect(def._tag).toBe("FlowDefinition");
    expect(def.id).toBe("my-flow");
    expect(def.version).toBe("1.0.0");
    expect(def.steps).toHaveLength(1);
  });
});

describe("agent$", () => {
  it("returns an AgentDefinition with correct _tag", () => {
    const toolDef = tool$({ id: "t1", name: "T1", description: "T1", inputSchema, outputSchema });
    const def = agent$({ id: "my-agent", name: "My Agent", tools: [toolDef] });
    expect(def._tag).toBe("AgentDefinition");
    expect(def.tools).toHaveLength(1);
  });
});

describe("projection$", () => {
  it("returns a ProjectionDefinition with initialState and handlers", async () => {
    const def = projection$({
      id: "metrics-projection",
      name: "Metrics",
      initialState: { count: 0 },
      handlers: {
        STEP_COMPLETED: (state) => ({ count: state.count + 1 }),
      },
    });
    expect(def._tag).toBe("ProjectionDefinition");
    expect(def.initialState).toEqual({ count: 0 });
    expect(isProjectionHandlersRef(def.handlers)).toBe(false);
    expect(projectionEventTypes(def.handlers)).toEqual(["STEP_COMPLETED"]);
    expect(typeof (await loadProjectionHandlers(def.handlers)).STEP_COMPLETED).toBe("function");
  });
});

describe("memory$", () => {
  it("returns a MemoryDefinition with correct _tag", () => {
    const def = memory$({ id: "ctx-memory", name: "Context Memory", ttlMs: 60000 });
    expect(def._tag).toBe("MemoryDefinition");
    expect(def.ttlMs).toBe(60000);
  });
});

describe("policy$", () => {
  it("returns a PolicyDefinition with correct _tag", () => {
    const def = policy$({ id: "rate-limit", name: "Rate Limit", rules: { rps: 10 } });
    expect(def._tag).toBe("PolicyDefinition");
    expect(def.rules).toEqual({ rps: 10 });
  });
});

describe("timeoutMs / deadlineMs validation", () => {
  const bad = [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const v of bad) {
    it(`step$ rejects timeoutMs = ${v}`, () => {
      expect(() => step$({ id: "s", name: "s", inputSchema, outputSchema, timeoutMs: v })).toThrow(
        /timeoutMs must be a finite number > 0/
      );
    });
    it(`flow$ rejects deadlineMs = ${v}`, () => {
      expect(() =>
        flow$({
          id: "f",
          name: "f",
          version: "1.0.0",
          inputSchema,
          outputSchema,
          steps: [],
          deadlineMs: v,
        })
      ).toThrow(/deadlineMs must be a finite number > 0/);
    });
  }
  it("accepts a positive finite budget and an omitted one", () => {
    expect(step$({ id: "s", name: "s", inputSchema, outputSchema, timeoutMs: 1 }).timeoutMs).toBe(
      1
    );
    expect(step$({ id: "s", name: "s", inputSchema, outputSchema }).timeoutMs).toBeUndefined();
  });
});
