import { type AppModel, type ChangeSpec, planChangesDeterministic } from "@loom/appgen";
import type { LlmMessage } from "@loom/llm";
import {
  type DecideFn,
  type ModelRoute,
  ReasoningRuntime,
  type ReasoningTraceEntry,
  validatorConfidence,
} from "@loom/reasoning";
import { tryParseChangeSpec } from "./parse";
import { buildRepairPrompt, buildSystem, buildUser } from "./prompt";
import { validateChangeSpec } from "./validateSpec";

// ── Stage 2 (the AI stage): intent + AppModel → ChangeSpec via a local model ──
//
// The "reasoning-ladder-on-itself": we run the planner through @loom/reasoning's
// cheap-first elevation ladder. The confidence signal is a VALIDATOR — "does the output
// parse into a usable ChangeSpec?" — so a weak tier that emits junk drops below the
// threshold and the runtime elevates to a stronger model, logging each elevation via
// `decide` (P9 / DECISION_RECORDED).
//
// On top of the ladder is a SELF-REPAIR loop: a parseable ChangeSpec is semantically
// validated against the AppModel (does it reference real flows/steps? right ops?), and on
// any issue the model is re-prompted with exactly what was wrong (bounded retries). If it
// still can't produce a valid plan, we fall back to the deterministic parser, exactly as
// `--offline` would. Codegen never sees raw NL — the output is always a valid ChangeSpec.

export interface PlanModelOptions {
  /** Cheap-first model tiers (e.g. Gemma E4B tier 0, 12B tier 1). */
  routes: ModelRoute[];
  /** Log route/elevation decisions durably (P9). Optional. */
  decide?: DecideFn;
  /** Sampling temperature (default 0 for reproducible planning). */
  temperature?: number;
  /** Max self-repair re-prompts when the plan is parseable but semantically invalid (default 1). */
  maxRepairs?: number;
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

  const maxRepairs = opts.maxRepairs ?? 1;
  const messages: LlmMessage[] = [{ role: "user", content: buildUser(intent) }];

  try {
    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      const result = await runtime.reason(
        {
          system: buildSystem(appModel),
          messages,
          strategy: "planning",
          temperature: opts.temperature ?? 0,
        },
        opts.decide !== undefined ? { decide: opts.decide } : {}
      );
      const parsed = tryParseChangeSpec(result.content);
      if (parsed !== undefined) {
        const issues = validateChangeSpec(parsed, appModel, intent);
        if (issues.length === 0) {
          const elevations = elevationsFromTrace(result.trace);
          return { ...parsed, planner: "model", ...(elevations !== undefined && { elevations }) };
        }
        if (attempt < maxRepairs) {
          // Feed the model exactly what was wrong and let it revise the ChangeSpec.
          messages.push({ role: "assistant", content: result.content });
          messages.push({ role: "user", content: buildRepairPrompt(issues) });
        }
      }
    }
  } catch {
    // Any provider/native failure → deterministic fallback below.
  }

  return planChangesDeterministic(intent, appModel);
}
