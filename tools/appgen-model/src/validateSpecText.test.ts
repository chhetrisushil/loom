import type { AppModel, ChangeSpec } from "@loom/appgen";
import { describe, expect, it } from "vitest";
import { validateChangeSpec } from "./validateSpec";

const NET_NEW: AppModel = { root: "/x", isExisting: false, flows: [] };

function plan(over: Record<string, unknown>): ChangeSpec {
  return {
    name: "planner",
    capabilities: [
      {
        id: "newflow",
        name: "Newflow",
        intent: "ok",
        op: "create",
        steps: [{ id: "run", op: "create" }],
        ...over,
      },
    ],
    planner: "model",
  } as unknown as ChangeSpec;
}

describe("validateChangeSpec: free-text fields", () => {
  it.each([
    ["LF", "a\nglobalThis.pwned = 1"],
    ["CRLF", "a\r\nb"],
    ["U+2028", "a\u2028b"],
    ["U+2029", "a\u2029b"],
    ["NUL", "a\u0000b"],
    ["DEL", "a\u007fb"],
    ["bidi override", "a\u202eb"],
  ])("rejects a %s in intent with a repair message", (_n, intent) => {
    expect(validateChangeSpec(plan({ intent }), NET_NEW)).toEqual([
      'intent of "newflow" contains a control or line-break character - write it as one plain line of text',
    ]);
  });

  it("rejects control characters in the name, plan name, compute target and models", () => {
    expect(validateChangeSpec(plan({ name: "a\nb" }), NET_NEW)).toHaveLength(1);
    const withReasoning = plan({ reasoning: { baseModel: "m\n", elevateTo: ["x\u2028"] } });
    expect(validateChangeSpec(withReasoning, NET_NEW)).toHaveLength(2);
    const spec = plan({});
    spec.name = "n\nm";
    spec.compute = { target: "t\r" };
    expect(validateChangeSpec(spec, NET_NEW)).toHaveLength(2);
  });

  it("rejects an unreasonably long intent", () => {
    expect(validateChangeSpec(plan({ intent: "x".repeat(501) }), NET_NEW)).toEqual([
      'intent of "newflow" is too long (501 > 500 characters)',
    ]);
  });

  it("does NOT refuse ordinary punctuation - that is escaped at the sink", () => {
    const intent = `it's a "quoted" \`tick\` \${x} back\\slash </script> */ done`;
    expect(validateChangeSpec(plan({ intent }), NET_NEW)).toEqual([]);
  });
});
