import type { z } from "zod";
import type { FlowDefinition, PolicyDefinition, StepDefinition } from "../types/definitions";
import { assertBudget } from "./budget";

export interface FlowConfig<TIn, TOut> {
  id: string;
  name: string;
  version: string;
  description?: string;
  inputSchema: z.ZodSchema<TIn>;
  outputSchema: z.ZodSchema<TOut>;
  // biome-ignore lint/suspicious/noExplicitAny: a flow's steps are heterogeneous — each step has its own input/output types, so the array element type must erase them
  steps: StepDefinition<any, any>[];
  policies?: PolicyDefinition[];
  /**
   * EF-1 — the flow's declared effect-class CEILING, from the app's
   * `checks.effectClasses` ordering. `@loom/verify` fails composition when the
   * flow reaches a step classed above it (EF-2), composing conservatively as the
   * max over everything reachable (EF-3). Absent ⇒ the check skips this flow.
   */
  effectClass?: string;
  /**
   * K8.3 — declarative wall-clock deadline for a live run of this flow,
   * anchored to the LOGGED `EXECUTION_STARTED` timestamp (stable across
   * recovery — a crash never resets it). Breach = kernel-driven cancellation
   * (`EXECUTION_CANCELLED`). Enforced while a process is actively running the
   * execution; durable firing across idle suspension is T1's timer service.
   */
  deadlineMs?: number;
  /**
   * TR (ADR 0077) — resume payload contracts per gate: `resume event type →
   * schema`. `resume()` parses the payload against the matching entry BEFORE
   * appending, so a wrongly-shaped payload is refused instead of becoming a
   * permanent fold input; the parsed value (defaults/transforms applied) is what
   * is recorded. Absent, or no entry for the event type = today's behaviour,
   * byte-identically (G2).
   *
   * CAREFUL — a strict schema changes what is PERSISTED, not only what is accepted:
   * `z.object` strips keys it does not name, so a field your schema omits is dropped from the
   * durable log permanently and silently. Model the extra fields (best — you get validation
   * too), or `.passthrough()` when the payload carries an open envelope you do not own.
   *
   * ```ts
   * resumeSchemas: {
   *   ApprovalGranted: z.object({ approved: z.boolean(), approvedBy: z.string() }),
   *   RemediationDecision: z.object({ approved: z.boolean(), strategy: z.string() }),
   * }
   * ```
   */
  resumeSchemas?: Readonly<Record<string, z.ZodTypeAny>>;
  /** ADR 0113 D2 — toolchain-supplied body fingerprint (see `FlowDefinition.codeFingerprint`). */
  codeFingerprint?: string;
  /** ADR 0113 D2 — earlier fingerprints asserted replay-compatible (see `FlowDefinition.compatibleWith`). */
  compatibleWith?: readonly string[];
  /** ADR 0113 D4 — step-id families for `replay-check` (see `FlowDefinition.stepFamilies`). */
  stepFamilies?: readonly (string | RegExp)[];
}

export function flow$<TIn = unknown, TOut = unknown>(
  config: FlowConfig<TIn, TOut>
): FlowDefinition<TIn, TOut> {
  assertBudget("flow$", config.id, "deadlineMs", config.deadlineMs);
  return {
    _tag: "FlowDefinition",
    id: config.id,
    name: config.name,
    version: config.version,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    steps: config.steps,
    ...(config.description !== undefined && { description: config.description }),
    ...(config.policies !== undefined && { policies: config.policies }),
    ...(config.deadlineMs !== undefined && { deadlineMs: config.deadlineMs }),
    ...(config.resumeSchemas !== undefined && { resumeSchemas: config.resumeSchemas }),
    ...(config.effectClass !== undefined && { effectClass: config.effectClass }),
    ...(config.codeFingerprint !== undefined && { codeFingerprint: config.codeFingerprint }),
    ...(config.compatibleWith !== undefined && { compatibleWith: config.compatibleWith }),
    ...(config.stepFamilies !== undefined && { stepFamilies: config.stepFamilies }),
  };
}
