import * as capability from "@loom/capability";
import * as core from "@loom/core";
import * as effectRuntime from "@loom/effect-runtime";
import * as eventRuntime from "@loom/event-runtime";
import * as isolate from "@loom/isolate";
import * as llm from "@loom/llm";
import * as middleware from "@loom/middleware";
import * as orchestration from "@loom/orchestration";
import * as workerRuntime from "@loom/worker-runtime";
import * as workflowRuntime from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { isTerminalToolError } from "./toolFailure";

// ── R10 fix round 1 (P1-1) — which errors may be fed back to the model ──────────────────────────
//
// A denylist is only as good as its completeness, and the first cut missed `KillSwitchEngagedError`
// (it sets its own `name`), `RateLimitExceededError` and `CapabilityInvokeDeniedError`. This pins the
// classification of EVERY exported error class of the packages a tool can surface one from, so a new
// class fails loudly here until someone decides which side it is on.

/** Fed back to the model as an `isError` result. */
const FEEDBACK = new Set([
  // core
  "ReplayError",
  "StepError",
  "WorkflowNotFoundError",
  "BadRequestError",
  // isolate / event-runtime: a tool that died or was refused its input is a tool failure
  "IsolatedToolDisconnectedError",
  "IsolatedToolInputError",
  "IsolatedToolStartupError",
  "BranchPromotionConflictError",
  "TypedFailure",
  // llm: a malformed or refused request is the caller's to fix, and the model can adapt it
  "UnsupportedModalityError",
  "UnresolvedContentError",
  "InvalidLlmRequestError",
  "OversizedInlinePartError",
  "UntrustedContentError",
  "TaintedContentError",
  "MalformedStreamError",
  // workflow-runtime: lifecycle / validation refusals a tool that drives the runtime can see
  "StepTimeoutError",
  "InputValidationError",
  "ResumePayloadValidationError",
  "ResumeRefusedError",
  "ResumeContendedError",
  "ExecutionAlreadyExistsError",
  "ExecutionNotTerminalError",
  "OutcomeContendedError",
  "OutcomeRefusedError",
  "InboxClosedError",
  "InboxDiscardRefusedError",
  "InboxQuarantineRefusedError",
  "InboxFullError",
  "InboxMessageRefusedError",
  "CompactedForkPointError",
  "SnapshotIdentityMismatchError",
  "FlowMigrationCheckError",
  "StateMigrationError",
  "ChainHopLimitError",
  "ContinuationConflictError",
  "ForkPastContinuationError",
  "ReservedSuccessorIdError",
  "RedriveExhaustedError",
  "UnsafeCompactionError",
  "CompactionCheckpointMissingError",
]);

/** Reaches the runtime. */
const TERMINAL = new Set([
  "SuspendError",
  "CapabilityDeniedError",
  "CapabilityInvokeDeniedError",
  "EffectModeViolationError",
  "ExecutionDeniedError",
  "ApprovalRejectedError",
  "SafetyViolationError",
  "KillSwitchEngagedError",
  "QuotaExceededError",
  "RateLimitExceededError",
  "ExecutionCancelledError",
  "DecideScopeClosedError",
  "ParallelScopeFailedError",
  "FlowDivergenceError",
  "FlowReplayDivergenceError",
  "FlowCodeMismatchError",
  "StartFencedOutError",
  "PrincipalUnrestorableError",
  "StorageWriteError",
  "InboxTopicStreamsRequiredError",
  "SealedPayloadUnreadableError",
  "QuarantineHeldError",
  "SealedStreamUnreadableError",
  "KeyUnavailableError",
  "ShardSealingMismatchError",
  "LeaseLostError",
  "LeaseStoreQuietError",
  "AsyncContextUnavailableError",
  "StaleFenceError",
  "ExecutionSupersededError",
  "DuplicateEnvelopeIdError",
  "DuplicateSequenceError",
  "EgressDeniedError",
  "SpawnLimitExceededError",
  "ContinueAsNewRefusedError",
  "CarryTooLargeError",
  "ContinueAsNewUnavailableError",
]);

function errorClasses(mod: Record<string, unknown>): [string, new (...a: never[]) => Error][] {
  return Object.entries(mod).filter(
    (e): e is [string, new (...a: never[]) => Error] =>
      typeof e[1] === "function" && (e[1] as { prototype?: unknown }).prototype instanceof Error
  );
}

const PACKAGES: Record<string, Record<string, unknown>> = {
  "@loom/middleware": middleware,
  "@loom/effect-runtime": effectRuntime,
  "@loom/workflow-runtime": workflowRuntime,
  "@loom/capability": capability,
  "@loom/llm": llm,
  "@loom/core": core,
  "@loom/event-runtime": eventRuntime,
  "@loom/worker-runtime": workerRuntime,
  "@loom/isolate": isolate,
  "@loom/orchestration": orchestration,
};

describe("every exported error class is classified (fitness)", () => {
  it("the sweep finds classes in each package (it cannot silently match nothing)", () => {
    for (const [name, mod] of Object.entries(PACKAGES)) {
      expect(errorClasses(mod).length, name).toBeGreaterThan(0);
    }
  });

  for (const [pkg, mod] of Object.entries(PACKAGES)) {
    for (const [name, ctor] of errorClasses(mod)) {
      it(`${pkg} ${name} is classified, and the loop agrees`, () => {
        const inT = TERMINAL.has(name);
        const inF = FEEDBACK.has(name);
        expect(
          inT !== inF,
          `${pkg} exports ${name}: classify it as TERMINAL or FEEDBACK in toolFailure.test.ts`
        ).toBe(true);
        // A bare instance (no constructor args, no own `name`): the prototype chain alone must decide.
        expect(isTerminalToolError(Object.create(ctor.prototype))).toBe(inT);
      });
    }
  }
});

describe("isTerminalToolError — real instances", () => {
  it("a kill switch, a quota, a rate limit and an invoke denial are terminal", () => {
    const kill = new middleware.KillSwitchEngagedError({
      scope: "global",
      key: undefined,
      reason: "stop",
    } as never);
    expect(kill.name).toBe("KillSwitchEngagedError");
    expect(isTerminalToolError(kill)).toBe(true);
    expect(isTerminalToolError(new capability.CapabilityInvokeDeniedError("c", "no"))).toBe(true);
  });

  it("anything declaring retryable === false is terminal; an ordinary error is not", () => {
    expect(isTerminalToolError(Object.assign(new Error("x"), { retryable: false }))).toBe(true);
    expect(isTerminalToolError(Object.assign(new Error("x"), { retryable: true }))).toBe(false);
    expect(isTerminalToolError(new Error("upstream timeout"))).toBe(false);
    expect(isTerminalToolError("a string")).toBe(false);
    expect(isTerminalToolError(undefined)).toBe(false);
  });

  it("walks `cause`, to a bound", () => {
    const denial = new effectRuntime.EffectModeViolationError(
      "t",
      "journaled" as never,
      "ambient" as never
    );
    expect(isTerminalToolError(new Error("wrapped", { cause: denial }))).toBe(true);
    expect(isTerminalToolError(new Error("a", { cause: new Error("b", { cause: denial }) }))).toBe(
      true
    );
    let deep: unknown = denial;
    for (let i = 0; i < 10; i++) deep = new Error(`l${i}`, { cause: deep });
    expect(isTerminalToolError(deep)).toBe(false); // past the bound: bounded, not unbounded recursion
    // a cycle terminates
    const a = new Error("a");
    (a as { cause?: unknown }).cause = a;
    expect(isTerminalToolError(a)).toBe(false);
  });
});
