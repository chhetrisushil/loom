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
import {
  classifyModelCallError,
  classifyModelCallFailure,
  isTerminalToolError,
  markToolRaised,
} from "./toolFailure";

// ── R10 fix round 1 (P1-1) — which errors may be fed back to the model ──────────────────────────
//
// A denylist is only as good as its completeness, and the first cut missed `KillSwitchEngagedError`
// (it sets its own `name`), `RateLimitExceededError` and `CapabilityInvokeDeniedError`. This pins the
// classification of EVERY exported error class of the packages a tool can surface one from, so a new
// class fails loudly here until someone decides which side it is on.

/** Fed back to the model as an `isError` result. */
const FEEDBACK = new Set([
  // llm: a provider's non-2xx is classified by STATUS (see the LlmHttpError block below); a bare
  // instance has no status, so it is feedback
  "LlmHttpError",
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
  "BlankStreamUnrepairedError",
  "BlankStreamCensusUnavailableError",
]);

/** Reaches the runtime. */
const TERMINAL = new Set([
  "LlmStreamError",
  "LlmResponseLimitError",
  "LlmResponseInvalidError",
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
  "ExecutionStoreUnavailableError",
  "InboxTopicStreamsRequiredError",
  "SealedPayloadUnreadableError",
  "QuarantineHeldError",
  "SealedStreamUnreadableError",
  "KeyUnavailableError",
  "ShardSealingMismatchError",
  "PlaintextCheckpointError",
  "LeaseLostError",
  "LeaseHeldError",
  "LeaseStoreQuietError",
  "LeaseStoreTimeoutError",
  "StartLeaseHeldError",
  "LeaseEvidenceError",
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

describe("isTerminalToolError — LlmHttpError is classified by status", () => {
  const http = (status: number) => new llm.LlmHttpError("openai", status);

  it.each([401, 403, 429, 500, 502, 503, 504, 529, 599])(
    "%i is terminal (configuration, rate limit or transient: not the model's to fix)",
    (status) => {
      expect(isTerminalToolError(http(status))).toBe(true);
    }
  );

  it("a 400 the provider marked kind auth is terminal (configuration), a plain 400 is not", () => {
    expect(isTerminalToolError(new llm.LlmHttpError("gemini", 400, "auth"))).toBe(true);
    expect(isTerminalToolError(new llm.LlmHttpError("gemini", 400))).toBe(false);
  });

  it.each([400, 404, 408, 409, 413, 422])(
    "%i is feedback (the model can adapt the request)",
    (status) => {
      expect(isTerminalToolError(http(status))).toBe(false);
    }
  );

  it("a 3xx (a redirect, never followed) is terminal and declares itself non-retryable", () => {
    for (const st of [301, 307, 308]) {
      expect(isTerminalToolError(http(st))).toBe(true);
      expect((http(st) as { retryable?: unknown }).retryable).toBe(false);
    }
    expect((http(503) as { retryable?: unknown }).retryable).toBeUndefined();
  });

  it("a response limit or invalid body is a provider failure for the conversation's model call", () => {
    expect(classifyModelCallError(new llm.LlmResponseLimitError("openai", "body"))).toBe(
      "provider"
    );
    expect(classifyModelCallError(new llm.LlmResponseInvalidError("openai"))).toBe("provider");
    expect(classifyModelCallError(http(307))).toBe("provider");
  });

  it("is found through a cause chain", () => {
    expect(isTerminalToolError(new Error("tool failed", { cause: http(429) }))).toBe(true);
    expect(isTerminalToolError(new Error("tool failed", { cause: http(400) }))).toBe(false);
  });

  it("a mid-stream provider error is terminal", () => {
    expect(isTerminalToolError(new llm.LlmStreamError("anthropic", "overloaded_error"))).toBe(true);
  });
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

describe("classifyModelCallError — the conversation's own model call", () => {
  const http = (status: number) => new llm.LlmHttpError("openai", status);
  const named = (name: string, extra: object = {}) =>
    Object.assign(new Error("x"), { name }, extra);
  it("provider failures (any status, by name) are provider, whatever isTerminalToolError says", () => {
    for (const status of [400, 404, 429, 503]) {
      expect(classifyModelCallError(named("LlmHttpError", { status }))).toBe("provider");
    }
    expect(classifyModelCallError(new llm.LlmStreamError("anthropic", "overloaded_error"))).toBe(
      "provider"
    );
    expect(classifyModelCallError(named("LlmStreamError"))).toBe("provider");
    expect(classifyModelCallError(new Error("w", { cause: http(529) }))).toBe("provider");
  });
  it("a bare LlmHttpError with no numeric status, and ordinary errors, are other", () => {
    expect(classifyModelCallError(named("LlmHttpError"))).toBe("other");
    expect(classifyModelCallError(new Error("boom"))).toBe("other");
    expect(classifyModelCallError("s")).toBe("other");
  });
  it("a non-provider terminal error wins at any depth within the bound", () => {
    const denial = new capability.CapabilityInvokeDeniedError("c", "no");
    expect(classifyModelCallError(denial)).toBe("terminal");
    expect(classifyModelCallError(Object.assign(http(503), { cause: denial }))).toBe("terminal");
    expect(
      classifyModelCallError(new Error("w", { cause: Object.assign(http(503), { cause: denial }) }))
    ).toBe("terminal");
  });
  it("retryable=false alone is NOT terminal on the model call (plain, wrapped, or on a provider error)", () => {
    const nr = (e: Error = new Error("x")) => Object.assign(e, { retryable: false });
    expect(isTerminalToolError(nr())).toBe(true); // the tool loop keeps the rule
    expect(classifyModelCallError(nr())).toBe("other");
    expect(classifyModelCallError(new Error("w", { cause: nr() }))).toBe("other");
    expect(classifyModelCallError(nr(http(400)))).toBe("provider");
    expect(classifyModelCallError(Object.assign(http(503), { cause: nr() }))).toBe("provider");
  });
  it("control flow is terminal on the model call: park, denial, cancel, kill switch, even with retryable=false", () => {
    expect(classifyModelCallError(new core.SuspendError({ on: "Gate" }))).toBe("terminal");
    for (const name of [
      "KillSwitchEngagedError",
      "ExecutionCancelledError",
      "FlowDivergenceError",
    ]) {
      expect(classifyModelCallError(named(name))).toBe("terminal");
      expect(classifyModelCallError(named(name, { retryable: false }))).toBe("terminal");
    }
    const denial = new capability.CapabilityInvokeDeniedError("c", "no");
    expect(
      classifyModelCallError(Object.assign(new Error("w"), { retryable: false, cause: denial }))
    ).toBe("terminal");
  });
  it("classifyModelCallFailure: rate limit and quota are their own failed-turn reasons, terminal for tools", () => {
    for (const [name, want] of [
      ["RateLimitExceededError", "rate-limited"],
      ["QuotaExceededError", "quota"],
    ] as const) {
      const e = named(name, { retryable: false });
      expect(isTerminalToolError(e)).toBe(true);
      expect(classifyModelCallFailure(e)).toBe(want);
      expect(classifyModelCallFailure(new Error("w", { cause: e }))).toBe(want);
      expect(classifyModelCallError(e)).toBe("other");
    }
    // control flow deeper still wins
    const kill = named("KillSwitchEngagedError");
    expect(
      classifyModelCallFailure(Object.assign(named("QuotaExceededError"), { cause: kill }))
    ).toBe("terminal");
  });
  it("classifyModelCallFailure: only a TOP-LEVEL, non-sealed authority denial is `denied`", () => {
    const denial = new capability.CapabilityInvokeDeniedError("c", "no");
    expect(classifyModelCallFailure(denial)).toBe("denied");
    expect(classifyModelCallFailure(new Error("w", { cause: denial }))).toBe("terminal");
    const sealed = Object.assign(named("ExecutionDeniedError"), {
      [Symbol.for("loom.sealedUnreadable")]: true,
    });
    expect(classifyModelCallFailure(sealed)).toBe("terminal");
    expect(classifyModelCallFailure(named("KillSwitchEngagedError"))).toBe("terminal");
  });
  it("classifyModelCallFailure: a tool-raised error is tool-error; the rest is model-error", () => {
    const toolErr = Object.assign(new Error("t"), { retryable: false });
    markToolRaised(toolErr);
    expect(classifyModelCallFailure(toolErr)).toBe("tool-error");
    expect(classifyModelCallFailure(new Error("w", { cause: toolErr }))).toBe("tool-error");
    expect(classifyModelCallFailure(Object.assign(new Error("m"), { retryable: false }))).toBe(
      "model-error"
    );
    expect(classifyModelCallFailure(http(503))).toBe("model-error");
    expect(classifyModelCallFailure("s")).toBe("model-error");
  });
  it("stays in sync with isTerminalToolError: every terminal provider failure is provider, never terminal", () => {
    for (const e of [
      http(401),
      http(403),
      http(429),
      http(500),
      new llm.LlmStreamError("anthropic", "x"),
    ]) {
      expect(isTerminalToolError(e)).toBe(true);
      expect(classifyModelCallError(e)).toBe("provider");
    }
  });
});
