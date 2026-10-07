// ADR 0109 (R1b) — bounded history / continue-as-new: the kernel-private pieces.
//
// `ctx.continueAsNew(carry)` unwinds the flow with a kernel sentinel; the runtime then starts the
// successor FIRST (a durable idempotent start at `<chainId>~<generation+1>`) and only then commits
// `EXECUTION_CONTINUED` to the predecessor. Everything here is pure (no I/O) so the shapes the
// fold, the runtime and the tests share cannot drift.

import type { EventEnvelope, ExecutionState } from "@loom/core";
import { storedPrincipalOf } from "./principal";

/** The default kernel cap on a carry (ADR 0109 D1, decided by the user 2026-10-05): 1 MiB. */
export const DEFAULT_MAX_CARRY_BYTES = 1_048_576;

/** The default bound on a head walk (`_continuedTo`), `maxChainHops` (ADR 0109 D4). */
export const DEFAULT_MAX_CHAIN_HOPS = 8;

/** An id segment of this shape is a SUCCESSOR segment: `<x>~<n>` (the next generation of `<x>`'s chain). */
const SUCCESSOR_SEGMENT = /^.+~[0-9]+$/;
const SEP = "::";

/** The root segment of an execution id: the text before the first `::`. */
export function rootSegment(executionId: string): string {
  const i = executionId.indexOf(SEP);
  return i < 0 ? executionId : executionId.slice(0, i);
}

/** The last segment of an execution id: the text after the last `::` (the whole id when bare). */
export function lastSegment(executionId: string): string {
  const i = executionId.lastIndexOf(SEP);
  return i < 0 ? executionId : executionId.slice(i + SEP.length);
}

/**
 * How a caller-chosen id relates to the reserved successor shape (ADR 0109 D2 (a)):
 *  - `"always"`: the LAST segment is `<x>~<digits>`. That is the id of a chain's next generation
 *    (`a~1`, and for a `::`-derived chain `parent::g#0~1`, which is how an orchestration child
 *    rotates), so only the kernel creates it; refused for every caller whether or not any log exists.
 *  - `"derived"`: only the ROOT segment has the shape (`chain~1::g#0`, a supervised child of an
 *    existing generation): creatable by the supervisor when the derived parent's log exists.
 *  - `"none"`.
 */
export function successorShapeOf(executionId: string): "always" | "derived" | "none" {
  if (SUCCESSOR_SEGMENT.test(lastSegment(executionId))) return "always";
  return SUCCESSOR_SEGMENT.test(rootSegment(executionId)) ? "derived" : "none";
}

/** Does `executionId` have ANY reserved successor shape (see {@link successorShapeOf})? */
export function hasSuccessorShape(executionId: string): boolean {
  return successorShapeOf(executionId) !== "none";
}

/**
 * The id a `::`-derived child's parent would have (everything up to the last `::`), or `undefined`
 * for a bare id. A successor-shaped root is creatable only when this parent's log exists.
 */
export function derivedParentOf(executionId: string): string | undefined {
  const i = executionId.lastIndexOf(SEP);
  return i < 0 ? undefined : executionId.slice(0, i);
}

/** The deterministic id of the generation after `generation` of `chainId`. */
export function successorIdOf(chainId: string, generation: number): string {
  return `${chainId}~${generation + 1}`;
}

/** What the fold knows of an execution's place in a chain (`_chain`, read through the fold). */
export interface ChainIdentity {
  readonly chainId: string;
  readonly generation: number;
  readonly continuedFrom?: { readonly executionId: string; readonly carried?: unknown };
}

/**
 * Chain identity read through the FOLD (never raw sequence 0: a fork's `forkChain` stamp replaces
 * the copied payload's identity, ADR 0109 D2/D7). An execution that was never part of a chain
 * (every pre-1.23.0 log, every plain start) is generation 0 of its own chain.
 */
export function chainOfState(state: ExecutionState, executionId: string): ChainIdentity {
  const raw = state.variables._chain as
    | { chainId?: unknown; generation?: unknown; continuedFrom?: unknown }
    | undefined;
  if (
    raw !== undefined &&
    typeof raw.chainId === "string" &&
    raw.chainId.length > 0 &&
    Number.isSafeInteger(raw.generation) &&
    (raw.generation as number) >= 0
  ) {
    const from = raw.continuedFrom as { executionId?: unknown; carried?: unknown } | undefined;
    const continuedFrom =
      from !== undefined && typeof from.executionId === "string"
        ? {
            executionId: from.executionId,
            ...(from.carried !== undefined && { carried: from.carried }),
          }
        : undefined;
    return {
      chainId: raw.chainId,
      generation: raw.generation as number,
      ...(continuedFrom !== undefined && { continuedFrom }),
    };
  }
  return { chainId: executionId, generation: 0 };
}

/** The chain's absolute deadline (epoch ms) a successor inherited, if its generation 0 had one. */
export function chainDeadlineOf(state: ExecutionState, executionId: string): number | undefined {
  const carried = chainOfState(state, executionId).continuedFrom?.carried as
    | { chainDeadline?: unknown }
    | undefined;
  const d = carried?.chainDeadline;
  return typeof d === "number" && Number.isFinite(d) ? d : undefined;
}

/**
 * What a successor inherits from its predecessor's fold (ADR 0109 D3): the running resource totals
 * (a rotation must not reset a quota), the inbox cursors and the dedupe window, and the absolute
 * chain deadline. Frames, decisions, resume payloads, outcomes and `_flowEmits` are NOT carried:
 * that is the point of a continuation.
 */
export interface CarriedState {
  resources?: unknown;
  inbox?: { cursors: Record<string, number>; dedupe: string[] };
  chainDeadline?: number;
}

export function carriedOf(state: ExecutionState, chainDeadline: number | undefined): CarriedState {
  const resources = state.variables._resources;
  const inbox = state.variables._inbox as { cursors?: unknown; dedupe?: unknown } | undefined;
  return {
    ...(resources !== undefined && resources !== null && { resources }),
    ...(inbox !== undefined && {
      inbox: {
        cursors: (inbox.cursors ?? {}) as Record<string, number>,
        dedupe: Array.isArray(inbox.dedupe) ? (inbox.dedupe as string[]) : [],
      },
    }),
    ...(chainDeadline !== undefined && { chainDeadline }),
  };
}

/**
 * The kernel sentinel `ctx.continueAsNew` unwinds the runner with (like `SuspendError`): it is
 * never a failure. `carry` is already validated, bounded and JSON-normalised.
 */
export class ContinueAsNewSignal extends Error {
  constructor(readonly carry: unknown) {
    super("continueAsNew: the execution is continuing as its successor");
    this.name = "ContinueAsNewSignal";
    Object.setPrototypeOf(this, ContinueAsNewSignal.prototype);
  }
}

/** `ctx.continueAsNew` with `kernel.features.continueAsNew` off (ADR 0109 D8: mixed fleets). */
export class ContinueAsNewUnavailableError extends Error {
  readonly retryable = false;
  constructor() {
    super(
      "ctx.continueAsNew needs `kernel.features.continueAsNew` (WorkflowRuntimeDeps.continueAsNewEnabled): turn it on only once every node runs a kernel that folds EXECUTION_CONTINUED and the `continued` status (EVENT_SCHEMA 1.23.0; ADR 0109 D8)"
    );
    this.name = "ContinueAsNewUnavailableError";
    Object.setPrototypeOf(this, ContinueAsNewUnavailableError.prototype);
  }
}

/**
 * `ctx.continueAsNew` refused with the log untouched: a precondition does not hold (an open
 * `parallel` scope, an outstanding wait, the execution not running), or the carry is unusable (no JSON form, over `maxCarryBytes`).
 */
export class ContinueAsNewRefusedError extends Error {
  readonly retryable = false;
  constructor(
    readonly executionId: string,
    readonly reason: string
  ) {
    super(`ctx.continueAsNew on "${executionId}" refused: ${reason}. Nothing was appended.`);
    this.name = "ContinueAsNewRefusedError";
    Object.setPrototypeOf(this, ContinueAsNewRefusedError.prototype);
  }
}

/** A carry over the kernel cap `maxCarryBytes` (it rides sequence 0 of the successor and every snapshot). */
export class CarryTooLargeError extends ContinueAsNewRefusedError {
  constructor(
    executionId: string,
    readonly bytes: number,
    readonly maxCarryBytes: number
  ) {
    super(
      executionId,
      `the carry is ${bytes} bytes, over maxCarryBytes (${maxCarryBytes}); carry a reference (a claim-check key, an id), not the data`
    );
    this.name = "CarryTooLargeError";
    Object.setPrototypeOf(this, CarryTooLargeError.prototype);
  }
}

/**
 * The continuation start found an existing sequence 0 at the successor id whose
 * `continuedFrom.executionId` is NOT this predecessor (ADR 0109 D2 (b)): a squatter, or a
 * foreign chain. Raised instead of adopting it as the successor. The predecessor fails with it.
 */
export class ContinuationConflictError extends Error {
  readonly retryable = false;
  constructor(
    readonly predecessorId: string,
    readonly successorId: string,
    readonly foundContinuedFrom: string | undefined
  ) {
    super(
      `continuation of "${predecessorId}": "${successorId}" already exists and was not started as its successor (its continuedFrom is ${
        foundContinuedFrom === undefined ? "absent" : `"${foundContinuedFrom}"`
      })`
    );
    this.name = "ContinuationConflictError";
    Object.setPrototypeOf(this, ContinuationConflictError.prototype);
  }
}

/** A fork point at or after `EXECUTION_CONTINUED`: fork the successor instead (ADR 0109 D7). */
export class ForkPastContinuationError extends Error {
  readonly retryable = false;
  constructor(
    readonly executionId: string,
    readonly atSequence: number,
    /** The sequence of the `EXECUTION_CONTINUED` event when it was read (absent when only a snapshot's fold said so). */
    readonly continuedAtSequence: number | undefined,
    readonly successorId: string | undefined
  ) {
    super(
      `fork of "${executionId}" at sequence ${atSequence} is at or after its EXECUTION_CONTINUED${
        continuedAtSequence !== undefined ? ` (sequence ${continuedAtSequence})` : ""
      }${successorId !== undefined ? `: fork the successor "${successorId}" instead` : ""}`
    );
    this.name = "ForkPastContinuationError";
    Object.setPrototypeOf(this, ForkPastContinuationError.prototype);
  }
}

/**
 * A head walk (`resume` / `send` to a continued id) ran out of `maxChainHops` before reaching the
 * head. `reached` is the furthest id the walk read: retry from it (a `send` result names the live
 * head in `executionId`; address that).
 */
export class ChainHopLimitError extends Error {
  readonly retryable = false;
  constructor(
    readonly executionId: string,
    readonly hops: number,
    readonly reached: string
  ) {
    super(
      `execution "${executionId}" continued more than ${hops} times: the walk to its head stopped at "${reached}". Address "${reached}" (or the executionId a send returned) instead.`
    );
    this.name = "ChainHopLimitError";
    Object.setPrototypeOf(this, ChainHopLimitError.prototype);
  }
}

/** A caller-chosen id with the reserved successor shape (ADR 0109 D2 (a)). */
export class ReservedSuccessorIdError extends Error {
  readonly retryable = false;
  constructor(readonly executionId: string) {
    super(
      `executionId "${executionId}" is reserved: a root id segment of the form "<x>~<digits>" names the successor of a continue-as-new chain (ADR 0109); only the kernel creates one, and a "::"-derived child of it needs the parent's log to exist`
    );
    this.name = "ReservedSuccessorIdError";
    Object.setPrototypeOf(this, ReservedSuccessorIdError.prototype);
  }
}

/**
 * Chain identity from sequence 0 alone (no fold): a valid `forkChain` stamp wins, else the start
 * payload's `chainId` + `generation`, else the execution itself at generation 0 — the fold's own
 * rule for the part a probe needs. `send`'s head walk reads only sequence 0 and the tip.
 */
export function chainOfFirstEnvelope(
  first: { payload?: unknown; metadata?: Record<string, unknown> | undefined },
  executionId: string
): ChainIdentity {
  const valid = (v: unknown): ChainIdentity | undefined => {
    if (v === null || typeof v !== "object") return undefined;
    const { chainId, generation } = v as { chainId?: unknown; generation?: unknown };
    return typeof chainId === "string" &&
      chainId.length > 0 &&
      Number.isSafeInteger(generation) &&
      (generation as number) >= 0
      ? { chainId, generation: generation as number }
      : undefined;
  };
  return (
    valid(first.metadata?.forkChain) ??
    valid(first.payload) ?? { chainId: executionId, generation: 0 }
  );
}

/** JSON with object keys sorted at every level (a comparable form for a recorded structure). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** The `parent` lineage a sequence-0 envelope records, if any. */
function parentOfSeq0(first: EventEnvelope): string | undefined {
  const parent = (first.payload as { parent?: unknown } | null | undefined)?.parent;
  return typeof parent === "string" && parent.length > 0 ? parent : undefined;
}

/**
 * The principal a sequence 0 records, as a comparable key: `undefined` when it cannot be compared
 * (shredded or malformed: those never block a hop), `{"v":1}` for a legacy log (the successor of a
 * principal-less execution records the empty record).
 */
function principalKeyOf(first: EventEnvelope): string | undefined {
  const stored = storedPrincipalOf(first);
  if (stored.kind === "legacy") return JSON.stringify({ v: 1 });
  if (stored.kind !== "record") return undefined;
  return canonical(stored.record);
}

/**
 * ADR 0109 D4 — is `next` (the sequence 0 read at `nextId`) really the successor of `prev`, the
 * execution at `prevId`? A hop is followed only when the successor's own start says so: it was
 * created at the deterministic id `<chainId>~<generation+1>`, names `prevId` in
 * `continuedFrom.executionId`, is the next generation of the same chain, and records the same owner
 * and lineage. `_continuedTo` (or a probe) is a POINTER; this is what makes it a link, so a log that
 * points at a foreign execution (a corrupted or forged `EXECUTION_CONTINUED`, a squatter at the
 * deterministic id) is never walked into, cancelled through, or leaked.
 */
export function isVerifiedSuccessor(
  prev: EventEnvelope,
  prevId: string,
  next: EventEnvelope | undefined,
  nextId: string
): boolean {
  if (next === undefined || next.sequence !== 0 || next.eventType !== "EXECUTION_STARTED") {
    return false;
  }
  const from = (next.payload as { continuedFrom?: { executionId?: unknown } } | null | undefined)
    ?.continuedFrom;
  if (from?.executionId !== prevId) return false;
  const chain = chainOfFirstEnvelope(prev, prevId);
  const own = chainOfFirstEnvelope(next, nextId);
  if (own.chainId !== chain.chainId || own.generation !== chain.generation + 1) return false;
  if (nextId !== successorIdOf(chain.chainId, chain.generation)) return false;
  return sameLineage(prev, next);
}

/**
 * Do two sequence 0s record the same `parent` lineage and the same owner (principal)? A shredded or
 * malformed principal cannot be compared and never blocks. Used for every hop and for the check that
 * a routed-to generation belongs to the chain whose first id the caller addressed.
 */
export function sameLineage(a: EventEnvelope, b: EventEnvelope): boolean {
  if (parentOfSeq0(a) !== parentOfSeq0(b)) return false;
  const pa = principalKeyOf(a);
  const pb = principalKeyOf(b);
  return pa === undefined || pb === undefined || pa === pb;
}
