import type { AppModel } from "@loom/appgen";
import type { LlmProvider } from "@loom/llm";
import type { ModelRoute } from "@loom/reasoning";
import { describe, expect, it } from "vitest";
import { GEMMA_TIERS, gemmaRoute } from "./gemmaModels";
import { extractJsonObject, tryParseChangeSpec } from "./parse";
import { planChangesModel } from "./planChangesModel";
import { summarizeAppModel } from "./prompt";
import { changeSpecJsonSchema } from "./schema";
import { validateChangeSpec } from "./validateSpec";

const NET_NEW: AppModel = { root: "/x", isExisting: false, flows: [] };
const EXISTING: AppModel = {
  root: "/x",
  isExisting: true,
  flows: [
    {
      id: "planner",
      file: "app/flows/planner/flow.ts",
      steps: [
        { id: "run", handlerState: "stub" },
        { id: "score", handlerState: "edited" },
      ],
      hasApproval: false,
      hasUi: true,
      isGenerated: true,
    },
  ],
};

const VALID_JSON = JSON.stringify({
  name: "planner",
  capabilities: [
    {
      id: "planner",
      name: "Planner",
      intent: "add summarize",
      op: "extend",
      steps: [{ id: "summarize", op: "create" }],
    },
  ],
});

/** A canned LlmProvider that always returns the same content. */
function fakeProvider(content: string): LlmProvider {
  return { complete: async () => ({ content, stopReason: "end_turn" as const }) };
}
function route(id: string, tier: number, content: string): ModelRoute {
  return { id, tier, tags: ["planning"], provider: fakeProvider(content) };
}
/** A provider that returns each content in turn across successive complete() calls. */
function sequenceRoute(id: string, ...contents: string[]): ModelRoute {
  let i = 0;
  return {
    id,
    tier: 0,
    tags: ["planning"],
    provider: {
      complete: async () => ({
        content: contents[Math.min(i++, contents.length - 1)]!,
        stopReason: "end_turn" as const,
      }),
    },
  };
}

// Parseable but semantically wrong: op "extend" on a flow that doesn't exist.
const INVALID_JSON = JSON.stringify({
  name: "ghost",
  capabilities: [{ id: "ghost", name: "Ghost", intent: "x", op: "extend", steps: [] }],
});

describe("summarizeAppModel", () => {
  it("says net-new for an empty model", () => {
    expect(summarizeAppModel(NET_NEW)).toMatch(/net-new/);
  });
  it("summarizes flows with step handler states and gates, never file contents", () => {
    const s = summarizeAppModel(EXISTING);
    expect(s).toContain('flow "planner"');
    expect(s).toContain("run[stub]");
    expect(s).toContain("score[edited]");
    expect(s).toContain("ui");
    expect(s).not.toContain("flow.ts"); // summary, not raw files
  });
});

describe("extractJsonObject / tryParseChangeSpec", () => {
  it("extracts a JSON object from fenced/prose text", () => {
    const wrapped = `Sure!\n\`\`\`json\n${VALID_JSON}\n\`\`\`\nDone.`;
    expect(extractJsonObject(wrapped)).toBe(VALID_JSON);
  });
  it("parses a valid ChangeSpec and stamps planner=model", () => {
    const spec = tryParseChangeSpec(VALID_JSON);
    expect(spec?.planner).toBe("model");
    expect(spec?.capabilities[0]?.op).toBe("extend");
    expect(spec?.capabilities[0]?.steps).toEqual([{ id: "summarize", op: "create" }]);
  });
  it("rejects non-JSON and capability-less objects", () => {
    expect(tryParseChangeSpec("no json here")).toBeUndefined();
    expect(tryParseChangeSpec('{"name":"x","capabilities":[]}')).toBeUndefined();
  });
});

describe("planChangesModel (reasoning ladder)", () => {
  it("returns a validated model ChangeSpec when the first tier succeeds", async () => {
    const spec = await planChangesModel("add summarize to planner", EXISTING, {
      routes: [route("gemma-e4b", 0, VALID_JSON)],
    });
    expect(spec.planner).toBe("model");
    expect(spec.capabilities[0]?.id).toBe("planner");
    expect(spec.elevations).toBeUndefined();
  });

  it("elevates to a stronger tier when the cheap tier emits junk, and logs it", async () => {
    const spec = await planChangesModel("add summarize to planner", EXISTING, {
      routes: [route("gemma-e4b", 0, "not json"), route("gemma-12b", 1, VALID_JSON)],
    });
    expect(spec.planner).toBe("model");
    expect(spec.elevations?.length).toBe(1);
    expect(spec.elevations?.[0]).toMatchObject({ from: "gemma-e4b", to: "gemma-12b" });
  });

  it("falls back to the deterministic parser when every tier fails", async () => {
    const spec = await planChangesModel("Create a greeter.", NET_NEW, {
      routes: [route("gemma-e4b", 0, "junk"), route("gemma-12b", 1, "still junk")],
    });
    expect(spec.planner).toBe("deterministic");
    expect(spec.capabilities[0]?.id).toBe("greeter");
    expect(spec.capabilities[0]?.op).toBe("create");
  });
});

describe("gemmaRoute / schema", () => {
  it("builds a route at the tier's ladder position with the planning tag", () => {
    const r = gemmaRoute("/models/gemma-e4b.gguf", "e4b");
    expect(r.id).toBe(GEMMA_TIERS.e4b!.id);
    expect(r.tier).toBe(0);
    expect(r.tags).toContain("planning");
  });
  it("produces a JSON schema that locks op to an enum", () => {
    const schema = changeSpecJsonSchema();
    expect(JSON.stringify(schema)).toContain('"create"');
    expect(JSON.stringify(schema)).toContain('"extend"');
  });
});

describe("validateChangeSpec", () => {
  const spec = (caps: unknown[]) =>
    ({ name: "x", capabilities: caps, planner: "model" }) as Parameters<
      typeof validateChangeSpec
    >[0];

  it("passes a spec that matches the app", () => {
    const s = spec([
      {
        id: "planner",
        name: "P",
        intent: "x",
        op: "extend",
        steps: [{ id: "summarize", op: "create" }],
      },
    ]);
    expect(validateChangeSpec(s, EXISTING)).toEqual([]);
  });
  it("flags create on an existing flow, and extend on a missing one", () => {
    expect(
      validateChangeSpec(
        spec([{ id: "planner", name: "P", intent: "x", op: "create", steps: [] }]),
        EXISTING
      ).join()
    ).toMatch(/already exists/);
    expect(
      validateChangeSpec(
        spec([{ id: "ghost", name: "G", intent: "x", op: "extend", steps: [] }]),
        EXISTING
      ).join()
    ).toMatch(/no such flow/);
  });
  it("flags modify/delete of a step that doesn't exist", () => {
    const s = spec([
      {
        id: "planner",
        name: "P",
        intent: "x",
        op: "extend",
        steps: [{ id: "nope", op: "delete" }],
      },
    ]);
    expect(validateChangeSpec(s, EXISTING).join()).toMatch(/no such step/);
  });
});

describe("self-repair loop", () => {
  it("re-prompts the model with the validation issues, then accepts the fixed plan", async () => {
    const spec = await planChangesModel("add summarize to planner", EXISTING, {
      routes: [sequenceRoute("gemma-e4b", INVALID_JSON, VALID_JSON)], // 1st invalid, 2nd valid
      maxRepairs: 1,
    });
    expect(spec.planner).toBe("model");
    expect(spec.capabilities[0]?.id).toBe("planner");
  });

  it("falls back to deterministic when repairs are exhausted", async () => {
    const spec = await planChangesModel("Create a greeter.", NET_NEW, {
      routes: [route("gemma-e4b", 0, INVALID_JSON)], // parseable but always invalid
      maxRepairs: 1,
    });
    expect(spec.planner).toBe("deterministic");
  });
});
