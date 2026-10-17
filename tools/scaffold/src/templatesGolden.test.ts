import { describe, expect, it } from "vitest";
import { FLOW_TEMPLATES, templateNotes } from "./flowTemplates";
import { newFiles } from "./templates";

// Golden output of every `loom new` construct kind x flow template for a few VALID names.
// Escaping at the sinks (tsStringLiteral / commentText / templateLiteralText) must leave this
// byte-identical: the snapshot was recorded from the templates BEFORE the sinks were escaped.
const KINDS = [
  "flow",
  "agent",
  "tool",
  "skill",
  "schedule",
  "memory",
  "projection",
  "sentinel",
] as const;
const NAMES = ["greet", "order-intake", "a1", "x-2-y"];

describe("template output for valid names is stable", () => {
  it("matches the recorded golden", async () => {
    const out: Record<string, unknown> = {};
    for (const name of NAMES) {
      for (const kind of KINDS) {
        const templates = kind === "flow" ? FLOW_TEMPLATES : ["echo"];
        for (const t of templates) {
          out[`${kind}/${t}/${name}`] = newFiles(kind, name, t as Parameters<typeof newFiles>[2]);
        }
      }
      for (const t of FLOW_TEMPLATES) out[`notes/${t}/${name}`] = templateNotes(t, name);
    }
    await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
      "./__golden__/templates.golden.json"
    );
  });
});
