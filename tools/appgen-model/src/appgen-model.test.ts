import type { AppModel } from "@loom/appgen";
import type { LlmProvider } from "@loom/llm";
import type { ModelRoute } from "@loom/reasoning";
import { describe, expect, it } from "vitest";
import { GEMMA_TIERS, gemmaRoute } from "./gemmaModels";
import { extractJsonObject, tryParseChangeSpec } from "./parse";
import { planChangesModel } from "./planChangesModel";
import { buildSystem, summarizeAppModel } from "./prompt";
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

  const dupMsg = (flow: string, id: string) =>
    `flow "${flow}" declares step id "${id}" more than once — step ids must be unique within a flow; use each id once`;
  it("rejects a duplicate step id within one new flow", () => {
    const s = spec([
      {
        id: "router",
        name: "R",
        intent: "x",
        op: "create",
        steps: [
          { id: "classify", op: "create" },
          { id: "classify", op: "create" },
        ],
      },
    ]);
    expect(validateChangeSpec(s, NET_NEW)).toEqual([dupMsg("router", "classify")]);
  });
  it("rejects a duplicate step id within one extend of an existing flow", () => {
    const s = spec([
      {
        id: "planner",
        name: "P",
        intent: "x",
        op: "extend",
        steps: [
          { id: "summarize", op: "create" },
          { id: "summarize", op: "create" },
        ],
      },
    ]);
    expect(validateChangeSpec(s, EXISTING)).toEqual([dupMsg("planner", "summarize")]);
  });
  it("rejects a step added to an existing flow that the flow already has", () => {
    const s = spec([
      {
        id: "planner",
        name: "P",
        intent: "x",
        op: "extend",
        steps: [{ id: "score", op: "create" }],
      },
    ]);
    expect(validateChangeSpec(s, EXISTING)).toEqual([
      `step "score" already exists in "planner" — use op "modify"`,
    ]);
  });
  it("rejects the same step id across two operations on one flow", () => {
    const s = spec([
      { id: "planner", name: "P", intent: "x", op: "extend", steps: [{ id: "a", op: "create" }] },
      { id: "planner", name: "P", intent: "x", op: "extend", steps: [{ id: "a", op: "create" }] },
    ]);
    expect(validateChangeSpec(s, EXISTING)).toEqual([dupMsg("planner", "a")]);
  });
  const cap = (id: string, op: string, steps: unknown[]) => ({
    id,
    name: "N",
    intent: "x",
    op,
    steps,
  });
  const HINT = "start with a letter, no leading digit, no trailing or double dash";
  it("rejects two step ids that generate the same const name (new flow)", () => {
    const s = spec([
      cap("router", "create", [
        { id: "a-b", op: "create" },
        { id: "a--b", op: "create" },
      ]),
    ]);
    // `a--b` is also malformed under the strict rule; use `ab`/`a-b`-style pair below too.
    expect(validateChangeSpec(s, NET_NEW)).toEqual([
      `step id "a--b" in "router" must be kebab-case: ${HINT}`,
    ]);
    const t = spec([
      cap("router", "create", [
        { id: "a-b2", op: "create" },
        { id: "a-b-2", op: "create" },
      ]),
    ]);
    expect(validateChangeSpec(t, NET_NEW)).toEqual([
      `step ids "a-b2" and "a-b-2" in flow "router" both generate the name "aB2Step" — rename one`,
    ]);
  });
  it("a new step checked against an existing flow: malformed id, exact duplicate, and a generated-name collision with a legacy id", () => {
    const model: AppModel = {
      ...EXISTING,
      flows: [{ ...EXISTING.flows[0]!, steps: [{ id: "a-b", handlerState: "stub" }] }],
    };
    const s = spec([cap("planner", "extend", [{ id: "ab-", op: "create" }])]);
    expect(validateChangeSpec(s, model)).toEqual([
      `step id "ab-" in "planner" must be kebab-case: ${HINT}`,
    ]);
    const t = spec([cap("planner", "extend", [{ id: "a-b", op: "create" }])]);
    expect(validateChangeSpec(t, model)).toEqual([
      `step "a-b" already exists in "planner" — use op "modify"`,
    ]);
    const legacy: AppModel = {
      ...EXISTING,
      flows: [{ ...EXISTING.flows[0]!, steps: [{ id: "a_b", handlerState: "stub" }] }],
    };
    const u = spec([cap("planner", "extend", [{ id: "a-b", op: "create" }])]);
    expect(validateChangeSpec(u, legacy)).toEqual([
      `step ids "a_b" and "a-b" in flow "planner" both generate the name "aBStep" — rename one`,
    ]);
  });
  it("rejects a new step id with a leading digit or a trailing/double dash", () => {
    for (const id of ["1-run", "run-", "a--b", "-a", "A"]) {
      const s = spec([cap("router", "create", [{ id, op: "create" }])]);
      expect(validateChangeSpec(s, NET_NEW)).toEqual([
        `step id "${id}" in "router" must be kebab-case: ${HINT}`,
      ]);
    }
    const ok = spec([cap("router", "create", [{ id: "run-2-go", op: "create" }])]);
    expect(validateChangeSpec(ok, NET_NEW)).toEqual([]);
  });
  it("applies the strict rule to a NEW flow id only; an existing flow keeps the loose rule", () => {
    expect(validateChangeSpec(spec([cap("1-router", "create", [])]), NET_NEW)).toEqual([
      `capability id "1-router" must be kebab-case: ${HINT}`,
    ]);
    const legacy: AppModel = {
      ...EXISTING,
      flows: [{ ...EXISTING.flows[0]!, id: "2-legacy--flow", steps: [] }],
    };
    expect(validateChangeSpec(spec([cap("2-legacy--flow", "extend", [])]), legacy)).toEqual([]);
  });
  it("rejects two creates of the same new flow in one spec", () => {
    const s = spec([
      cap("router", "create", [{ id: "a", op: "create" }]),
      cap("router", "create", [{ id: "b", op: "create" }]),
    ]);
    expect(validateChangeSpec(s, NET_NEW)).toEqual([
      `flow "router" is created more than once — declare each new flow once, with all its steps`,
    ]);
  });
  it("rejects a modify/delete step op inside a newly created flow", () => {
    const s = spec([
      cap("router", "create", [
        { id: "a", op: "modify" },
        { id: "b", op: "delete" },
        { id: "c", op: "create" },
      ]),
    ]);
    expect(validateChangeSpec(s, NET_NEW)).toEqual([
      `step "a" op "modify" but flow "router" is being created — there is nothing to modify`,
      `step "b" op "delete" but flow "router" is being created — there is nothing to delete`,
    ]);
  });
  it("allows the same step id in two different flows (scoped per flow)", () => {
    const s = spec([
      { id: "one", name: "O", intent: "x", op: "create", steps: [{ id: "run", op: "create" }] },
      { id: "two", name: "T", intent: "x", op: "create", steps: [{ id: "run", op: "create" }] },
    ]);
    expect(validateChangeSpec(s, NET_NEW)).toEqual([]);
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

describe("model-planned deletes", () => {
  const DELETE_FLOW = JSON.stringify({
    name: "planner",
    capabilities: [
      { id: "planner", name: "Planner", intent: "remove it", op: "delete", steps: [] },
    ],
  });
  const DELETE_STEP = JSON.stringify({
    name: "planner",
    capabilities: [
      {
        id: "planner",
        name: "Planner",
        intent: "drop run",
        op: "extend",
        steps: [{ id: "run", op: "delete" }],
      },
    ],
  });
  const DELETE_GHOST = JSON.stringify({
    name: "ghost",
    capabilities: [{ id: "ghost", name: "Ghost", intent: "x", op: "delete", steps: [] }],
  });

  it("the grammar schema and the prompt offer delete for flows and steps", () => {
    expect(JSON.stringify(changeSpecJsonSchema())).toContain('"delete"');
    expect(buildSystem(EXISTING)).toContain('"delete"');
  });

  it("parses delete ops for a flow and a step (not coerced to create)", () => {
    expect(tryParseChangeSpec(DELETE_FLOW)?.capabilities[0]?.op).toBe("delete");
    expect(tryParseChangeSpec(DELETE_STEP)?.capabilities[0]?.steps).toEqual([
      { id: "run", op: "delete" },
    ]);
  });

  it("plans a model delete end to end (flow and step), validated against the app", async () => {
    for (const json of [DELETE_FLOW, DELETE_STEP]) {
      const spec = await planChangesModel("remove it", EXISTING, {
        routes: [route("gemma-e4b", 0, json)],
      });
      expect(spec.planner).toBe("model");
    }
  });

  it("rejects delete of a missing flow with a one-line repair message, then repairs", async () => {
    const issues = validateChangeSpec(tryParseChangeSpec(DELETE_GHOST)!, EXISTING);
    expect(issues).toEqual(['op "delete" targets flow "ghost", but no such flow exists']);
    const spec = await planChangesModel("remove ghost", EXISTING, {
      routes: [sequenceRoute("gemma-e4b", DELETE_GHOST, DELETE_FLOW)],
    });
    expect(spec.planner).toBe("model");
    expect(spec.capabilities[0]?.id).toBe("planner");
  });

  it("rejects delete of a missing step", () => {
    const s = tryParseChangeSpec(DELETE_STEP.replace('"run"', '"nope"'))!;
    expect(validateChangeSpec(s, EXISTING)).toEqual([
      'step "nope" op "delete" but flow "planner" has no such step',
    ]);
  });
});
