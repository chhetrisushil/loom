import type { AppModel } from "./appModel";
import { parseIntent } from "./parseIntent";
import type { ComputeSpec, ReasoningSpec } from "./types";

// ── ChangeSpec: AppSpec extended with brownfield ops ─────────────────────────
//
// Stage 2's output. Where `AppSpec` describes an app to create from scratch, a
// `ChangeSpec` describes a DELTA against an existing `AppModel`: each capability and
// step is tagged create / extend / modify. This is the ONLY structure a model ever
// emits — it carries intent (add a step, add an approval gate), never file contents.
// The deterministic planner below wraps `parseIntent` and diffs against the scan; a
// model-backed planner (Stage 2, @loom/appgen-model) produces the same shape.

export type Op = "create" | "extend" | "modify";

export interface StepChange {
  id: string;
  /** `create` = a new step; `modify` = a step that already exists in the flow. */
  op: Op;
}

export interface CapabilityChange {
  id: string;
  name: string;
  intent: string;
  /** `create` = a new flow; `extend` = an existing flow gains steps/gates. */
  op: Op;
  steps: StepChange[];
  reasoning?: ReasoningSpec;
  /** Add a durable approval gate (only when not already present). */
  addApproval?: boolean;
  /** Add a durable UI surface (only when not already present). */
  addUi?: boolean;
  /** GrantTable entries to wire (reserved for a later phase). */
  wireGrants?: string[];
}

export interface ChangeSpec {
  name: string;
  capabilities: CapabilityChange[];
  compute?: ComputeSpec;
  /** Which planner produced this spec — recorded for the lockfile / provenance. */
  planner: "deterministic" | "model";
  /** Reasoning-ladder elevations taken while planning (mirrors DECISION_RECORDED). */
  elevations?: { from: string; to: string; reason: string }[];
}

/**
 * The deterministic, offline planner (Stage 2 fallback / `--offline`). Parses the
 * intent with the existing grammar parser, then diffs the resulting capabilities and
 * steps against the scanned {@link AppModel} to assign create / extend / modify ops.
 * Pure and reproducible — no model, mirrors what a model planner must emit.
 */
export function planChangesDeterministic(intent: string, appModel: AppModel): ChangeSpec {
  const spec = parseIntent(intent);
  const byId = new Map(appModel.flows.map((f) => [f.id, f]));

  const capabilities: CapabilityChange[] = spec.capabilities.map((cap) => {
    const existing = byId.get(cap.id);
    const existingSteps = new Set(existing?.steps.map((s) => s.id) ?? []);
    const steps: StepChange[] = cap.steps.map((id) => ({
      id,
      op: existingSteps.has(id) ? "modify" : "create",
    }));
    return {
      id: cap.id,
      name: cap.name,
      intent: cap.intent,
      op: existing === undefined ? "create" : "extend",
      steps,
      ...(cap.reasoning !== undefined && { reasoning: cap.reasoning }),
      // Only add a gate the flow doesn't already have — keeps re-runs idempotent.
      ...(cap.approval === true && { addApproval: existing?.hasApproval !== true }),
      ...(cap.ui === true && { addUi: existing?.hasUi !== true }),
    };
  });

  return {
    name: spec.name,
    capabilities,
    ...(spec.compute !== undefined && { compute: spec.compute }),
    planner: "deterministic",
  };
}
