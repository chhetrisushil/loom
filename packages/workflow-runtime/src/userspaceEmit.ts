import {
  CUSTOM_DIMENSION_CEILING,
  CUSTOM_DIMENSION_MAX,
  CUSTOM_DIMENSION_PATTERN,
  knownEventTypes,
} from "@loom/replay-vm";
import { assertUnreservedDecisionId } from "./inDoubt";

// ADR 0104 — what flow and effect code may append.
//
// `ctx.emit` (and so `ctx.stream`/`ctx.ui`, which are emits) and `EffectContext.emit` append an
// event of ANY type, and the fold folds by NAME. Before this, flow code could append
// `EXECUTION_RESUMED` to answer its own next gate (no schema, no authenticator), or
// `STEP_STARTED` + `EFFECT_INDOUBT` + `EXECUTION_RESUMED(verdict)` to have a non-idempotent step
// adopted after a crash with an output no operator gave. The same ingress rule that closes the
// kernel namespace to a caller-supplied RESUME (#304) now closes it to userspace emits, with one
// explicit allow-list: the audit facts first-party middleware and effects legitimately record
// from inside an effect, none of which moves an execution, a step, or a gate.
//
// Kernel-internal writes (STEP_*, EFFECT_INDOUBT, the runtime's bootstrap events) use the
// context's private `commit` / the journal directly and never pass through here.

/** Kernel event types userspace may append: pure audit folds, each with a first-party writer. */
export const USERSPACE_KERNEL_EVENTS: ReadonlySet<string> = new Set([
  "RESOURCE_METERED", // @loom/middleware metering / nestedBudget
  "QUOTA_EXCEEDED", // @loom/middleware metering / nestedBudget / streamTokenBudget
  "SAFETY_BLOCKED", // @loom/middleware safety
  "EGRESS_DENIED", // @loom/isolate
  "EFFECT_DENIED", // @loom/effect-runtime authorization
  "OUTCOME_RECORDED", // @loom/analytics recordOutcome (and loom-examples db-observability)
  "DECISION_RECORDED", // AgentRunner; reserved `__loom_` ids refused below
]);

const KERNEL = new Set(knownEventTypes());

/** Who is emitting: flow code (`ctx.emit`) or an effect / middleware (`EffectContext.emit`). */
export type EmitScope =
  | { kind: "flow"; conflicts: DecisionConflict }
  | { kind: "effect"; stepId: string; attempt: number; conflicts: DecisionConflict };

/**
 * Whether recording `choice` under `decisionId` would CHANGE a decision already recorded. Only a
 * different choice is refused: re-emitting the identical fact (a flow's emit re-run on replay,
 * ADR 0102) changes nothing the fold serves.
 */
export type DecisionConflict = (decisionId: string, choice: unknown) => boolean;

/**
 * Upper bounds on one RESOURCE_METERED increment. Not budgets (budgets are the middleware's):
 * sanity ceilings no real single effect reaches, so a hostile or broken meter cannot wrap a
 * running total. A negative, non-finite or non-numeric value is refused outright — `_resources`
 * is what budgets, quotas and `negotiateBudget` read, and it only ever grows.
 */
export const METER_CEILINGS: Readonly<Record<string, number>> = {
  tokens: 1e12,
  costUsd: 1e9,
  ms: 1e10,
  wallMs: 1e10,
  memBytes: 1e15,
  netBytes: 1e15,
};
const QUOTA_REASON_MAX = 1024;

/**
 * The id an EFFECT-written decision is recorded under: `effect:<stepId>#<attempt>:<id>`. An
 * effect records a fact about its own step (AgentRunner's routing); it must never land in the
 * flow's `ctx.decide` namespace, where it would be SERVED to the flow as the flow's own decision
 * (the flow's decider never runs). The attempt keeps a crash re-run of the step from colliding
 * with the facts its crashed attempt recorded.
 */
export function effectDecisionId(stepId: string, attempt: number, decisionId: string): string {
  return `${EFFECT_DECISION_PREFIX}${stepId}#${attempt}:${decisionId}`;
}

/** The prefix of every effect-written decision id ({@link effectDecisionId}). */
export const EFFECT_DECISION_PREFIX = "effect:";

/**
 * A FLOW-scope decision id (`ctx.decide`, a flow-level `DECISION_RECORDED` emit) may use neither
 * the kernel's `__loom_` namespace nor the `effect:` namespace: flow code that pre-recorded
 * `effect:<step>#<attempt>:<id>` would have an agent step's decision served from the log instead
 * of made.
 */
export function assertFlowDecisionId(decisionId: unknown): void {
  assertUnreservedDecisionId(decisionId);
  if (typeof decisionId === "string" && decisionId.startsWith(EFFECT_DECISION_PREFIX)) {
    throw new Error(
      `decision id "${decisionId}" is reserved: "${EFFECT_DECISION_PREFIX}" prefixes the decisions effects record about their own steps (ADR 0104)`
    );
  }
}

/**
 * ADR 0115 D2 — `WorkflowRuntimeDeps.meterCeilings`: a per-dimension override of the sanity
 * ceiling on one RESOURCE_METERED increment (built-in or custom). Checked at construction: a
 * name must be a built-in or match the custom-name pattern, and a ceiling must be a finite
 * number > 0. A CUSTOM dimension's ceiling may not exceed the fold's own 1e15 (the fold, a pure
 * function, skips a larger value; a guard that admitted it would let an event through that the
 * fold then ignores).
 */
export function assertMeterCeilings(ceilings: Readonly<Record<string, number>> | undefined): void {
  if (ceilings === undefined) return;
  for (const [name, c] of Object.entries(ceilings)) {
    const builtin = Object.hasOwn(METER_CEILINGS, name);
    if (!builtin && !CUSTOM_DIMENSION_PATTERN.test(name)) {
      throw new Error(
        `meterCeilings: "${name}" is neither a built-in dimension nor a valid custom name ${String(CUSTOM_DIMENSION_PATTERN)}`
      );
    }
    if (!builtin && (name === "constructor" || name === "prototype")) {
      throw new Error(`meterCeilings: "${name}" is not a usable dimension name`);
    }
    if (typeof c !== "number" || !Number.isFinite(c) || c <= 0) {
      throw new Error(`meterCeilings.${name} must be a finite number > 0 (got ${String(c)})`);
    }
    if (!builtin && c > CUSTOM_DIMENSION_CEILING) {
      throw new Error(
        `meterCeilings.${name} must be at most ${CUSTOM_DIMENSION_CEILING}: the fold skips a larger custom value`
      );
    }
  }
}

/**
 * ADR 0115 D3 — `DecideOptions.estimatedCost` is descriptive, so it is bounded like the
 * metering map it mirrors (a plain object, at most 32 names matching the dimension pattern,
 * finite non-negative values) and refused before the decision is recorded. The fold skips a
 * bad entry instead of throwing, for a log this guard did not write.
 */
export function assertEstimatedCost(estimatedCost: unknown): void {
  const fail = (why: string): never => {
    throw new Error(`decide: estimatedCost ${why} (ADR 0115)`);
  };
  if (estimatedCost === null || typeof estimatedCost !== "object" || Array.isArray(estimatedCost)) {
    fail("must be an object of per-dimension costs");
  }
  const entries = Object.entries(estimatedCost as Record<string, unknown>);
  if (entries.length > CUSTOM_DIMENSION_MAX) {
    fail(`names at most ${CUSTOM_DIMENSION_MAX} dimensions`);
  }
  for (const [name, v] of entries) {
    if (!CUSTOM_DIMENSION_PATTERN.test(name) && !Object.hasOwn(METER_CEILINGS, name)) {
      fail(`dimension "${name}" must match ${String(CUSTOM_DIMENSION_PATTERN)}`);
    }
    if (name === "constructor" || name === "prototype") fail(`dimension "${name}" is not usable`);
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      fail(`${name} must be a finite non-negative number (got ${String(v)})`);
    }
  }
}

function assertCustomDimensions(
  eventType: string,
  custom: unknown,
  ceilings: Readonly<Record<string, number>> | undefined
): void {
  if (custom === null || typeof custom !== "object" || Array.isArray(custom)) {
    refuse(eventType, "custom must be an object of metering dimensions");
  }
  const entries = Object.entries(custom as Record<string, unknown>);
  if (entries.length > CUSTOM_DIMENSION_MAX) {
    refuse(eventType, `custom names at most ${CUSTOM_DIMENSION_MAX} dimensions`);
  }
  for (const [name, v] of entries) {
    if (!CUSTOM_DIMENSION_PATTERN.test(name) || name === "constructor" || name === "prototype") {
      refuse(
        eventType,
        `custom dimension "${name}" must match ${String(CUSTOM_DIMENSION_PATTERN)}`
      );
    }
    const ceiling =
      ceilings !== undefined && Object.hasOwn(ceilings, name)
        ? Math.min(ceilings[name] as number, CUSTOM_DIMENSION_CEILING)
        : CUSTOM_DIMENSION_CEILING;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > ceiling) {
      refuse(
        eventType,
        `custom.${name} must be a finite number in [0, ${ceiling}] (got ${String(v)})`
      );
    }
  }
}

function refuse(eventType: string, why: string): never {
  throw new Error(`${eventType} refused (ADR 0104): ${why}`);
}

/**
 * Validate a userspace emit and return the payload to COMMIT. The payload of every allowed
 * kernel type is copied to plain data first (`{ ...payload }` runs each getter once), so what is
 * checked is what is folded.
 *
 * - `DECISION_RECORDED`: a reserved `__loom_` id is refused; an effect's id is rewritten into
 *   its step's namespace (`effectDecisionId`); an id already recorded with a DIFFERENT choice is
 *   refused (no overwrite).
 * - `RESOURCE_METERED`: every meter field present must be a finite, non-negative number under
 *   its ceiling.
 *   `custom` (ADR 0115, EVENT_SCHEMA 1.23.0) must be a plain object of at most 32 names, each
 *   matching `/^[a-z][a-z0-9._-]{0,63}$/`, none of `constructor`/`prototype`, each value a
 *   finite number in [0, 1e15] (a `WorkflowRuntimeDeps.meterCeilings` entry lowers a
 *   dimension's ceiling; built-ins may also be raised).
 * - `OUTCOME_RECORDED`: `recordedBy` and `late` are written only by `recordOutcome` (ADR 0116)
 *   and are refused here, so a learning pipeline can trust them.
 * - `QUOTA_EXCEEDED`: `reason`, when present, must be a string of at most 1024 characters.
 */
export function guardUserspaceEmit(
  eventType: string,
  payload: unknown,
  scope?: EmitScope,
  ceilings?: Readonly<Record<string, number>>
): unknown {
  if (!KERNEL.has(eventType)) return payload;
  if (!USERSPACE_KERNEL_EVENTS.has(eventType)) {
    throw new Error(
      `"${eventType}" is a kernel event type: only the kernel writes it, because the fold would take it as a fact about the execution (ADR 0104). Emit an application event type instead.`
    );
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    refuse(eventType, "the payload must be an object");
  }
  const plain: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  switch (eventType) {
    case "DECISION_RECORDED": {
      const raw = plain.decisionId;
      if (typeof raw !== "string" || raw.length === 0) {
        refuse(eventType, "decisionId must be a non-empty string");
      }
      if (scope?.kind === "effect") assertUnreservedDecisionId(raw);
      else assertFlowDecisionId(raw);
      const decisionId =
        scope?.kind === "effect" ? effectDecisionId(scope.stepId, scope.attempt, raw) : raw;
      if (scope?.conflicts(decisionId, plain.choice) === true) {
        refuse(
          eventType,
          `decision "${decisionId}" is already recorded; a recorded decision is never overwritten`
        );
      }
      plain.decisionId = decisionId;
      return plain;
    }
    case "RESOURCE_METERED": {
      for (const [field, defaultCeiling] of Object.entries(METER_CEILINGS)) {
        if (!(field in plain)) continue;
        const ceiling =
          ceilings !== undefined && Object.hasOwn(ceilings, field)
            ? (ceilings[field] as number)
            : defaultCeiling;
        const v = plain[field];
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > ceiling) {
          refuse(
            eventType,
            `${field} must be a finite number in [0, ${ceiling}] (got ${String(v)}); a meter only ever adds`
          );
        }
      }
      if ("custom" in plain) assertCustomDimensions(eventType, plain.custom, ceilings);
      return plain;
    }
    case "OUTCOME_RECORDED": {
      for (const field of ["recordedBy", "late"]) {
        if (field in plain) {
          refuse(
            eventType,
            `"${field}" is written only by the kernel's recordOutcome (ADR 0116); a flow's own outcome cannot claim it`
          );
        }
      }
      return plain;
    }
    case "QUOTA_EXCEEDED": {
      if (
        "reason" in plain &&
        (typeof plain.reason !== "string" || plain.reason.length > QUOTA_REASON_MAX)
      ) {
        refuse(eventType, `reason must be a string of at most ${QUOTA_REASON_MAX} characters`);
      }
      return plain;
    }
    default:
      return plain;
  }
}
