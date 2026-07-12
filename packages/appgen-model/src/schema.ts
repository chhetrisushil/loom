// The JSON Schema for a ChangeSpec — the ONLY structure the model may emit. It is fed
// to node-llama-cpp's JSON-schema grammar so decoding is *constrained*: the model
// physically cannot produce malformed or off-schema output (op values are enum-locked,
// required keys are enforced). This is what makes a small local model reliable at the
// task. `parse.ts` then does the semantic validation (ids resolve, etc.).
//
// Typed loosely as a plain object so this package builds without the optional
// node-llama-cpp types; GemmaProvider casts it to the grammar type at call time.

export function changeSpecJsonSchema(): Record<string, unknown> {
  const op = { enum: ["create", "extend", "modify"] };
  return {
    type: "object",
    properties: {
      name: { type: "string" },
      capabilities: {
        type: "array",
        // NOTE: no `minItems` here — node-llama-cpp's grammar sampler crashes (segfault)
        // on array minItems for this schema. An empty plan is instead rejected by
        // `tryParseChangeSpec` (the reasoning-ladder validator), which elevates or falls
        // back. `compute` is omitted from the generation schema — it's rarely intended and
        // only confuses small models; parse.ts still accepts it if a model emits one.
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            intent: { type: "string" },
            op,
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string" }, op },
                required: ["id", "op"],
              },
            },
            addApproval: { type: "boolean" },
            addUi: { type: "boolean" },
          },
          required: ["id", "name", "intent", "op", "steps"],
        },
      },
    },
    required: ["name", "capabilities"],
  };
}
