import { newIdSlug as slug } from "./slug";
import type { AppSpec, CapabilitySpec } from "./types";

/**
 * Deterministic, offline directive parser (P11 DX). Understands a small, documented
 * grammar of sentences and produces an {@link AppSpec}. This is the ONLY step that
 * interprets NL, and it does so without a model, so it is reproducible; a
 * model-backed parser can be swapped in later, but it must still emit an AppSpec —
 * codegen never sees raw NL.
 *
 * Grammar (case-insensitive, sentence-delimited by `.`/newline):
 *   - "create a <name>" / "create <name> capability"  → a new capability
 *   - "use <model> first"                             → reasoning.baseModel
 *   - "elevate to <model>"                            → reasoning.elevateTo (repeatable)
 *   - "(pause|wait) for approval"                     → approval gate
 *   - "generate ui" / "with ui"                       → ui surface
 *   - "(add )?step <name>"                            → an explicit step
 *   - "deploy on <target>"                            → app-level compute target
 * Directives attach to the most recently created capability; if none was created,
 * a single "app" capability is assumed.
 */
export function parseIntent(nl: string): AppSpec {
  const sentences = nl
    .split(/[.\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const capabilities: CapabilitySpec[] = [];
  let current: CapabilitySpec | undefined;
  const compute: { target?: string } = {};

  const ensureCurrent = (): CapabilitySpec => {
    if (current === undefined) {
      current = { id: "app", name: "App", intent: nl.trim(), steps: [] };
      capabilities.push(current);
    }
    return current;
  };

  for (const sentence of sentences) {
    const s = sentence.toLowerCase();

    const create = s.match(/create\s+(?:a|an)?\s*([a-z0-9][a-z0-9\s-]*?)(?:\s+capability)?$/);
    if (create?.[1] !== undefined) {
      const id = slug(create[1]);
      current = {
        id,
        name: id.replace(/(^|-)([a-z])/g, (_m, _p, c: string) => c.toUpperCase()),
        intent: sentence,
        steps: [],
      };
      capabilities.push(current);
      continue;
    }

    const useFirst = s.match(/use\s+([a-z0-9.-]+)\s+first/);
    if (useFirst?.[1] !== undefined) {
      const cap = ensureCurrent();
      cap.reasoning = { ...cap.reasoning, baseModel: useFirst[1] };
      continue;
    }

    const elevate = s.match(/elevate\s+to\s+([a-z0-9.-]+)/);
    if (elevate?.[1] !== undefined) {
      const cap = ensureCurrent();
      const elevateTo = cap.reasoning?.elevateTo ?? [];
      elevateTo.push(elevate[1]);
      cap.reasoning = { ...cap.reasoning, elevateTo };
      continue;
    }

    if (/(pause|wait)\s+for\s+approval/.test(s)) {
      ensureCurrent().approval = true;
      continue;
    }

    if (/generate\s+ui|with\s+ui/.test(s)) {
      ensureCurrent().ui = true;
      continue;
    }

    const step = s.match(/(?:add\s+)?step\s+([a-z0-9][a-z0-9\s-]*)/);
    if (step?.[1] !== undefined) {
      ensureCurrent().steps.push(slug(step[1]));
      continue;
    }

    const deploy = s.match(/deploy\s+on\s+([a-z0-9-]+)/);
    if (deploy?.[1] !== undefined) {
      compute.target = deploy[1];
    }
  }

  // Every capability needs at least one step; default to "run".
  for (const cap of capabilities) {
    if (cap.steps.length === 0) cap.steps.push("run");
  }
  if (capabilities.length === 0) {
    capabilities.push({ id: "app", name: "App", intent: nl.trim(), steps: ["run"] });
  }

  const appName = capabilities[0]?.id ?? "app";
  return {
    name: appName,
    capabilities,
    ...(compute.target !== undefined && { compute: { target: compute.target } }),
  };
}
