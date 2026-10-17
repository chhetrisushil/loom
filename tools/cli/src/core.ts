import { maskPaths } from "@loom/classify";
import type { EventEnvelope, ExecutionState } from "@loom/core";
import { recordedStepOutputs, replayAsFixture } from "@loom/eval";

// ── foldAt — time-travel primitive (pure) ─────────────────────────────────────

/**
 * Fold the log up to and including `sequence` (or the whole log when omitted) into
 * its `ExecutionState`. This is `loom debug`'s time-travel step: it reconstructs
 * exactly what the execution looked like at any point, deterministically, with no
 * live effects. Reuses `@loom/eval`'s identity-seeded fold.
 */
export function foldAt(events: EventEnvelope[], sequence?: number): ExecutionState {
  const prefix = sequence === undefined ? events : events.filter((e) => e.sequence <= sequence);
  return replayAsFixture(prefix);
}

// ── makeRedactor — complete egress masking (pure) ─────────────────────────────

const REDACTED_MARK = "[redacted]";
const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function collectStrings(v: unknown, into: Set<string>): void {
  if (typeof v === "string") into.add(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, into);
  else if (isPlain(v)) for (const x of Object.values(v)) collectStrings(x, into);
}

/**
 * The operator's `--redact` dot-paths, applied at EVERY object in a value (the payload, each
 * nested object, each array element) — a cold log carries no flow schemas, so the path cannot
 * be anchored to one known root, and `input`, resume payloads and results leak otherwise.
 * `mask` replaces the values at the paths; the strings it removed are remembered, and `scrub`
 * then removes them from free text (an error message that quotes the secret). Run `mask` over
 * everything first, then `scrub`, so a secret found late still scrubs earlier text.
 */
export function makeRedactor(paths: readonly string[]) {
  const secrets = new Set<string>();
  const mask = <T>(value: T): T => {
    if (paths.length === 0) return value;
    const walk = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(walk);
      if (!isPlain(node)) return node;
      const m = maskPaths(node, paths) as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(m)) {
        if (m[k] === REDACTED_MARK && node[k] !== REDACTED_MARK) {
          collectStrings(node[k], secrets);
          out[k] = REDACTED_MARK;
        } else out[k] = walk(m[k]);
      }
      return out;
    };
    return walk(value) as T;
  };
  const scrub = <T>(value: T): T => {
    const list = [...secrets].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
    if (list.length === 0) return value;
    const walk = (node: unknown): unknown => {
      if (typeof node === "string") {
        let r = node;
        for (const s of list) r = r.split(s).join(REDACTED_MARK);
        return r;
      }
      if (Array.isArray(node)) return node.map(walk);
      if (isPlain(node)) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node)) out[k] = walk(v);
        return out;
      }
      return node;
    };
    return walk(value) as T;
  };
  return { mask, scrub };
}

/** Mask then scrub a whole list of events (secrets found in any event scrub them all). */
export function redactEvents(
  events: EventEnvelope[],
  paths: readonly string[],
  /** Events that are NOT printed (filtered out) but whose secrets must still scrub the ones that are. */
  learnFrom: readonly EventEnvelope[] = []
): EventEnvelope[] {
  if (paths.length === 0) return events;
  const r = makeRedactor(paths);
  for (const e of learnFrom) r.mask(e);
  return events.map(r.mask).map(r.scrub);
}

// ── formatLog / describeState — the `loom logs` + `loom debug` views (pure) ────

const SUSPEND_TYPES = new Set(["EXECUTION_SUSPENDED"]);

// K10-R6 — CLI egress. The CLI reads a cold log with no flow schemas, so it can't derive the
// classification marks; the operator names the sensitive OUTPUT dot-paths explicitly via
// `--redact` (e.g. `--redact ssn,user.token`), masked before anything is printed.
function detailOf(event: EventEnvelope): string {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.eventType) {
    case "STEP_STARTED":
    case "STEP_COMPLETED":
    case "STEP_FAILED":
    case "STEP_CANCELLED":
      return String(p.stepId ?? "");
    case "EXECUTION_SUSPENDED": {
      const on = (p.on ?? (p as { condition?: { on?: string } }).condition?.on) as
        | string
        | undefined;
      return on ? `on ${on}` : "";
    }
    case "EXECUTION_COMPLETED":
      return truncate(JSON.stringify(p.output));
    case "EXECUTION_FAILED":
      return truncate(String(p.error ?? ""));
    case "EXECUTION_CONTINUED":
      return p.successorId === undefined ? "" : `-> ${truncate(String(p.successorId))}`;
    default:
      return "";
  }
}

/** One timeline row: suspend marker, `#seq`, event type, a short detail. */
export function eventLine(e: EventEnvelope): string {
  const marker = SUSPEND_TYPES.has(e.eventType) ? "⏸" : " ";
  const seq = `#${e.sequence}`.padEnd(5);
  const type = e.eventType.padEnd(20);
  return `${marker} ${seq} ${type} ${detailOf(e)}`.trimEnd();
}

/**
 * Pretty-print the event stream as a timeline, marking suspend points. `redact` masks the
 * given output dot-paths (K10-R6) so sensitive fields don't leak to stdout.
 */
export function formatLog(rawEvents: EventEnvelope[], redact: readonly string[] = []): string {
  if (rawEvents.length === 0) return "(no events)";
  return redactEvents(rawEvents, redact).map(eventLine).join("\n");
}

/** Who an event is attributed to: a recorded principal (payload or metadata), if any. */
export function actorOf(e: EventEnvelope): string | undefined {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const raw = p.principal ?? e.metadata?.principal ?? e.metadata?.forkedBy;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const k of ["actor", "id", "sub", "name"]) {
      if (typeof o[k] === "string") return o[k] as string;
    }
    return truncate(JSON.stringify(raw), 60);
  }
  return String(raw);
}

/**
 * `loom logs -v`: each event's row plus an indented line of timestamp, time since the
 * previous event IN THIS VIEW, a step's own duration on its terminal event (STEP_STARTED →
 * STEP_COMPLETED/FAILED/CANCELLED of the same step), the recorded actor, and the payload cut
 * to `maxPayload` characters. Stateful: feed events in order. Redaction is the caller's job
 * and happens BEFORE this, so a masked value is what gets truncated.
 */
export function createVerboseFormatter(maxPayload = 200): (e: EventEnvelope) => string {
  let prev: number | undefined;
  const stepStart = new Map<string, number>();
  return (e) => {
    const bits = [new Date(e.timestamp).toISOString()];
    if (prev !== undefined) bits.push(`+${Math.max(0, e.timestamp - prev)}ms`);
    prev = e.timestamp;
    const stepId = (e.payload as { stepId?: unknown } | null | undefined)?.stepId;
    if (typeof stepId === "string") {
      if (e.eventType === "STEP_STARTED") stepStart.set(stepId, e.timestamp);
      else if (/^STEP_(COMPLETED|FAILED|CANCELLED)$/.test(e.eventType)) {
        const started = stepStart.get(stepId);
        if (started !== undefined) bits.push(`step ${Math.max(0, e.timestamp - started)}ms`);
      }
    }
    const actor = actorOf(e);
    if (actor !== undefined) bits.push(`actor=${actor}`);
    const payload = e.payload === undefined ? "" : (JSON.stringify(e.payload) ?? "");
    return `${eventLine(e)}\n        ${bits.join("  ")}${
      payload === "" ? "" : `\n        payload ${truncate(payload, maxPayload)}`
    }`;
  };
}

/**
 * Human summary of a folded state — the `loom debug --at <seq>` view. `redact` masks the
 * given output dot-paths (K10-R6) before the output is printed.
 */
export function describeState(rawState: ExecutionState, redact: readonly string[] = []): string {
  const r = makeRedactor(redact);
  const state = r.scrub(r.mask(rawState));
  const frames = Object.entries(state.frames)
    .map(([id, f]) => `    ${id}: ${f.status}`)
    .join("\n");
  const output = state.variables._output;
  return [
    `execution ${state.executionId}  (workflow ${state.workflowId})`,
    `status: ${state.status}   sequence: ${state.sequence}`,
    state.suspendedOn ? `suspended on: ${state.suspendedOn.on}` : undefined,
    frames ? `frames:\n${frames}` : "frames: (none)",
    output !== undefined ? `output: ${truncate(JSON.stringify(output))}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function truncate(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ── evaluateGoldens — the `loom eval` engine (pure) ───────────────────────────

export interface GoldenExpectation {
  status?: string;
  outputContains?: string;
  stepsCompleted?: string[];
}
export interface Golden {
  name: string;
  log: EventEnvelope[];
  expect?: GoldenExpectation;
}
export interface GoldenResult {
  name: string;
  passed: boolean;
  failures: string[];
}
export interface EvalReport {
  results: GoldenResult[];
  passed: number;
  failed: number;
  ok: boolean;
}

/**
 * Replay each golden log (deterministically, no live calls) and check it against
 * its expectations — the CI gate behind `loom eval`. Pure over already-loaded
 * goldens so it is trivially testable.
 */
export function evaluateGoldens(goldens: Golden[]): EvalReport {
  const results = goldens.map((g): GoldenResult => {
    const failures: string[] = [];
    const state = foldAt(g.log);
    const e = g.expect ?? {};
    if (e.status !== undefined && state.status !== e.status) {
      failures.push(`status: expected ${e.status}, got ${state.status}`);
    }
    if (e.outputContains !== undefined) {
      const out = JSON.stringify(state.variables._output ?? null);
      if (!out.includes(e.outputContains)) {
        failures.push(`output does not contain "${e.outputContains}" (was ${truncate(out)})`);
      }
    }
    if (e.stepsCompleted !== undefined) {
      const completed = recordedStepOutputs(g.log);
      for (const stepId of e.stepsCompleted) {
        if (!(stepId in completed)) failures.push(`step "${stepId}" did not complete`);
      }
    }
    return { name: g.name, passed: failures.length === 0, failures };
  });
  const failed = results.filter((r) => !r.passed).length;
  return { results, passed: results.length - failed, failed, ok: failed === 0 };
}
