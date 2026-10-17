import { pascal } from "@loom/scaffold";
import type { AppModel } from "./appModel";
import { type IdResolver, parseIntent } from "./parseIntent";
import { newIdSlug, existingIdSlug as slug } from "./slug";
import type { CapabilitySpec, ComputeSpec, ReasoningSpec } from "./types";

// ── ChangeSpec: AppSpec extended with brownfield ops ─────────────────────────
//
// Stage 2's output. Where `AppSpec` describes an app to create from scratch, a
// `ChangeSpec` describes a DELTA against an existing `AppModel`: each capability and
// step is tagged create / extend / modify. This is the ONLY structure a model ever
// emits — it carries intent (add a step, add an approval gate), never file contents.
// The deterministic planner below wraps `parseIntent` and diffs against the scan; a
// model-backed planner (Stage 2, @loom/appgen-model) produces the same shape.

export type Op = "create" | "extend" | "modify" | "delete";

export interface StepChange {
  id: string;
  /** `create` = a new step; `modify` = an existing step; `delete` = remove the step. */
  op: Op;
}

export interface CapabilityChange {
  id: string;
  name: string;
  intent: string;
  /** `create` = a new flow; `extend` = add to an existing flow; `delete` = remove the flow. */
  op: Op;
  steps: StepChange[];
  reasoning?: ReasoningSpec;
  /** Add a durable approval gate (only when not already present). */
  addApproval?: boolean;
  /** Add a durable UI surface (only when not already present). */
  addUi?: boolean;
  /** Tool ids to grant this capability (wired into `app/config.ts` as a GrantTable). */
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
 * steps against the scanned {@link AppModel} to assign create / extend / modify / delete
 * ops. Pure and reproducible — no model, mirrors what a model planner must emit.
 *
 * Beyond the base grammar it recognises two brownfield directives, handled here so
 * `parseIntent` (and `AppSpec`) stay unchanged:
 *   - `delete <name>` / `remove <name>` / `delete step <s> from <flow>`  → delete ops
 *   - `grant <tool>[, <tool>] to <cap>`                                  → wireGrants
 */
export function planChangesDeterministic(intent: string, appModel: AppModel): ChangeSpec {
  const sentences = intent
    .split(/[.\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const deletes: string[] = [];
  const grants: string[] = [];
  const keep: string[] = [];
  for (const s of sentences) {
    if (/^(?:delete|remove)\b/i.test(s)) deletes.push(s);
    else if (/^grant\b/i.test(s)) grants.push(s);
    else keep.push(s);
  }

  // Only the non-delete/non-grant sentences drive the base grammar parser.
  let specCaps: CapabilitySpec[] = [];
  let specCompute: ComputeSpec | undefined;
  let specName = "app";
  // Id resolution (brownfield): an id the scanned app ALREADY has wins. The lookup uses the
  // ORIGINAL phrase's legacy slug (digit-led ids allowed), e.g. "2fa login" -> existing
  // `2fa-login`; only when nothing matches is a NEW id minted (`item-2fa-login`). No
  // string-stripping of `item-`: a genuine new "item 2fa" is `item-2fa`, never the existing
  // `2fa`. A new digit-led "2fa" does map to an existing `item-2fa` (same minted id).
  const flowIds = new Map(appModel.flows.map((f) => [f.id, new Set(f.steps.map((s) => s.id))]));
  const resolver: IdResolver = {
    capability: (raw) => {
      const legacy = slug(raw);
      return flowIds.has(legacy) ? legacy : newIdSlug(raw);
    },
    step: (capId, raw) => {
      const legacy = slug(raw);
      return flowIds.get(capId)?.has(legacy) === true ? legacy : newIdSlug(raw);
    },
  };
  if (keep.length > 0) {
    const spec = parseIntent(keep.join(". "), resolver);
    specCaps = spec.capabilities;
    specCompute = spec.compute;
    specName = spec.name;
  }

  const byId = new Map(appModel.flows.map((f) => [f.id, f]));
  const capabilities: CapabilityChange[] = specCaps.map((cap) => {
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

  const capById = new Map(capabilities.map((c) => [c.id, c]));
  const ensureCap = (id: string, op: Op, sentence: string): CapabilityChange => {
    let c = capById.get(id);
    if (c === undefined) {
      c = { id, name: pascal(id), intent: sentence, op, steps: [] };
      capabilities.push(c);
      capById.set(id, c);
    }
    return c;
  };

  // Delete resolves ids with the SAME rule as extend (the resolver above) but never mints: the
  // legacy slug if the app has it, else the minted `newIdSlug` if THAT exists, else undefined
  // (reported by the caller as "no such flow/step"). So "create 2fa" extending `item-2fa` and
  // "delete 2fa" removing it agree.
  const lookup = (raw: string, has: (id: string) => boolean): string | undefined => {
    const legacy = slug(raw);
    if (has(legacy)) return legacy;
    const minted = newIdSlug(raw);
    return has(minted) ? minted : undefined;
  };

  for (const s of deletes) {
    const stepM = s.match(
      /(?:delete|remove)\s+(?:the\s+)?step\s+([a-z0-9][a-z0-9\s-]*?)(?:\s+from\s+(?:the\s+)?([a-z0-9\s-]+?)(?:\s+flow)?)?$/i
    );
    if (stepM?.[1] !== undefined) {
      const flowId =
        stepM[2] !== undefined
          ? lookup(stepM[2], (id) => byId.has(id))
          : appModel.flows.length === 1
            ? appModel.flows[0]!.id
            : undefined;
      const known = flowId !== undefined ? flowIds.get(flowId) : undefined;
      const stepId = lookup(stepM[1], (id) => known?.has(id) === true);
      if (flowId !== undefined && stepId !== undefined) {
        ensureCap(flowId, "extend", s).steps.push({ id: stepId, op: "delete" });
      }
      continue;
    }
    const flowM = s.match(
      /(?:delete|remove)\s+(?:the\s+)?([a-z0-9][a-z0-9\s-]*?)(?:\s+(?:flow|capability))?$/i
    );
    if (flowM?.[1] !== undefined) {
      const id = lookup(flowM[1], (f) => byId.has(f));
      if (id !== undefined && !capById.has(id)) ensureCap(id, "delete", s);
    }
  }

  for (const s of grants) {
    const m = s.match(
      /^grant\s+(.+?)\s+to\s+(?:the\s+)?([a-z0-9][a-z0-9\s-]*?)(?:\s+(?:flow|capability))?$/i
    );
    if (m?.[1] !== undefined && m[2] !== undefined) {
      const tools = m[1]
        .split(/\s*(?:,|and)\s*/)
        .map(slug)
        .filter((t) => t.length > 0);
      const legacyCap = slug(m[2]);
      const capId = byId.has(legacyCap) ? legacyCap : newIdSlug(m[2]);
      const c = ensureCap(capId, byId.has(capId) ? "extend" : "create", s);
      c.wireGrants = [...(c.wireGrants ?? []), ...tools];
    }
  }

  const name = capabilities.find((c) => c.op !== "delete")?.id ?? capabilities[0]?.id ?? specName;
  return {
    name,
    capabilities,
    ...(specCompute !== undefined && { compute: specCompute }),
    planner: "deterministic",
  };
}
