import type { EventEnvelope } from "@loom/core";
import type { ExecutionFrame, ExecutionState, SuspendWait } from "@loom/core";

type Handler = (state: ExecutionState, event: EventEnvelope) => ExecutionState;

// Copy-on-write a single frame into the frames container, with per-fold ownership
// (mirrors `appendAudit` below). The first step event of a fold pass spreads the
// caller's input container once — O(S) key refs, untouched frames shared — and marks
// the result fold-owned; every later step event in the same pass writes in place onto
// that owned container (O(1)). `foldEvents` resets ownership at the start of each call,
// and the input state (snapshot / prior state) is never mutated, so copy-on-write —
// and the async snapshot saves that hold prior states — are preserved. Byte-identical
// output; per-replay frame allocations drop from O(S²) to O(S). Handlers never mutate a
// frame in place; they always write a new frame object, so sharing untouched frames is safe.
//
// Uses the assignment form (`frames[stepId] = frame`), so reserved keys must be rejected
// (see assertSafeKey) — unlike a computed-key object literal, `frames["__proto__"] = …`
// would invoke the prototype setter and corrupt this execution's own fold.
function setFrame(
  frames: Record<string, ExecutionFrame>,
  stepId: string,
  frame: ExecutionFrame
): Record<string, ExecutionFrame> {
  assertSafeKey(stepId);
  if (foldOwned.has(frames)) {
    frames[stepId] = frame;
    return frames;
  }
  const next = { ...frames, [stepId]: frame };
  foldOwned.add(next);
  return next;
}

// Defense-in-depth: reject prototype-related keys as fold container keys. They are never
// valid stepIds/decisionIds, and the assignment form (`frames[key] = …`) would otherwise
// invoke the prototype setter / shadow `constructor` and corrupt that execution's own fold.
// (No global pollution is reachable — see the audit — but fail-closed on a reserved key is
// cheap and clear.)
const RESERVED_FOLD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function assertSafeKey(key: string): void {
  if (RESERVED_FOLD_KEYS.has(key)) {
    throw new Error(`fold: reserved key "${key}" is not a valid identifier`);
  }
}

// ── O(1)-amortized audit-list append (per-fold ownership) ────────────────────
//
// The audit handlers below append to durable lists (`_outcomes`, `_timers`, …). A naive
// `[...existing, item]` per event makes a full-log fold O(k²) for k events of one type.
// Instead we track the arrays THIS fold pass created in `foldOwned` and push in place onto
// those, copying only when the array came from the caller's input state (snapshot / prior
// state) — which we must never mutate. `foldEvents` resets the set at the start of every
// call; folding is synchronous and non-reentrant, so a module-level set is safe, and the
// returned state's arrays are always fold-owned (never aliased into the input). Output is
// byte-identical; only intermediate allocations drop from O(k²) to O(k).
let foldOwned = new WeakSet<object>();

export function resetFoldOwnership(): void {
  foldOwned = new WeakSet<object>();
}

/**
 * R1a — install the ownership set a fold pass writes against. A one-shot fold (`foldEvents`
 * with no set) starts empty every call. A LIVE fold (`ReplayVM.applyEvent`) hands in the set
 * its VM keeps between commits, so containers the VM itself created stay writable in place
 * across commits (O(1) per event) instead of being re-copied by every single-event fold
 * (O(size) per event — quadratic over a run). The VM must drop the set the moment it lets a
 * state escape to a caller (`ReplayVM.getState`), so an escaped state is never written to.
 * Folding is synchronous and non-reentrant, so swapping the module-level reference is safe.
 */
export function useFoldOwnership(owned: WeakSet<object>): void {
  foldOwned = owned;
}

function appendAudit<T>(existing: T[] | undefined, item: T): T[] {
  if (existing !== undefined && foldOwned.has(existing)) {
    existing.push(item);
    return existing;
  }
  const next = existing === undefined ? [item] : [...existing, item];
  foldOwned.add(next);
  return next;
}

// ── 1.19.0 (ADR 0102) — `_flowEmits`: stamped flow-level emits counted per digest ──
//
// Shape: a fixed-depth, 16-way trie over the digest's LAST three hex digits (FNV-1a's
// best-mixed bits). Inner nodes are 16-slot arrays (`null` = empty), leaves are
// `{ [digest]: count }`:
//
//   _flowEmits[hex(d[15])][hex(d[14])][hex(d[13])][d] = count
//
// Why a trie and not a flat `{ [digest]: count }`: a live commit is its own fold pass, so
// copy-on-write must copy what it touches, and a flat map costs O(k) per emit (worse in
// practice: a many-key object is a dictionary, and its spread is slow). The trie copies
// the root-to-leaf path — three 16-slot arrays (`slice`, no hidden-class churn) plus one
// leaf of ~k/4096 entries — O(1) for any realistic k, still plain JSON (it rides snapshots
// and survives `truncatePrefix` compaction), and O(1) amortized within a multi-event
// replay pass, where fold-owned nodes are updated in place (`appendAudit`'s ownership
// rule). Size is one leaf entry per DISTINCT stamped emit plus the touched inner arrays.
export const FLOW_EMIT_DIGEST = /^[0-9a-f]{16}$/;
export type FlowEmitLeaf = Record<string, number>;
/** A 16-slot inner node of the `_flowEmits` trie; the third level holds leaves. */
export type FlowEmitCounts = Array<FlowEmitCounts | FlowEmitLeaf | null>;
const TRIE_PATH = [15, 14, 13] as const;

function ownedNode(existing: FlowEmitCounts | null | undefined): FlowEmitCounts {
  if (existing != null && foldOwned.has(existing)) return existing;
  const next: FlowEmitCounts = existing == null ? new Array(16).fill(null) : existing.slice();
  foldOwned.add(next);
  return next;
}

function ownedLeaf(existing: FlowEmitLeaf | null | undefined): FlowEmitLeaf {
  if (existing != null && foldOwned.has(existing)) return existing;
  const next: FlowEmitLeaf = existing == null ? {} : { ...existing };
  foldOwned.add(next);
  return next;
}

export function countFlowEmit(
  variables: Record<string, unknown>,
  digest: string
): Record<string, unknown> {
  const root = variables._flowEmits as FlowEmitCounts | undefined;
  const nextRoot = ownedNode(root);
  const a = Number.parseInt(digest[15] as string, 16);
  const b = Number.parseInt(digest[14] as string, 16);
  const c = Number.parseInt(digest[13] as string, 16);
  const mid = ownedNode(nextRoot[a] as FlowEmitCounts | null);
  nextRoot[a] = mid;
  const low = ownedNode(mid[b] as FlowEmitCounts | null);
  mid[b] = low;
  const leaf = ownedLeaf(low[c] as FlowEmitLeaf | null);
  low[c] = leaf;
  leaf[digest] = (leaf[digest] ?? 0) + 1;
  // A fold-owned root is already inside a fold-created `variables`; only a fresh root
  // needs a new `variables` object (never mutate the caller's).
  return nextRoot === root ? variables : { ...variables, _flowEmits: nextRoot };
}

/** How many stamped flow-level emits with this digest the folded log holds. */
export function flowEmitCount(variables: Record<string, unknown>, digest: string): number {
  let node: unknown = variables._flowEmits;
  for (const i of TRIE_PATH) {
    if (!Array.isArray(node)) return 0;
    node = node[Number.parseInt(digest[i] as string, 16)];
  }
  if (node == null || typeof node !== "object" || !Object.hasOwn(node, digest)) return 0;
  const count = (node as FlowEmitLeaf)[digest];
  return typeof count === "number" ? count : 0;
}

/**
 * 1.20.0 (ADR 0104) — a `null` EXECUTION_RESUMED that answers no suspend point re-opens the
 * execution and records NO gate passthrough. The kernel writes one on `resumeAs` onto a
 * terminal execution and on an in-doubt verdict (whose answer is recorded as a decision):
 * `null` because every store round-trips it (SQLite's payload column is NOT NULL, so an
 * absent payload cannot be written). Keyed on the state being answered, not on `null` alone,
 * so a caller's `null` approval of a real gate is still that gate's answer. The one pre-0104 log
 * this changes is one where a caller resumed `null` into either position: that entry answered
 * no suspend point and would have been served to the NEXT gate as `null` — the stray this fixes.
 */
const IN_DOUBT_GATE = "EffectInDoubtResolved";

/**
 * 1.21.0 (ADR 0105) — reserved fold key: `true` while the execution is PARKED and a
 * `STEP_FAILED` has landed since it parked (a parallel sibling failing after the flow reached
 * its gate). Set only by that event in that state; removed by whatever ends the park — the next
 * `EXECUTION_SUSPENDED` or `EXECUTION_RESUMED`, or a terminal `EXECUTION_COMPLETED` /
 * `_FAILED` / `_CANCELLED`; absent otherwise, so a log without such a failure never gains it.
 *
 * It exists to keep one rule the 1.20.0 fold had implicitly. 1.20.0 folded that failure to
 * "failed", so a following `null` resume was status-only (it answered no gate, and a 1.20.0
 * `resumeAs` wrote exactly that). Since 1.21.0 the execution stays `suspended`; without this
 * key the same `null` would become the gate's answer, and a replay's outcome would depend on
 * whether it was seeded from a 1.20.0 snapshot — breaking snapshot + tail ≡ full log. So a
 * `null` resume in this position stays status-only (fail-closed: the gate re-parks rather than
 * passing without an approval). The cost: a caller's explicit `null` answer to such a gate is
 * not recorded as its answer; the gate re-parks and takes the next non-null one.
 */
export const FAILED_WHILE_PARKED = "_failedWhileParked";

function isStatusOnlyResume(state: ExecutionState, payload: unknown): boolean {
  return (
    payload === null &&
    (state.status !== "suspended" ||
      state.suspendedOn?.on === IN_DOUBT_GATE ||
      state.variables[FAILED_WHILE_PARKED] === true)
  );
}

/** `variables` without the {@link FAILED_WHILE_PARKED} key (the same object when absent). */
function withoutFailedWhileParked(variables: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(variables, FAILED_WHILE_PARKED)) return variables;
  const { [FAILED_WHILE_PARKED]: _cleared, ...rest } = variables;
  return rest;
}

// ── 1.23.0 (Wave 2, W2-0) — reserved shapes, folded only from what the kernel wrote ──────────
//
// The new kinds (`EXECUTION_CONTINUED`, `MESSAGE_CONSUMED`) and the PARALLEL_COMPLETED payload
// fold ONLY an envelope carrying `metadata.kernel === true`. An application event that already
// carries one of those names in an existing log therefore folds as the no-op it always was
// (byte-identically), even though a handler now exists and no kernel writer does yet (ADR 0110
// "Marker"; design §3). The journal stamps the marker for {@link KERNEL_STAMPED_EVENT_TYPES}.
// Four more shapes ride the same stamp but are stamped by their WRITER through commit
// `opts.metadata` (the kind also has an unstamped, userspace form, so the journal cannot stamp by
// type): a wait-addressed EXECUTION_RESUMED (ADR 0110 D3), an EXECUTION_SUSPENDED carrying
// `condition.waits` (D4 — the R2 writer adds `waits` AFTER the commit site's strip and stamps
// the event; an unstamped park's `waits` is dropped by the fold), and an OUTCOME_RECORDED
// carrying `recordedBy` / `late` (ADR 0116; the `recordOutcome` writer).

/** Kinds whose fold requires the kernel stamp, and which the journal stamps when it writes one. */
export const KERNEL_STAMPED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "EXECUTION_CONTINUED",
  "MESSAGE_CONSUMED",
  "PARALLEL_COMPLETED",
]);

function isKernelWritten(event: EventEnvelope): boolean {
  return event.metadata?.kernel === true;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Every inbox dedupe window the fold keeps is capped here; the runtime may apply a smaller one. */
export const INBOX_DEDUPE_CAP = 1024;
/** ADR 0115 D2 — custom metering dimension names, count and per-value ceiling. */
export const CUSTOM_DIMENSION_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
export const CUSTOM_DIMENSION_MAX = 32;
export const CUSTOM_DIMENSION_CEILING = 1e15;

/** A fold-owned copy-on-write record (the same ownership rule as `_decisions`). */
function ownedRecord<T>(prior: Record<string, T> | undefined): Record<string, T> {
  if (prior !== undefined && foldOwned.has(prior)) return prior;
  const next: Record<string, T> = prior === undefined ? {} : { ...prior };
  foldOwned.add(next);
  return next;
}

function safeMapKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && !RESERVED_FOLD_KEYS.has(key);
}

/**
 * ADR 0115 D2 — add the valid entries of a `custom` metering map onto the running one. Never
 * throws: a bad name, a prototype name, a non-finite / negative / over-ceiling value, or the
 * 33rd distinct name is skipped deterministically and the rest folds, so every replica folds the
 * same state from a log it did not write the guard for. Returns `prior` when nothing changed.
 */
function addCustomDimensions(
  prior: Record<string, number> | undefined,
  raw: unknown
): Record<string, number> | undefined {
  if (!isPlain(raw)) return prior;
  let next: Record<string, number> | undefined;
  let names = prior === undefined ? 0 : Object.keys(prior).length;
  for (const [name, v] of Object.entries(raw)) {
    if (!CUSTOM_DIMENSION_PATTERN.test(name) || RESERVED_FOLD_KEYS.has(name)) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > CUSTOM_DIMENSION_CEILING) {
      continue;
    }
    const known = (next ?? prior) !== undefined && Object.hasOwn((next ?? prior) as object, name);
    if (!known) {
      if (names >= CUSTOM_DIMENSION_MAX) continue;
      names++;
    }
    next ??= { ...prior };
    next[name] = (Object.hasOwn(next, name) ? (next[name] as number) : 0) + v;
  }
  return next ?? prior;
}

/** A validated `_resources` seed from `continuedFrom.carried.resources`; invalid parts are ignored. */
function seedResources(raw: unknown): Record<string, unknown> | undefined {
  if (!isPlain(raw)) return undefined;
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
  const custom = addCustomDimensions(undefined, raw.custom);
  const memBytes = num(raw.memBytes);
  const wallMs = num(raw.wallMs);
  const netBytes = num(raw.netBytes);
  // A quota denial survives a rotation: the successor of an execution that exceeded its budget
  // starts exceeded, with the reason it was given (a continue-as-new cannot reset a quota).
  const exceeded = raw.exceeded === true;
  const reason = exceeded && typeof raw.reason === "string" ? raw.reason : undefined;
  return {
    tokens: num(raw.tokens),
    costUsd: num(raw.costUsd),
    ms: num(raw.ms),
    count: num(raw.count),
    ...(memBytes > 0 && { memBytes }),
    ...(wallMs > 0 && { wallMs }),
    ...(netBytes > 0 && { netBytes }),
    ...(custom !== undefined && { custom }),
    ...(exceeded && { exceeded: true }),
    ...(reason !== undefined && { reason }),
  };
}

/** A validated `_inbox` seed from `continuedFrom.carried.inbox`; invalid parts are ignored. */
function seedInbox(
  raw: unknown
): { cursors: Record<string, number>; dedupe: string[] } | undefined {
  if (!isPlain(raw)) return undefined;
  const cursors: Record<string, number> = {};
  if (isPlain(raw.cursors)) {
    for (const [topic, seq] of Object.entries(raw.cursors)) {
      if (safeMapKey(topic) && Number.isSafeInteger(seq) && (seq as number) >= 0) {
        cursors[topic] = seq as number;
      }
    }
  }
  const dedupe = Array.isArray(raw.dedupe)
    ? raw.dedupe.filter((id): id is string => typeof id === "string").slice(-INBOX_DEDUPE_CAP)
    : [];
  return { cursors, dedupe };
}

/** The chain identity a `forkChain` stamp or the start payload names; `undefined` if malformed. */
function chainIdentity(v: unknown): { chainId: string; generation: number } | undefined {
  if (!isPlain(v)) return undefined;
  const { chainId, generation } = v;
  if (typeof chainId !== "string" || chainId.length === 0) return undefined;
  if (!Number.isSafeInteger(generation) || (generation as number) < 0) return undefined;
  return { chainId, generation: generation as number };
}

/** ADR 0110 D3 — a wait-addressed resume: kernel-stamped, payload `{ waitId, payload }`. */
type WaitResume =
  | { answer: true; waitId: string; wait: SuspendWait; inner: unknown }
  | { answer: false };
function parseWaitResume(state: ExecutionState, event: EventEnvelope): WaitResume | undefined {
  if (!isKernelWritten(event)) return undefined;
  const p = event.payload;
  if (!isPlain(p) || typeof p.waitId !== "string" || !Object.hasOwn(p, "payload")) {
    return undefined;
  }
  // The table is the fold-owned `suspendedOn.waits`: it exists ONLY when the park was a
  // kernel-stamped EXECUTION_SUSPENDED (the handler drops `waits` from an unstamped one), and
  // holds only well-formed entries, so a userspace park can never be answered as a multi-wait.
  // Total: a non-array or malformed entry is skipped, never thrown.
  const table: unknown = state.status === "suspended" ? state.suspendedOn?.waits : undefined;
  const wait = Array.isArray(table)
    ? (table as unknown[]).find((w): w is SuspendWait => isPlain(w) && w.waitId === p.waitId)
    : undefined;
  if (wait === undefined || !safeMapKey(p.waitId)) return { answer: false };
  return { answer: true, waitId: p.waitId, wait, inner: p.payload };
}

const handlers: Record<string, Handler> = {
  EXECUTION_STARTED: (state, event) => {
    // `flowHash` (K11.1, additive — absent on legacy logs) is the content hash
    // of the flow code this execution started under; resume/recovery compares
    // it against the registered flow so changed code never silently folds an
    // in-flight log. Reserved fold key: `variables._flowHash`.
    //
    // 1.23.0 (Wave 2) — further additive fields, each folded to a reserved key and each absent
    // from every older log: `principal` → `_principal` (ADR 0111; a fork's `forkedBy` stamp
    // wins), `parent` → `_parent`, `chainId` + `generation` (+ `continuedFrom`) → `_chain`
    // (ADR 0109; a fork's `forkChain` stamp wins and drops `continuedFrom`), `codeHash` →
    // `_codeHash` (ADR 0113). A successor's validated `continuedFrom.carried` seeds `_resources`
    // and `_inbox` (never for a fork, which starts a fresh chain); an invalid carry is ignored,
    // never thrown.
    const payload = event.payload as {
      input?: unknown;
      flowHash?: string;
      principal?: unknown;
      parent?: unknown;
      chainId?: unknown;
      generation?: unknown;
      continuedFrom?: unknown;
      codeHash?: unknown;
    };
    const meta = event.metadata;
    const vars: Record<string, unknown> = {};
    if (payload.input !== undefined) vars._input = payload.input;
    if (payload.flowHash !== undefined) vars._flowHash = payload.flowHash;
    const principal = isPlain(meta?.forkedBy) ? meta.forkedBy : payload.principal;
    if (isPlain(principal)) vars._principal = principal;
    if (typeof payload.parent === "string" && payload.parent.length > 0) {
      vars._parent = payload.parent;
    }
    const forkChain = chainIdentity(meta?.forkChain);
    let carriedFrom: Record<string, unknown> | undefined;
    const own = forkChain ?? chainIdentity(payload);
    if (own !== undefined) {
      const from = payload.continuedFrom;
      const continuedFrom =
        forkChain === undefined &&
        isPlain(from) &&
        typeof from.executionId === "string" &&
        (from.carried === undefined || isPlain(from.carried))
          ? {
              executionId: from.executionId,
              ...(from.carried !== undefined && { carried: from.carried }),
            }
          : undefined;
      vars._chain = { ...own, ...(continuedFrom !== undefined && { continuedFrom }) };
      carriedFrom = continuedFrom?.carried as Record<string, unknown> | undefined;
    }
    if (typeof payload.codeHash === "string") vars._codeHash = payload.codeHash;
    const resources = seedResources(carriedFrom?.resources);
    if (resources !== undefined) vars._resources = resources;
    const inbox = seedInbox(carriedFrom?.inbox);
    if (inbox !== undefined) vars._inbox = inbox;
    return {
      ...state,
      status: "running",
      startedAt: event.timestamp,
      updatedAt: event.timestamp,
      ...(Object.keys(vars).length > 0 && { variables: { ...state.variables, ...vars } }),
    };
  },

  STEP_STARTED: (state, event) => {
    const payload = event.payload as { stepId: string; input?: unknown };
    const existing = state.frames[payload.stepId];
    const frame: ExecutionFrame = {
      stepId: payload.stepId,
      status: "running",
      attempts: (existing?.attempts ?? 0) + 1,
      startedAt: event.timestamp,
      // K8.3 — the first attempt's logged start survives re-runs, so deadlines
      // anchored here are never reset by crash recovery.
      firstStartedAt: existing?.firstStartedAt ?? existing?.startedAt ?? event.timestamp,
      ...(payload.input !== undefined && { input: payload.input }),
    };
    return {
      ...state,
      frames: setFrame(state.frames, payload.stepId, frame),
      updatedAt: event.timestamp,
    };
  },

  STEP_COMPLETED: (state, event) => {
    const payload = event.payload as { stepId: string; output?: unknown };
    const existing = state.frames[payload.stepId];
    const frame: ExecutionFrame = {
      stepId: payload.stepId,
      status: "completed",
      attempts: existing?.attempts ?? 1,
      completedAt: event.timestamp,
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.firstStartedAt !== undefined && { firstStartedAt: existing.firstStartedAt }),
      ...(existing?.input !== undefined && { input: existing.input }),
      ...(payload.output !== undefined && { output: payload.output }),
    };
    return {
      ...state,
      frames: setFrame(state.frames, payload.stepId, frame),
      updatedAt: event.timestamp,
    };
  },

  STEP_FAILED: (state, event) => {
    const payload = event.payload as {
      stepId: string;
      error?: unknown;
      // DE-4 (1.17.0) — present only for typed failures on a DECLARED channel;
      // absence folds byte-identically to pre-1.17 logs (K5 payload-extension rule).
      channel?: string;
      payload?: unknown;
    };
    const existing = state.frames[payload.stepId];
    const frame: ExecutionFrame = {
      stepId: payload.stepId,
      status: "failed",
      attempts: existing?.attempts ?? 1,
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.firstStartedAt !== undefined && { firstStartedAt: existing.firstStartedAt }),
      ...(existing?.input !== undefined && { input: existing.input }),
      ...(payload.error !== undefined && { error: payload.error }),
      ...(payload.channel !== undefined && {
        errorChannel: payload.channel,
        errorPayload: payload.payload,
      }),
    };
    // ADR 0105 — the STEP failed, not the execution: leave execution `status` alone. A flow
    // may catch the throw (try/catch, a saga compensation, a typed-failure fallback) and carry
    // on; folding "failed" here made a live execution read terminal, so a crash after the
    // catch was never re-driven and `cancel` refused it. A failure that escapes the runner is
    // recorded by the EXECUTION_FAILED the kernel commits after it, which owns the terminal
    // status (as EXECUTION_CANCELLED does for STEP_CANCELLED below). A failure that lands while
    // the execution is parked (a parallel sibling) marks FAILED_WHILE_PARKED — see there.
    const parked = state.status === "suspended" && state.variables[FAILED_WHILE_PARKED] !== true;
    return {
      ...state,
      frames: setFrame(state.frames, payload.stepId, frame),
      ...(parked && { variables: { ...state.variables, [FAILED_WHILE_PARKED]: true } }),
      updatedAt: event.timestamp,
    };
  },

  STEP_CANCELLED: (state, event) => {
    // Marks the in-flight step as cancelled WITHOUT touching execution status —
    // the surrounding EXECUTION_CANCELLED event owns the execution-level status,
    // and this must not overwrite it back to a failure/other state.
    const payload = event.payload as { stepId: string };
    const existing = state.frames[payload.stepId];
    const frame: ExecutionFrame = {
      stepId: payload.stepId,
      status: "cancelled",
      attempts: existing?.attempts ?? 1,
      ...(existing?.startedAt !== undefined && { startedAt: existing.startedAt }),
      ...(existing?.firstStartedAt !== undefined && { firstStartedAt: existing.firstStartedAt }),
      ...(existing?.input !== undefined && { input: existing.input }),
    };
    return {
      ...state,
      frames: setFrame(state.frames, payload.stepId, frame),
      updatedAt: event.timestamp,
    };
  },

  STEP_RETRYING: (state, event) => {
    const payload = event.payload as { stepId: string; attempt: number };
    const existing = state.frames[payload.stepId];
    const frame: ExecutionFrame = {
      stepId: payload.stepId,
      status: "pending",
      attempts: payload.attempt,
      ...(existing?.input !== undefined && { input: existing.input }),
    };
    return {
      ...state,
      frames: setFrame(state.frames, payload.stepId, frame),
      updatedAt: event.timestamp,
    };
  },

  PARALLEL_STARTED: (state, event) => {
    const payload = event.payload as { stepIds: string[] };
    // One fresh container, then write each new frame into it (the container is
    // not shared, so in-place writes are safe). Mark it fold-owned so subsequent
    // step events in the same fold pass mutate it in place instead of re-spreading.
    const frames = { ...state.frames };
    foldOwned.add(frames);
    for (const stepId of payload.stepIds) {
      assertSafeKey(stepId);
      frames[stepId] = {
        stepId,
        status: "pending",
        attempts: 0,
        startedAt: event.timestamp,
      };
    }
    return { ...state, frames, updatedAt: event.timestamp };
  },

  // 1.23.0 (ADR 0112 D2) — the journaled fail-fast scope outcome. Folds `_scopes[scopePath]` ONLY
  // from a kernel-stamped envelope; an unstamped one keeps the pre-1.23.0 behaviour (no variable
  // change, `updatedAt` only), so a log that already holds such an event replays identically.
  PARALLEL_COMPLETED: (state, event) => {
    if (!isKernelWritten(event)) return { ...state, updatedAt: event.timestamp };
    const p = event.payload as {
      scopePath?: unknown;
      failedBranch?: unknown;
      error?: unknown;
      cancelled?: unknown;
    };
    if (!isPlain(p) || !safeMapKey(p.scopePath)) return { ...state, updatedAt: event.timestamp };
    const scopes = ownedRecord(state.variables._scopes as Record<string, unknown> | undefined);
    scopes[p.scopePath] = {
      ...(typeof p.failedBranch === "number" && { failedBranch: p.failedBranch }),
      ...(p.error !== undefined && { error: p.error }),
      cancelled: Array.isArray(p.cancelled)
        ? p.cancelled.filter((id): id is string => typeof id === "string")
        : [],
    };
    return {
      ...state,
      variables: { ...state.variables, _scopes: scopes },
      updatedAt: event.timestamp,
    };
  },

  // 1.23.0 (ADR 0109 D2) — the predecessor of a continue-as-new ends, naming its successor. A NEW
  // terminal status, `continued` (never `completed`: there is no output), and `_continuedTo`.
  // Kernel-stamped envelopes only; an unstamped one is the no-op an unknown kind always was.
  EXECUTION_CONTINUED: (state, event) => {
    if (!isKernelWritten(event)) return state;
    const p = event.payload as { successorId?: unknown };
    if (!isPlain(p) || typeof p.successorId !== "string" || p.successorId.length === 0) {
      return state;
    }
    return {
      ...state,
      status: "continued",
      variables: { ...withoutFailedWhileParked(state.variables), _continuedTo: p.successorId },
      updatedAt: event.timestamp,
    };
  },

  // 1.23.0 (ADR 0110 D5/D6) — the owner consumed an inbox message: the per-topic cursor advances,
  // the bounded dedupe window remembers the id, and the delivered payload answers its wait
  // (`_waitAnswers[waitId]`, first answer wins). A `messageId` already in the window is a
  // duplicate: the cursor advances, nothing is delivered. Kernel-stamped envelopes only.
  MESSAGE_CONSUMED: (state, event) => {
    if (!isKernelWritten(event)) return state;
    const p = event.payload as {
      waitId?: unknown;
      topic?: unknown;
      messageId?: unknown;
      inboxSeq?: unknown;
      payload?: unknown;
    };
    if (
      !isPlain(p) ||
      !safeMapKey(p.waitId) ||
      !safeMapKey(p.topic) ||
      typeof p.messageId !== "string" ||
      !Number.isSafeInteger(p.inboxSeq) ||
      (p.inboxSeq as number) < 0
    ) {
      return state;
    }
    const prior = state.variables._inbox as
      | { cursors?: Record<string, number>; dedupe?: string[] }
      | undefined;
    const cursors = ownedRecord(prior?.cursors);
    // Own-property read: a topic named `toString` / `valueOf` must not read a prototype member.
    const was = Object.hasOwn(cursors, p.topic) ? (cursors[p.topic] as number) : -1;
    cursors[p.topic] = Math.max(was, p.inboxSeq as number);
    const window = prior?.dedupe;
    const duplicate = window?.includes(p.messageId) === true;
    let dedupe = window;
    if (!duplicate) {
      dedupe = appendAudit(window, p.messageId);
      if (dedupe.length > INBOX_DEDUPE_CAP) dedupe.splice(0, dedupe.length - INBOX_DEDUPE_CAP);
    }
    const variables: Record<string, unknown> = {
      ...state.variables,
      _inbox: { cursors, dedupe: dedupe ?? [] },
    };
    if (!duplicate) {
      const answers = ownedRecord(
        state.variables._waitAnswers as Record<string, unknown> | undefined
      );
      if (!Object.hasOwn(answers, p.waitId)) {
        answers[p.waitId] = { kind: "inbox", name: p.topic, payload: p.payload };
      }
      variables._waitAnswers = answers;
    }
    return { ...state, variables, updatedAt: event.timestamp };
  },

  EXECUTION_SUSPENDED: (state, event) => {
    const payload = event.payload as {
      condition: {
        on: string;
        timeout?: number;
        correlationKey?: string;
        waits?: SuspendWait[];
      };
    };
    let variables = withoutFailedWhileParked(state.variables);
    // 1.23.0 (ADR 0110 D4) — `condition.waits` is honoured ONLY on a kernel-stamped park (the R2
    // writer stamps `metadata.kernel` on every EXECUTION_SUSPENDED that carries waits; the
    // runtime's commit site strips `waits` from every userspace park, so no unstamped event
    // carries them — this is the fold's own guard for a log it did not write). An unstamped
    // park's `waits` is dropped from `suspendedOn` too, so nothing downstream (the wait-addressed
    // resume's lookup, `loom` introspection) can read a table userspace wrote.
    let condition: unknown = payload.condition;
    if (isPlain(condition) && Object.hasOwn(condition, "waits")) {
      const { waits: raw, ...rest } = condition;
      condition = rest;
      if (isKernelWritten(event) && Array.isArray(raw)) {
        const clean = (raw as unknown[]).filter(
          (w): w is SuspendWait =>
            isPlain(w) &&
            safeMapKey(w.waitId) &&
            (w.kind === "gate" || w.kind === "inbox" || w.kind === "timer")
        );
        condition = { ...rest, waits: clean };
        // A timer arm's `wakeAt` is recorded at its FIRST registration and served on every
        // later one, so sibling traffic cannot push a deadline out.
        let recorded: Record<string, unknown> | undefined;
        for (const w of clean) {
          if (w.kind !== "timer") continue;
          if (typeof w.wakeAt !== "number" || !Number.isFinite(w.wakeAt)) continue;
          recorded ??= ownedRecord(variables._waits as Record<string, unknown> | undefined);
          if (!Object.hasOwn(recorded, w.waitId)) {
            recorded[w.waitId] = { kind: "timer", wakeAt: w.wakeAt };
          }
        }
        if (recorded !== undefined) variables = { ...variables, _waits: recorded };
      }
    }
    return {
      ...state,
      status: "suspended",
      suspendedOn: condition as typeof payload.condition,
      ...(variables !== state.variables && { variables }),
      updatedAt: event.timestamp,
    };
  },

  EXECUTION_RESUMED: (state, event) => {
    const { suspendedOn: _removed, ...rest } = state;
    // 1.23.0 (ADR 0110 D3) — a wait-addressed resume answers ONE wait of a multi-wait park: its
    // payload is `{ waitId, payload }` and the fold unwraps it into `_waitAnswers[waitId]`
    // (kind and name from the park's wait; first answer wins) and drops the wait's pinned
    // `_waits` entry. It never enters the positional `_resumePayloads` (the two mechanisms do
    // not share entries). One naming no wait of the current park is a status-only re-open.
    const addressed = parseWaitResume(state, event);
    if (addressed !== undefined) {
      const variables = { ...withoutFailedWhileParked(state.variables) };
      if (addressed.answer) {
        const { waitId, wait, inner } = addressed;
        const answers = ownedRecord(variables._waitAnswers as Record<string, unknown> | undefined);
        if (!Object.hasOwn(answers, waitId)) {
          answers[waitId] = {
            kind: wait.kind,
            name: wait.on ?? wait.topic ?? wait.kind,
            payload: inner,
          };
        }
        variables._waitAnswers = answers;
        if (isPlain(variables._waits) && Object.hasOwn(variables._waits, waitId)) {
          const waits = ownedRecord(variables._waits as Record<string, unknown>);
          delete waits[waitId];
          variables._waits = waits;
        }
      }
      return { ...rest, status: "running", variables, updatedAt: event.timestamp };
    }
    return {
      ...rest,
      status: "running",
      variables: {
        ...withoutFailedWhileParked(state.variables),
        ...(event.payload !== undefined &&
          !isStatusOnlyResume(state, event.payload) && {
            // Latest payload (legacy key, kept for compat with pre-1.16 snapshots)…
            _resumePayload: event.payload,
            // …and the ORDERED list of every resume payload (1.16.0): a flow with
            // N suspend gates passes gate i through with payload i on replay —
            // the single-latest key silently fed gate 1 the LAST gate's payload.
            _resumePayloads: appendAudit(
              state.variables._resumePayloads as unknown[] | undefined,
              event.payload
            ),
          }),
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.0 (P9) — a durable record of an advisory/optimizer choice. Stored in a
  // reserved `_decisions` map keyed by decisionId so replay serves the recorded
  // choice instead of re-consulting the optimizer, keeping the fold pure (P2).
  DECISION_RECORDED: (state, event) => {
    const payload = event.payload as {
      decisionId: string;
      choice: unknown;
      rationale?: unknown;
      source?: string;
      // D1 (ADR 0030) — descriptive materialization fields; folded verbatim but NEVER
      // read by getDecision, so `choice` remains the sole replay input (P9). Absence = legacy.
      alternatives?: unknown;
      estimatedCostUsd?: number;
      estimatedLatencyMs?: number;
      confidence?: number;
      // ADR 0079 — the observation the policy saw and which policy saw it. Same
      // descriptive contract as the fields above: folded verbatim, never a replay
      // input. Absence = legacy (or a decision no policy produced).
      context?: Record<string, unknown>;
      policy?: { id: string; version: string; propensity?: number };
    };
    assertSafeKey(payload.decisionId);
    // R1a — the decision map is a per-fold-owned container, written in place (the same rule
    // as `setFrame`/`appendAudit`): spreading it per event made a fold of D decisions O(D²)
    // (20k decisions = 42 s). The caller's map (snapshot / prior state / an escaped state) is
    // copied once, then owned. Insertion order is unchanged: a new id appends, a repeated id
    // keeps its slot — exactly what `{ ...existing, [id]: v }` did.
    const prior = state.variables._decisions as Record<string, unknown> | undefined;
    let decisions: Record<string, unknown>;
    if (prior !== undefined && foldOwned.has(prior)) {
      decisions = prior;
    } else {
      decisions = prior === undefined ? {} : { ...prior };
      foldOwned.add(decisions);
    }
    decisions[payload.decisionId] = {
      choice: payload.choice,
      ...(payload.rationale !== undefined && { rationale: payload.rationale }),
      ...(payload.source !== undefined && { source: payload.source }),
      ...(payload.alternatives !== undefined && { alternatives: payload.alternatives }),
      ...(payload.estimatedCostUsd !== undefined && {
        estimatedCostUsd: payload.estimatedCostUsd,
      }),
      ...(payload.estimatedLatencyMs !== undefined && {
        estimatedLatencyMs: payload.estimatedLatencyMs,
      }),
      ...(payload.confidence !== undefined && { confidence: payload.confidence }),
      ...(payload.context !== undefined && { context: payload.context }),
      ...(payload.policy !== undefined && { policy: payload.policy }),
    };
    return {
      ...state,
      variables: { ...state.variables, _decisions: decisions },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.0 (K2) — a capability denial: the EffectRuntime refused an ungranted
  // effect. Recorded as a durable audit fact in a reserved `_denials` list (the
  // step itself still fails via the STEP_FAILED that follows). Pure audit — it does
  // not change frame/execution status.
  EFFECT_DENIED: (state, event) => {
    const payload = event.payload as { toolId: string; stepId?: string; reason?: string };
    return {
      ...state,
      variables: {
        ...state.variables,
        _denials: appendAudit(state.variables._denials as unknown[] | undefined, {
          toolId: payload.toolId,
          ...(payload.stepId !== undefined && { stepId: payload.stepId }),
          ...(payload.reason !== undefined && { reason: payload.reason }),
        }),
      },
      updatedAt: event.timestamp,
    };
  },

  // C.1 (execution-lifecycle authz) — an EXECUTION_DENIED fact: an ExecutionAuthorizer
  // refused a lifecycle operation (resume/cancel) on an existing execution. Recorded as
  // a durable audit fact in a reserved `_executionDenials` list, symmetric to
  // EFFECT_DENIED (which gates effects). Pure audit — the op is refused by a thrown
  // error; this fold does not change frame/execution status.
  EXECUTION_DENIED: (state, event) => {
    const payload = event.payload as { op: string; reason?: string; actor?: string };
    return {
      ...state,
      variables: {
        ...state.variables,
        _executionDenials: appendAudit(state.variables._executionDenials as unknown[] | undefined, {
          op: payload.op,
          ...(payload.reason !== undefined && { reason: payload.reason }),
          ...(payload.actor !== undefined && { actor: payload.actor }),
        }),
      },
      updatedAt: event.timestamp,
    };
  },

  // K10.1 (R5) — retention control facts on a dedicated lifecycle stream. When
  // `applyRetention` archives or deletes a terminal execution it journals the action
  // so the audit trail records its own pruning (P9): the values are gone but the FACT
  // that they were pruned survives. Pure audit into `_lifecycle`; replay is byte-identical
  // for any log that never prunes.
  EXECUTION_ARCHIVED: (state, event) => {
    const p = event.payload as { executionId: string };
    return {
      ...state,
      variables: {
        ...state.variables,
        _lifecycle: appendAudit(state.variables._lifecycle as unknown[] | undefined, {
          op: "archived",
          executionId: p.executionId,
          at: event.timestamp,
        }),
      },
      updatedAt: event.timestamp,
    };
  },
  EXECUTION_DELETED: (state, event) => {
    const p = event.payload as { executionId: string };
    return {
      ...state,
      variables: {
        ...state.variables,
        _lifecycle: appendAudit(state.variables._lifecycle as unknown[] | undefined, {
          op: "deleted",
          executionId: p.executionId,
          at: event.timestamp,
        }),
      },
      updatedAt: event.timestamp,
    };
  },
  // ADR 0107 — an operator repair re-homed events the pre-0106 compaction bug had written to
  // the blank execution `""` into the execution they belong to. Journaled on the lifecycle
  // stream beside the retention facts (P9): the log records its own repair. Pure audit into
  // `_lifecycle`; a log that is never repaired replays byte-identically.
  EVENTS_REHOMED: (state, event) => {
    const p = event.payload as {
      executionId: string;
      fromSequence: number;
      throughSequence: number;
      proof: string;
    };
    return {
      ...state,
      variables: {
        ...state.variables,
        _lifecycle: appendAudit(state.variables._lifecycle as unknown[] | undefined, {
          op: "rehomed",
          executionId: p.executionId,
          fromSequence: p.fromSequence,
          throughSequence: p.throughSequence,
          proof: p.proof,
          at: event.timestamp,
        }),
      },
      updatedAt: event.timestamp,
    };
  },
  // T3-R4.5 — an erasure was requested but deferred because an execution of the subject was
  // still live (never shred a fold in flight). Folding the erasure control stream recovers the
  // set of subjects awaiting completion, so a parked erasure survives a restart.
  ERASURE_PENDING: (state, event) => {
    const p = event.payload as { subjectId: string };
    return {
      ...state,
      variables: {
        ...state.variables,
        _erasure: appendAudit(state.variables._erasure as unknown[] | undefined, {
          op: "pending",
          subjectId: p.subjectId,
          at: event.timestamp,
        }),
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.0 (learning seam) — an OUTCOME_RECORDED fact: how a prior choice (a
  // route/capability/tool, by `key`) actually turned out. The symmetric counterpart
  // to DECISION_RECORDED ("what was chosen"): this records "how it went", so
  // @loom/analytics can mine it into a ranking fed back to the router — closing the
  // loop while keeping every future route a logged decision (P9). Folded into a
  // reserved `_outcomes` audit list; pure audit, does not change status.
  OUTCOME_RECORDED: (state, event) => {
    const kernel = isKernelWritten(event);
    const p = event.payload as {
      key: string;
      success?: boolean;
      score?: number;
      decisionId?: string;
      // 1.23.0 (ADR 0116) — written only by `recordOutcome`, which stamps `metadata.kernel`;
      // the fold reads them ONLY from a stamped envelope (a userspace emit is refused by
      // `guardUserspaceEmit`, and a log it did not write is not trusted either). Absent = a
      // live, in-run outcome.
      recordedBy?: string;
      late?: boolean;
    };
    return {
      ...state,
      variables: {
        ...state.variables,
        _outcomes: appendAudit(state.variables._outcomes as unknown[] | undefined, {
          key: p.key,
          ...(p.success !== undefined && { success: p.success }),
          ...(p.score !== undefined && { score: p.score }),
          ...(p.decisionId !== undefined && { decisionId: p.decisionId }),
          ...(kernel && typeof p.recordedBy === "string" && { recordedBy: p.recordedBy }),
          ...(kernel && p.late === true && { late: true }),
        }),
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.0 (K6) — a behavioral-safety block: a safety validator refused an
  // effect's input or output. Recorded as a durable audit fact in a reserved
  // `_safety` list (the step itself still fails via the STEP_FAILED that follows).
  // Pure audit — it does not change frame/execution status, so a blocked run
  // reconstructs its safety verdict exactly on replay.
  SAFETY_BLOCKED: (state, event) => {
    const p = event.payload as {
      validatorId: string;
      stepId?: string;
      phase?: string;
      reason?: string;
      category?: string;
    };
    return {
      ...state,
      variables: {
        ...state.variables,
        _safety: appendAudit(state.variables._safety as unknown[] | undefined, {
          validatorId: p.validatorId,
          ...(p.stepId !== undefined && { stepId: p.stepId }),
          ...(p.phase !== undefined && { phase: p.phase }),
          ...(p.reason !== undefined && { reason: p.reason }),
          ...(p.category !== undefined && { category: p.category }),
        }),
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.1 (K9) — an in-doubt effect: recovery found a tool declared
  // `idempotent: false` whose prior attempt is in an UNKNOWN state (STEP_STARTED
  // with no terminal step event) and refused to silently re-run it. Recorded in a
  // reserved `_indoubt` audit list; the EXECUTION_SUSPENDED that follows owns the
  // status change. Pure audit — replay reconstructs the parking exactly, and the
  // list length per step is the durable epoch for fresh idempotency keys after a
  // "retry-fresh" verdict.
  EFFECT_INDOUBT: (state, event) => {
    const p = event.payload as {
      stepId: string;
      toolId?: string;
      attempts?: number;
      idempotencyKey?: string;
    };
    return {
      ...state,
      variables: {
        ...state.variables,
        _indoubt: appendAudit(state.variables._indoubt as unknown[] | undefined, {
          stepId: p.stepId,
          ...(p.toolId !== undefined && { toolId: p.toolId }),
          ...(p.attempts !== undefined && { attempts: p.attempts }),
          ...(p.idempotencyKey !== undefined && { idempotencyKey: p.idempotencyKey }),
        }),
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.1 (K11.3) — a durable migration verdict: the execution was explicitly
  // resumed on DIFFERENT flow code (resumeAs, replay-check or operator-ack).
  // Re-points the recorded flow-code fingerprint (`_flowHash`) and the flow
  // resolution pointer (`_migratedTo` — the flow id this execution now resolves
  // to; unconditional so the fold never depends on seed identity), and appends
  // an audit entry to the reserved `_migrations` list. Replay re-applies the
  // same verdict at the same sequence (G1).
  EXECUTION_MIGRATED: (state, event) => {
    const p = event.payload as {
      toFlowId: string;
      toHash?: string;
      fromHash?: string;
      strategy?: string;
      migratedInput?: unknown;
    };
    return {
      ...state,
      variables: {
        ...state.variables,
        ...(p.toHash !== undefined && { _flowHash: p.toHash }),
        // K11.5 — contract-versioned state migration: the recorded TRANSFORMED
        // input replaces `_input`, so every later resume/restore/replay folds
        // the same migrated value (the outcome is durable, not the function).
        ...(p.migratedInput !== undefined && { _input: p.migratedInput }),
        _migratedTo: p.toFlowId,
        _migrations: appendAudit(state.variables._migrations as unknown[] | undefined, {
          toFlowId: p.toFlowId,
          ...(p.toHash !== undefined && { toHash: p.toHash }),
          ...(p.fromHash !== undefined && { fromHash: p.fromHash }),
          ...(p.strategy !== undefined && { strategy: p.strategy }),
          ...(p.migratedInput !== undefined && { stateMigrated: true }),
        }),
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.1 (K12) — a VERIFIED approval: a ResumeAuthenticator confirmed the
  // identity behind an authority-gating resume, so "who approved" is durable
  // evidence, not an unverified claim. Folded into a reserved `_approvals`
  // audit list. Pure audit — the accompanying EXECUTION_RESUMED owns the
  // lifecycle; a REJECTED approval never reaches the log (the resume is refused
  // before any event is committed).
  APPROVAL_GRANTED: (state, event) => {
    const p = event.payload as { actor?: string; verifiedBy?: string; on?: string };
    return {
      ...state,
      variables: {
        ...state.variables,
        _approvals: appendAudit(state.variables._approvals as unknown[] | undefined, {
          ...(p.actor !== undefined && { actor: p.actor }),
          ...(p.verifiedBy !== undefined && { verifiedBy: p.verifiedBy }),
          ...(p.on !== undefined && { on: p.on }),
          at: event.timestamp,
        }),
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.1 (K10) — a crypto-shred tombstone: the subject's encryption key was
  // destroyed, so this execution's sensitive payload fields are permanently
  // unrecoverable (GDPR erasure of an append-only log). Written AT SHRED TIME by
  // the lifecycle service (never at replay). Marks `variables._shredded` so the
  // folded state records the erasure; a decrypting store read of the affected
  // fields fails loudly with PayloadShreddedError (the erasure is not silent).
  PAYLOAD_SHREDDED: (state, event) => {
    const p = event.payload as { subjectId?: string; reason?: string };
    return {
      ...state,
      variables: {
        ...state.variables,
        _shredded: {
          ...(p.subjectId !== undefined && { subjectId: p.subjectId }),
          ...(p.reason !== undefined && { reason: p.reason }),
          at: event.timestamp,
        },
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.1 (K7) — an egress denial: the kernel-side broker refused an
  // isolated tool's network target (not in its static allowlist), BEFORE any
  // connection was opened. Folded into a reserved `_egress` audit list,
  // mirroring EFFECT_DENIED's `_denials`. Pure audit — whether the step fails
  // is the tool's error path (an uncaught denial fails via STEP_FAILED).
  EGRESS_DENIED: (state, event) => {
    const p = event.payload as {
      toolId?: string;
      stepId?: string;
      target?: string;
      reason?: string;
    };
    return {
      ...state,
      variables: {
        ...state.variables,
        _egress: appendAudit(state.variables._egress as unknown[] | undefined, {
          ...(p.toolId !== undefined && { toolId: p.toolId }),
          ...(p.stepId !== undefined && { stepId: p.stepId }),
          ...(p.target !== undefined && { target: p.target }),
          ...(p.reason !== undefined && { reason: p.reason }),
        }),
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.1 (T1) — a durable timer fired: the wake that ends a
  // `ctx.sleep`/`sleepUntil` (or a timer-service-backed `suspend({ timeout })`).
  // Pure audit into the reserved `_timers` list — the EXECUTION_RESUMED that
  // accompanies it owns the status change. `wakeAt` is the SCHEDULED time (from
  // the log); `firedAt` (event timestamp) records actual delivery, so drift is
  // observable but never enters control flow.
  TIMER_FIRED: (state, event) => {
    const p = event.payload as { wakeAt?: number; scheduleId?: string; occurrence?: number };
    return {
      ...state,
      variables: {
        ...state.variables,
        _timers: appendAudit(state.variables._timers as unknown[] | undefined, {
          firedAt: event.timestamp,
          ...(p.wakeAt !== undefined && { wakeAt: p.wakeAt }),
          ...(p.scheduleId !== undefined && { scheduleId: p.scheduleId }),
          ...(p.occurrence !== undefined && { occurrence: p.occurrence }),
        }),
      },
      updatedAt: event.timestamp,
    };
  },

  // Loom 2.0 (K3) — accumulate metered resource usage (tokens / cost / wall-time)
  // into a reserved `_resources` running total. Emitted by accounting middleware
  // when an effect actually runs, so the total is deterministic on replay.
  RESOURCE_METERED: (state, event) => {
    const p = event.payload as {
      tokens?: number;
      costUsd?: number;
      ms?: number;
      // ADR 0032 (R1) — additional dimensions, folded additively.
      memBytes?: number;
      wallMs?: number;
      netBytes?: number;
      // 1.23.0 (ADR 0115) — open metering dimensions, folded into `_resources.custom`.
      custom?: unknown;
    };
    const r = (state.variables._resources as
      | {
          tokens: number;
          costUsd: number;
          ms: number;
          count: number;
          memBytes?: number;
          wallMs?: number;
          netBytes?: number;
          custom?: Record<string, number>;
          exceeded?: boolean;
        }
      | undefined) ?? { tokens: 0, costUsd: 0, ms: 0, count: 0 };
    // The new dimensions are included only when non-zero, so a log that never meters
    // them folds to exactly the pre-0032 `_resources` shape (byte-identical replay).
    const memBytes = (r.memBytes ?? 0) + (p.memBytes ?? 0);
    const wallMs = (r.wallMs ?? 0) + (p.wallMs ?? 0);
    const netBytes = (r.netBytes ?? 0) + (p.netBytes ?? 0);
    const custom = addCustomDimensions(r.custom, p.custom);
    return {
      ...state,
      variables: {
        ...state.variables,
        _resources: {
          tokens: r.tokens + (p.tokens ?? 0),
          costUsd: r.costUsd + (p.costUsd ?? 0),
          ms: r.ms + (p.ms ?? 0),
          count: r.count + 1,
          ...(memBytes > 0 && { memBytes }),
          ...(wallMs > 0 && { wallMs }),
          ...(netBytes > 0 && { netBytes }),
          ...(custom !== undefined && { custom }),
          ...(r.exceeded === true && { exceeded: true }),
        },
      },
      updatedAt: event.timestamp,
    };
  },

  // A quota admission-control denial: the execution exceeded its budget, so the
  // effect was refused. Marks `_resources.exceeded` (the STEP_FAILED that follows
  // fails the step). Pure audit.
  QUOTA_EXCEEDED: (state, event) => {
    const p = event.payload as { reason?: string };
    const r = (state.variables._resources as
      | { tokens: number; costUsd: number; ms: number; count: number; exceeded?: boolean }
      | undefined) ?? { tokens: 0, costUsd: 0, ms: 0, count: 0 };
    return {
      ...state,
      variables: {
        ...state.variables,
        _resources: { ...r, exceeded: true, ...(p.reason !== undefined && { reason: p.reason }) },
      },
      updatedAt: event.timestamp,
    };
  },

  // The three terminal handlers also end any open park, so they drop FAILED_WHILE_PARKED
  // (ADR 0105): the mark describes a park, and must not outlive it into a terminal state (where
  // a 1.20.0 snapshot, repaired, would not carry it — snapshot + tail ≡ full log).
  EXECUTION_COMPLETED: (state, event) => {
    const payload = event.payload as { output?: unknown };
    const variables = withoutFailedWhileParked(state.variables);
    return {
      ...state,
      status: "completed",
      ...(payload.output !== undefined
        ? { variables: { ...variables, _output: payload.output } }
        : variables !== state.variables && { variables }),
      updatedAt: event.timestamp,
    };
  },

  EXECUTION_FAILED: (state, event) => {
    const payload = event.payload as { error?: unknown };
    const variables = withoutFailedWhileParked(state.variables);
    return {
      ...state,
      status: "failed",
      ...(payload.error !== undefined
        ? { variables: { ...variables, _error: payload.error } }
        : variables !== state.variables && { variables }),
      updatedAt: event.timestamp,
    };
  },

  EXECUTION_CANCELLED: (state, event) => {
    const payload = event.payload as { reason?: unknown };
    const variables = withoutFailedWhileParked(state.variables);
    return {
      ...state,
      status: "cancelled",
      ...(payload.reason !== undefined
        ? { variables: { ...variables, _cancelReason: payload.reason } }
        : variables !== state.variables && { variables }),
      updatedAt: event.timestamp,
    };
  },
};

export function getHandler(eventType: string): Handler | undefined {
  // `Object.hasOwn`, not plain indexing: `eventType` is caller-controlled all the way from an
  // ingress adapter (`runtime.resume`, and A2A `provideInput` passes a network-supplied
  // ResumeEvent straight through), and `handlers["__proto__"]` resolves up the prototype chain
  // to `Object.prototype` — TRUTHY, so `foldEvents`' `if (handler)` guard admits it and then
  // calls a non-function. An unknown event type must fold to a no-op, whatever it is named.
  if (!Object.hasOwn(handlers, eventType)) return undefined;
  return handlers[eventType];
}

// ── Event-schema ABI governance (Loom 2.0 K5) ────────────────────────────────
//
// The event log is the kernel's on-disk ABI: state is `fold(events)`, and stored
// logs must replay across deploys (this is what `@loom/deploy-sim` guards at the
// flow level). This names and versions the *set of event types the fold understands*.
// Governance: adding an event type is additive (bump MINOR, update the pinned list);
// removing or repurposing one changes how historical logs fold and is a MAJOR break
// that must be deliberate — the conformance test pins `knownEventTypes()`.
// 1.4.0: additive optional `flowHash` payload field on EXECUTION_STARTED (K11.1) —
// per the K5 payload-extension rule, folds treat absence as legacy.
// 1.5.0: added EXECUTION_MIGRATED (K11.3).
// 1.6.0: added TIMER_FIRED (T1 — durable timers).
// 1.7.0: added EGRESS_DENIED (K7 — data-plane isolation & egress control).
// 1.8.0: added PAYLOAD_SHREDDED (K10 — crypto-shredding).
// 1.9.0: added APPROVAL_GRANTED (K12 — verified approvals).
// 1.10.0: additive optional DECISION_RECORDED payload fields `alternatives`,
//   `estimatedCostUsd`, `estimatedLatencyMs`, `confidence` (ADR 0030 D1 — decision
//   materialization). Descriptive only; `getDecision` still returns just `choice`, so
//   folds treat absence as legacy and replay is byte-identical.
// 1.11.0: additive optional RESOURCE_METERED payload fields `memBytes`, `wallMs`,
//   `netBytes` (ADR 0032 R1 — resource dimensions). Folded into `_resources` only when
//   non-zero, so a log that never meters them replays byte-identically.
// 1.12.0: added EXECUTION_DENIED (C.1 — execution-lifecycle authz). Pure audit into
//   `_executionDenials`; a log that never denies replays byte-identically.
// 1.13.0: added EXECUTION_ARCHIVED / EXECUTION_DELETED (K10.1 R5 — retention control
//   facts). Pure audit into `_lifecycle` on a dedicated stream; a log that never prunes
//   replays byte-identically.
// 1.14.0: added ERASURE_PENDING (T3-R4.5 — deferred-erasure control fact). Pure audit into
//   `_erasure` on a dedicated stream; a log that never defers an erasure replays identically.
// 1.15.0: additive optional EXECUTION_MIGRATED payload field `migratedInput` (K11.5,
//   ADR 0056 — contract-versioned state migration on resumeAs). When present it replaces
//   `_input` in the fold and stamps `stateMigrated: true` on the `_migrations` audit
//   entry; a log that never migrates state replays byte-identically.
// 1.16.0: EXECUTION_RESUMED additionally folds `_resumePayloads` — the ORDERED list of
//   every resume payload (ADR 0057). Fixes the multi-gate suspend bug: the single-latest
//   `_resumePayload` (kept for compat) fed gate 1 the LAST gate's payload on replay.
//   Additive fold key from existing events; no payload or kind changes.
// 1.17.0: additive optional STEP_FAILED payload fields `channel`, `payload` (DE-4,
//   ADR 0060 — typed failure channels). Folded into frame `errorChannel`/`errorPayload`;
//   presence makes the execute seam SUBSTITUTE the recorded failure on replay instead of
//   re-executing the step. A log that never fails typed replays byte-identically.
// 1.18.0: additive optional DECISION_RECORDED payload fields `context`, `policy` (T2,
//   ADR 0079 — the observation a policy saw and the policy that saw it, incl. the
//   propensity that makes unbiased off-policy evaluation possible). Same descriptive
//   contract as the 1.10.0 D1 fields: folded verbatim into `_decisions`, NEVER read by
//   getDecision, so `choice` stays the sole replay input. A log whose decisions carry
//   neither field replays byte-identically.
// 1.19.0: additive fold key `_flowEmits` from an additive envelope stamp (ADR 0102 —
//   flow-level emits append once per execution). A flow-level `ctx.emit` / `ctx.stream` /
//   `ctx.ui` envelope may carry `metadata.flowEmit = <16-hex content digest>`; the fold
//   counts stamped emits per digest for ANY event type (a generic step in `foldEvents`,
//   not a handler), so a re-run serves the emits the log already holds. No new kind, no
//   payload change; a log that never stamps replays byte-identically.
// 1.20.0: EXECUTION_RESUMED with a `null` payload that answers no suspend point (the execution
//   was not parked, or was parked in doubt on "EffectInDoubtResolved") re-opens the execution
//   WITHOUT adding a gate passthrough (ADR 0104). Every other resume folds as before, so a log
//   that never carries such a resume replays byte-identically. Also additive: a human step's
//   EXECUTION_SUSPENDED condition carries the kernel-set `stepId` (folded verbatim into
//   `suspendedOn`, as the condition always was). No new event kind.
// 1.21.0: STEP_FAILED no longer folds the EXECUTION status to "failed" (ADR 0105) — the flow may
//   catch it, and EXECUTION_FAILED is the execution's failure. No new kind or payload field; the
//   kernel writes the same events. A STEP_FAILED landing while the execution is parked sets the
//   reserved fold key `_failedWhileParked` (cleared by whatever ends the park), and a `null`
//   EXECUTION_RESUMED in that position stays status-only, exactly as 1.20.0 folded it — so every
//   gate passthrough (`_resumePayloads`) is identical under both. What differs from 1.20.0: the
//   derived `status` after a STEP_FAILED no lifecycle event has followed (`running`/`suspended`,
//   not `failed`), and the new key while such a park is open. Snapshots saved by an older fold
//   are read through `normalizeSnapshotState`.
// 1.22.0: added EVENTS_REHOMED (ADR 0107 — the operator repair of the pre-0106 blank-stream
//   events). Pure audit into `_lifecycle` on the lifecycle stream; a log that is never repaired
//   replays byte-identically. The re-homed events themselves are the kinds they always were.
// 1.23.0: Wave 2 (W2-0, ADRs 0109–0116) — every new fold handler and reserved shape, with no
//   writer yet. New kinds `EXECUTION_CONTINUED` (→ status `continued`, `_continuedTo`) and
//   `MESSAGE_CONSUMED` (→ `_inbox`, `_waitAnswers`); a payload and handler for the existing
//   `PARALLEL_COMPLETED` (→ `_scopes`); additive `EXECUTION_STARTED.{principal, parent, chainId,
//   generation, continuedFrom, codeHash}` (→ `_principal`, `_parent`, `_chain`, `_codeHash`; the
//   carry seeds `_resources` / `_inbox`), `EXECUTION_SUSPENDED.condition.waits[]` (→ `_waits`),
//   a wait-addressed `EXECUTION_RESUMED` `{ waitId, payload }` (→ `_waitAnswers`),
//   `RESOURCE_METERED.custom` (→ `_resources.custom`), `OUTCOME_RECORDED.{recordedBy, late}`.
//   The envelope metadata the fold now reads: `kernel` (the new kinds, `PARALLEL_COMPLETED` and a
//   wait-addressed resume fold ONLY a kernel-stamped envelope), `forkChain`, `forkedBy`. A log
//   carrying none of these replays byte-identically.
export const EVENT_SCHEMA_VERSION = "1.23.0";

export function knownEventTypes(): string[] {
  return Object.keys(handlers).sort();
}
