import { pascal } from "@loom/scaffold";
import { stubHandlerBody } from "./stub";

// The source text of a generated `step$` const — the single source of truth shared by
// `generate.ts` (greenfield emit) and `astEdit.ts` (brownfield insert). Keeping the
// template here means a new step inserted into an existing flow is byte-for-byte the
// same shape appgen would have generated from scratch.

export function camel(id: string): string {
  const p = pascal(id);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

/** The const identifier appgen uses for a step, e.g. `run` → `runStep`. */
export function stepConstName(id: string): string {
  return `${camel(id)}Step`;
}

/** The full `const <id>Step = step$({ ... })` declaration for a fresh step. */
export function stepConstSource(id: string): string {
  return `const ${stepConstName(id)} = step$({
  id: "${id}",
  name: "${pascal(id)}",
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ result: z.string() }),
  handler: handler$(${stubHandlerBody(id)}),
});`;
}
