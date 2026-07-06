import type {
  InstructionsLoader,
  InstructionsRef,
  InstructionsSpec,
  SkillDefinition,
  ToolDefinition,
} from "../types/definitions";

export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  instructions: InstructionsSpec;
  tools?: ToolDefinition[];
}

// Declares a Skill: a progressively-disclosed bundle of authored instructions
// (and an optional tool subset) an agent loads on demand. Mirrors agent$'s
// conditional-spread style for the optional fields.
export function skill$(config: SkillConfig): SkillDefinition {
  return {
    _tag: "SkillDefinition",
    id: config.id,
    name: config.name,
    description: config.description,
    instructions: config.instructions,
    ...(config.tags !== undefined && { tags: config.tags }),
    ...(config.tools !== undefined && { tools: config.tools }),
  };
}

// Marks a skill's instruction body for the compiler, analogous to handler$ for
// step handlers. Uncompiled, it carries the text inline; the @loom/compiler
// plugin rewrites the call to a dynamic import so the body lands in its own
// lazy chunk. Both forms are resolved by loadInstructions().
export function instructions$(text: string): InstructionsRef {
  return { _loomInstructionsRef: true, text };
}

function isInstructionsRef(spec: InstructionsSpec): spec is InstructionsRef {
  return (spec as InstructionsRef)._loomInstructionsRef === true;
}

// Resolves either form of an InstructionsSpec to its text — the inline ref
// (dev / no plugin) or the compiler-emitted loader (`() => import(chunk)`).
// Mirrors LazyEffect's handler resolution.
export async function loadInstructions(spec: InstructionsSpec): Promise<string> {
  if (isInstructionsRef(spec)) {
    return spec.text;
  }
  const mod = await (spec as InstructionsLoader)();
  return mod.default;
}
