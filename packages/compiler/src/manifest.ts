import type { PluginState, StepEntry } from "./types";

export interface ManifestFlow {
  version: string;
  steps: string[];
  chunkMap: Record<string, string>;
  suspendPoints: string[];
  warnings: string[];
}

export interface LoomManifest {
  version: "1";
  flows: Record<string, ManifestFlow>;
}

export function buildManifest(state: PluginState, outDir = "."): LoomManifest {
  const flows: Record<string, ManifestFlow> = {};

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

    flows[flowId] = {
      version: flow.version,
      steps: flow.stepIds,
      chunkMap,
      suspendPoints: flow.suspendPoints,
      warnings,
    };
  }

  return { version: "1", flows };
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
