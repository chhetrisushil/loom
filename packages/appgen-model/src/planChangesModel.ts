import { type AppModel, type ChangeSpec, planChangesDeterministic } from "@loom/appgen";
import {
  type DecideFn,
  type ModelRoute,
  ReasoningRuntime,
  type ReasoningTraceEntry,
  validatorConfidence,
} from "@loom/reasoning";
import { tryParseChangeSpec } from "./parse";
import { buildSystem, buildUser } from "./prompt";

// ── Stage 2 (the AI stage): intent + AppModel → ChangeSpec via a local model ──
//
// The "reasoning-ladder-on-itself": we run the planner through @loom/reasoning's
// cheap-first elevation ladder. The confidence signal is a VALIDATOR — "does the output
// parse into a usable ChangeSpec?" — so a weak tier that emits junk drops below the
// threshold and the runtime elevates to a stronger model, logging each elevation via
// `decide` (P9 / DECISION_RECORDED). If even the top tier fails, we fall back to the
// deterministic parser, exactly as `--offline` would. Codegen never sees raw NL — the
// output of this function is always a validated ChangeSpec.

export interface PlanModelOptions {
  /** Cheap-first model tiers (e.g. Gemma E4B tier 0, 12B tier 1). */
  routes: ModelRoute[];
  /** Log route/elevation decisions durably (P9). Optional. */
  decide?: DecideFn;
  /** Sampling temperature (default 0 for reproducible planning). */
  temperature?: number;
}

function elevationsFromTrace(trace: ReasoningTraceEntry[]): ChangeSpec["elevations"] {
  const out: NonNullable<ChangeSpec["elevations"]> = [];
  for (let i = 1; i < trace.length; i++) {
    out.push({
      from: trace[i - 1]!.modelId,
      to: trace[i]!.modelId,
      reason: `confidence ${trace[i - 1]!.confidence.toFixed(2)} below threshold`,
    });
  }
  return out.length > 0 ? out : undefined;
}

export async function planChangesModel(
  intent: string,
  appModel: AppModel,
  opts: PlanModelOptions
): Promise<ChangeSpec> {
  const runtime = new ReasoningRuntime({
    routes: opts.routes,
    // Elevate whenever the produced content does NOT parse into a valid ChangeSpec.
    confidence: validatorConfidence((content) => tryParseChangeSpec(content) !== undefined),
    elevateThreshold: 0.5,
  });

  try {
    const result = await runtime.reason(
      {
        system: buildSystem(appModel),
        messages: [{ role: "user", content: buildUser(intent) }],
        strategy: "planning",
        temperature: opts.temperature ?? 0,
      },
      opts.decide !== undefined ? { decide: opts.decide } : {}
    );
    const parsed = tryParseChangeSpec(result.content);
    if (parsed !== undefined) {
      const elevations = elevationsFromTrace(result.trace);
      return { ...parsed, planner: "model", ...(elevations !== undefined && { elevations }) };
    }
  } catch {
    // Any provider/native failure → deterministic fallback below.
  }

  return planChangesDeterministic(intent, appModel);
}
