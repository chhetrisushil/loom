import * as path from "node:path";
import type { PluginState, StepEntry } from "./types";

export interface ManifestFlow {
  version: string;
  steps: string[];
  chunkMap: Record<string, string>;
  suspendPoints: string[];
  warnings: string[];
  /**
   * The source module that declared this flow (relative to the project root).
   * Enables tooling and `@loom/app`'s manifest cross-check to know where a flow
   * lives. Registration itself stays a static import (see `registerFlowsFrom`) —
   * this is metadata, never a dynamic-import target, so wiring stays
   * deterministic/replay-safe.
   */
  module: string;
}

// A skill's lazy-loaded instruction body — the progressive-disclosure analog of
// a flow's per-step chunkMap. `chunk` is empty when the skill was authored with
// inline instructions (no instructions$ marker for the compiler to extract).
export interface ManifestSkill {
  chunk: string;
}

export interface LoomManifest {
  version: "1";
  flows: Record<string, ManifestFlow>;
  skills: Record<string, ManifestSkill>;
  /** Deduplicated, sorted list of source modules that declare flows. */
  flowModules: string[];
}

function relModule(sourceFile: string, root: string): string {
  if (!sourceFile) return sourceFile;
  const rel = path.isAbsolute(sourceFile) ? path.relative(root, sourceFile) : sourceFile;
  return rel.split(path.sep).join("/");
}

export function buildManifest(
  state: PluginState,
  outDir = ".",
  root: string = process.cwd()
): LoomManifest {
  const flows: Record<string, ManifestFlow> = {};
  const skills: Record<string, ManifestSkill> = {};
  const flowModuleSet = new Set<string>();

  for (const [flowId, flow] of state.flows) {
    const chunkMap: Record<string, string> = {};
    const warnings: string[] = [];

    for (const stepId of flow.stepIds) {
      const step: StepEntry | undefined = state.steps.get(stepId);
      if (!step) {
        warnings.push(
          `Step "${stepId}" is referenced in flow "${flowId}" but not found in analysis.`
        );
        continue;
      }
      if (step.chunkVirtualId !== undefined) {
        const fileName = `chunks/${stepId}_${step.hash}.js`;
        chunkMap[stepId] = `${outDir}/${fileName}`;
      } else if (!step.toolId) {
        warnings.push(
          `Step "${stepId}" in flow "${flowId}" has neither a handler$ nor a toolId — it must be registered manually.`
        );
      }
    }

    const module = relModule(flow.sourceFile, root);
    if (module) flowModuleSet.add(module);

    flows[flowId] = {
      version: flow.version,
      steps: flow.stepIds,
      chunkMap,
      suspendPoints: flow.suspendPoints,
      warnings,
      module,
    };
  }

  for (const [skillId, skill] of state.skills) {
    skills[skillId] = {
      chunk: skill.chunkVirtualId ? `${outDir}/chunks/${skillId}_${skill.hash}.js` : "",
    };
  }

  return { version: "1", flows, skills, flowModules: [...flowModuleSet].sort() };
}

export function printWarnings(manifest: LoomManifest): void {
  for (const [flowId, flow] of Object.entries(manifest.flows)) {
    for (const warning of flow.warnings) {
      console.warn(`[loom-compiler] ⚠  ${warning}`);
    }
    if (flow.warnings.length === 0) {
      console.info(
        `[loom-compiler] ✓  flow "${flowId}" — ${flow.steps.length} step(s), ${Object.keys(flow.chunkMap).length} lazy chunk(s)`
      );
    }
  }
}
