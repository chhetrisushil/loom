import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExecutionState } from "@loom/core";
import type { PrincipalChain } from "@loom/effect-runtime";
import type { ExecutionHandle, WorkflowRuntime } from "@loom/workflow-runtime";
import { UsageError } from "./args";
import { makeRedactor } from "./core";
import { loadLoomApp } from "./stores";

// ── `loom resume | cancel | start` — lifecycle verbs over the app's own runtime ──────────────
//
// THIS IS A SECURITY BOUNDARY, so the rules are structural rather than careful:
//
//  1. The verbs act ONLY through `app.runtime` — the public WorkflowRuntime that the app's
//     `defineConfig` composed — loaded from `--config`. They never append to the log, never
//     build a runtime of their own, and so inherit every check that runtime carries: the
//     ResumeAuthenticator, the ExecutionAuthorizer, `resumeSchemas`, tenant scoping, sealed
//     (encrypted) payloads, fencing and heartbeat leases. The continuation runs in THIS process
//     through the app's effect runtime, so the capability ring and policies (config-time) carry
//     over - but the kill switch, budgets and rate limits are PER PROCESS: a stop issued in the
//     running app is invisible here. `resume --apply` / `start --apply` therefore refuse a
//     process-local kill switch unless `--allow-local-controls`. The `--db` shorthand is
//     refused: a bare store has none of them.
//  2. Identity is `--as` (+ `--tenant`): the principal the app's authorizer evaluates. It is
//     REQUIRED, because a principal-less call bypasses a non-strict app's authorizer by design
//     (it is how the kernel's own machinery is exempt). The CLI adds no privilege and takes
//     none away; an operator holding the config module and the store credentials is trusted
//     exactly as far as the app's checks admit.
//  3. A credential the app verifies (a signature, a session) rides in `--payload` /
//     `--payload-file`, untouched: the authenticator sees the exact event the caller signed.
//  4. Dry run by default. `--apply` performs it.
//
// Delivery vs in-process: the runtime has NO public "record this resume for the owning worker"
// path for a gate/approval (only the durable inbox, `runtime.send`, delivers by itself), so
// `resume` and `start` RUN the continuation in this process, through the app's effect runtime.
// `cancel` runs nothing: it only records `EXECUTION_CANCELLED` (fencing out any stale driver).
// The imported app is loaded with LOOM_NO_AUTOSTART so defineConfig does not start its timers,
// schedules and workers; a suspend that needs a wake leaves its timer row for the app's own
// workers. That switch only suppresses defineConfig's own start: a `--config` module that calls
// `app.start()` / `listen()` itself still does it, so the module must be the side-effect-free
// composition module, and we refuse to act when the app's timer service reports running.

export type LifecycleAction = "resume" | "cancel" | "start";

export interface LifecycleFlags {
  config?: string;
  db?: string;
  snap?: string;
  branches?: string;
  leases?: string;
  /** The acting identity (`PrincipalChain.actor`). Required. */
  as?: string;
  /** `PrincipalChain.tenant`. */
  tenant?: string;
  /** Override an UNKNOWN lease liveness (resume/cancel). Never overrides a known live holder on resume. */
  force?: boolean;
  /** Run effects under a process-local kill switch / budgets (resume/start). */
  allowLocalControls?: boolean;
  apply: boolean;
  redact: string[];
  showPayload?: boolean;
}

export interface ExecutionSnapshot {
  status: string;
  sequence: number;
  workflowId: string;
  waitingOn?: string;
  wakeAt?: number;
}

export interface LifecycleResult {
  ok: boolean;
  action: LifecycleAction;
  dryRun: boolean;
  executionId: string | null;
  before?: ExecutionSnapshot | null;
  after?: ExecutionSnapshot;
  /** The app's own reason (or the CLI's precondition) for refusing. Exit 2. */
  refusal?: string;
  /** A runtime failure after the verb was accepted. Exit 1. */
  failure?: string;
  /** Human lines: what would happen / what happened. Already redacted. */
  lines: string[];
  exitCode: 0 | 1 | 2;
}

// ── Input handling ────────────────────────────────────────────────────────────

/**
 * Parse a JSON flag value WITHOUT echoing it: `JSON.parse`'s own message quotes a snippet of the
 * text, and the text may be a credential. Exit 2 on failure.
 */
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${what} is not valid JSON (its content is not shown)`);
  }
}

/** `--<name> <json>` or `--<name>-file <path>` (a file keeps a credential out of shell history). */
export function readJsonInput(
  name: string,
  inline: string | undefined,
  file: string | undefined,
  required: boolean
): { value: unknown; fromFile: boolean } | undefined {
  if (inline !== undefined && file !== undefined) {
    throw new UsageError(`pass --${name} or --${name}-file, not both`);
  }
  if (inline === undefined && file === undefined) {
    if (required) {
      throw new UsageError(`missing required --${name} <json> (or --${name}-file <path>)`);
    }
    return undefined;
  }
  if (file !== undefined) {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      throw new UsageError(
        `--${name}-file: cannot read ${path.resolve(file)}: ${(err as NodeJS.ErrnoException).code ?? "error"}`
      );
    }
    return { value: parseJson(text, `--${name}-file ${path.resolve(file)}`), fromFile: true };
  }
  return { value: parseJson(inline as string, `--${name}`), fromFile: false };
}

/** The principal the app's authorizer evaluates. `--as` is required (see the header). */
export function principalOf(flags: Pick<LifecycleFlags, "as" | "tenant">): PrincipalChain {
  if (flags.as === undefined || flags.as === "true" || flags.as.trim() === "") {
    throw new UsageError(
      "missing required --as <principal>: the lifecycle verbs act as a named principal so the app's authorizer is consulted (a principal-less call would bypass a non-strict app's authorizer)"
    );
  }
  return {
    actor: flags.as,
    ...(flags.tenant !== undefined && flags.tenant !== "true" && { tenant: flags.tenant }),
  };
}

/** Refuse everything but a `--config` (exit 2). Runs BEFORE the config is imported. */
export function requireConfigOnly(command: string, flags: LifecycleFlags): string {
  const shorthand = (["db", "snap", "branches", "leases"] as const).filter(
    (k) => flags[k] !== undefined
  );
  if (shorthand.length > 0) {
    throw new UsageError(
      `loom ${command}: --${shorthand[0]} is refused. The lifecycle verbs act only through your app's runtime (--config <module>): a bare store has no resume authenticator, execution authorizer, resumeSchemas or tenant isolation, so acting on it would bypass all of them.`
    );
  }
  if (flags.config === undefined || flags.config === "true") {
    throw new UsageError(
      `loom ${command}: --config <module> is required (the app's own defineConfig). It is never discovered for a verb that writes.`
    );
  }
  return flags.config;
}

// ── Errors: which are the app's refusals (exit 2) and which are failures (exit 1) ─────────────

const REFUSAL_ERRORS: ReadonlySet<string> = new Set([
  "ExecutionDeniedError",
  "ApprovalRejectedError",
  "ResumePayloadValidationError",
  "ResumeRefusedError",
  "ResumeContendedError",
  "FlowCodeMismatchError",
  "InputValidationError",
  "ExecutionAlreadyExistsError",
  "StartLeaseHeldError",
  "LeaseHeldError",
  "SealedPayloadUnreadableError",
  "QuarantineHeldError",
]);

/**
 * Runtime errors whose MESSAGE may quote a caller-supplied value (a zod issue text, an
 * authenticator's reason). Relayed as the error NAME plus a fixed sentence unless `--show-payload`.
 */
const ECHOING_ERRORS: Readonly<Record<string, string>> = {
  ResumePayloadValidationError:
    "the payload does not satisfy the flow's declared resumeSchemas entry",
  InputValidationError: "the input does not satisfy the flow's declared inputSchema",
  ApprovalRejectedError: "approval not verified",
};

function refusalOf(err: unknown, showPayload = false): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const fixed = ECHOING_ERRORS[err.name];
  if (fixed !== undefined && !showPayload) {
    return `${err.name}: ${fixed} (detail withheld - it may quote your input; pass --show-payload)`;
  }
  if (REFUSAL_ERRORS.has(err.name)) return `${err.name}: ${err.message}`;
  if (/^No execution found for id/.test(err.message)) return err.message;
  if (/was cancelled; resume refused|resume refused \(terminal/.test(err.message)) {
    return err.message;
  }
  return undefined;
}

/**
 * zod issues for display. A zod message can quote the RECEIVED value (`Invalid enum value.
 * Received 'hunter2'`), so by default only the path and the issue code are shown.
 */
function issueText(
  issues: readonly { path: readonly PropertyKey[]; code: string; message: string }[],
  showPayload: boolean | undefined
): string {
  return issues
    .map(
      (i) =>
        `${i.path.map(String).join(".") || "<root>"}: ${showPayload === true ? i.message : i.code}`
    )
    .join("; ");
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

type AppLike = Awaited<ReturnType<typeof loadLoomApp>>;

function snapshotOf(state: ExecutionState): ExecutionSnapshot {
  const s = state.suspendedOn;
  const wakeAt =
    s?.wakeAt ??
    s?.waits
      ?.filter((w) => w.kind === "timer" && typeof w.wakeAt === "number")
      .map((w) => w.wakeAt as number)
      .sort((a, b) => a - b)[0];
  return {
    status: state.status,
    sequence: state.sequence,
    workflowId: state.workflowId,
    ...(state.status === "suspended" && s !== undefined && { waitingOn: s.on }),
    ...(state.status === "suspended" && wakeAt !== undefined && { wakeAt }),
  };
}

function describe(s: ExecutionSnapshot | null | undefined): string {
  if (s === null || s === undefined) return "(none)";
  return `${s.status} at seq ${s.sequence}${s.waitingOn !== undefined ? `, waiting on "${s.waitingOn}"` : ""}${s.wakeAt !== undefined ? ` (wakes ${new Date(s.wakeAt).toISOString()})` : ""}`;
}

/** The reserved gate the kernel parks a diverged run on (`FLOW_DIVERGED_GATE`, ADR 0113). */
const DIVERGED_GATE = "__loom_diverged__";

/**
 * Wait for a handle to settle (complete, park, fail or cancel); never throws. The FIRST of
 * `waitForCompletion` / `waitForSuspend` to settle decides, and a REJECTION of either is the
 * error: the runtime rejects the suspend promise before the completion one on a divergence
 * refusal, a storage failure and a sealed refusal, so treating a rejected park as "parked" would
 * report a failed run as resumed.
 */
async function settle(handle: ExecutionHandle): Promise<{ error: unknown } | undefined> {
  const outcome = (p: Promise<unknown>): Promise<{ error: unknown } | undefined> =>
    p.then(
      () => undefined,
      (error: unknown) => ({ error })
    );
  // Both promises are consumed, so neither can become an unhandled rejection.
  return await Promise.race([
    outcome(handle.waitForCompletion()),
    outcome(handle.waitForSuspend()),
  ]);
}

interface Concluded {
  after: ExecutionSnapshot;
  refusal?: string;
  failure?: string;
}

/**
 * What a run left behind. The handle's own state is not trusted alone: the log is re-read (as the
 * same principal) so a park that did not land durably, or a status other than suspended /
 * completed / cancelled, is a FAILURE (exit 1), whatever the handle's promises said.
 */
async function conclude(
  runtime: WorkflowRuntime,
  handle: ExecutionHandle,
  principal: PrincipalChain,
  r: ReturnType<typeof makeRedactor>,
  showPayload: boolean | undefined,
  what: string
): Promise<Concluded> {
  const settled = await settle(handle);
  let durable: ExecutionState | null = null;
  try {
    durable = await runtime.loadState(handle.executionId, { principal });
  } catch {
    // unreadable (sealed, shredded, denied): fall back to the handle's own view below
  }
  const live = handle.getState();
  const after = snapshotOf(durable ?? live);
  const ok = (s: string) => s === "suspended" || s === "completed" || s === "cancelled";
  if (settled !== undefined && after.status !== "cancelled") {
    const refusal = refusalOf(settled.error, showPayload);
    return refusal !== undefined
      ? { after, refusal: r.scrub(refusal) }
      : { after, failure: r.scrub(`${what}: ${errorText(settled.error)}`) };
  }
  if (!ok(after.status)) {
    return {
      after,
      failure: `${what}: the log says it is ${after.status}${live.status !== after.status ? ` (the handle reported ${live.status})` : ""}`,
    };
  }
  if (durable !== null && live.status === "suspended" && durable.status !== "suspended") {
    return {
      after,
      failure: `${what}: the park did not land durably (the log says ${durable.status})`,
    };
  }
  if (after.status === "suspended" && after.waitingOn === DIVERGED_GATE) {
    return {
      after,
      failure: `${what}: the flow's code no longer matches this execution's recorded history, so the runtime parked it on the reserved gate "${DIVERGED_GATE}" instead of continuing (fix or pin the code, then retryDiverged)`,
    };
  }
  return { after };
}

type Liveness =
  | { state: "none" }
  | { state: "held"; owner: string; expiresAt: number }
  | { state: "unknown"; why: string };

/**
 * Who, if anyone, holds the execution's heartbeat lease. "none" is only ever said when the app's
 * lease store could actually be asked; otherwise the answer is "unknown", which the verbs treat as
 * a reason to require `--force`.
 */
async function leaseLiveness(app: AppLike, executionId: string): Promise<Liveness> {
  const hb = app.heartbeat;
  if (hb === undefined || !hb.enabled || hb.store === undefined) {
    return { state: "unknown", why: "heartbeat leases off — liveness unknown" };
  }
  if (hb.storeInMemory || hb.scope === "process") {
    return {
      state: "unknown",
      why: "unknown (the lease store is process-local: another process's lease is not visible here)",
    };
  }
  if (hb.store.get === undefined) {
    return { state: "unknown", why: "unknown (lease store not readable)" };
  }
  try {
    const lease = await hb.store.get(executionId);
    return lease !== null && lease !== undefined && lease.expiresAt > Date.now()
      ? { state: "held", owner: lease.owner, expiresAt: lease.expiresAt }
      : { state: "none" };
  } catch {
    return { state: "unknown", why: "unknown (lease store not readable)" };
  }
}

function livenessLine(l: Liveness): string {
  return l.state === "held"
    ? `HELD by ${l.owner} until ${new Date(l.expiresAt).toISOString()}`
    : l.state === "none"
      ? "none live"
      : l.why;
}

const IN_PROCESS =
  "effects of the continuation run IN THIS PROCESS through your app's effect runtime (its capability ring and policies carry over, being config-time; its kill switch, budgets and rate limits are PER PROCESS); the app's timers, schedules and workers are NOT started";

type KillSwitchKind = "none" | "process-local" | "shared";

/** An in-memory kill switch is recognised by its admin API (the class lives in @loom/middleware). */
function killSwitchKind(ks: unknown): KillSwitchKind {
  if (ks === undefined || ks === null) return "none";
  const o = ks as Record<string, unknown>;
  const local =
    (o.constructor as { name?: string } | undefined)?.name === "InMemoryKillSwitch" ||
    (typeof o.stopTenant === "function" && typeof o.status === "function");
  return local ? "process-local" : "shared";
}

interface Preflight {
  lines: string[];
  /** Refused on --apply unless the operator passes the named flag. */
  flagBlockers: string[];
  /** Refused on --apply, always: no flag clears these. */
  structural: string[];
}

/** What running effects HERE depends on; shared by `resume` and `start`. */
function preflight(
  app: AppLike,
  runtime: WorkflowRuntime,
  workflowId: string,
  flags: Pick<LifecycleFlags, "allowLocalControls">
): Preflight {
  const lines: string[] = [];
  const flagBlockers: string[] = [];
  const structural: string[] = [];

  const ks = killSwitchKind(app.killSwitch);
  if (ks === "process-local") {
    lines.push(
      "controls: kill switch / budgets / rate limits are process-local: a stop issued in the running app does NOT apply here"
    );
    if (flags.allowLocalControls !== true) {
      flagBlockers.push(
        "the app's kill switch is process-local (an in-memory default), so an operator stop in the running app would NOT stop this run's effects; pass --allow-local-controls to run effects anyway, or give the app a shared KillSwitchRegistry"
      );
    }
  } else if (ks === "shared") {
    lines.push(
      "controls: kill switch is a shared registry (a stop in the running app applies); budgets and rate limits are per process"
    );
  } else {
    lines.push(
      "controls: no kill switch configured; budgets and rate limits are per process (a limit enforced in the running app is not shared with this run)"
    );
  }

  // Every effect the flow DECLARES must be registered, or the first step fails the execution
  // permanently. A step run dynamically (`ctx.run` of a step the definition does not declare)
  // cannot be known ahead of time.
  const steps = runtime.getFlow(workflowId)?.definition.steps ?? [];
  const effects = app.effectRuntime;
  if (effects === undefined) {
    lines.push("effects: the app exposes no effect runtime, so registration cannot be checked");
  } else {
    const missing = [...new Set(steps.map((s) => s.toolId ?? s.id))].filter((t) => !effects.has(t));
    if (missing.length > 0) {
      structural.push(
        `the flow declares effect(s) this app has not registered: ${missing.join(", ")}. A missing handler would fail the execution permanently; register them in the config module (execution.registerEffects)`
      );
    } else {
      lines.push(
        `effects: all ${new Set(steps.map((s) => s.toolId ?? s.id)).size} declared step effect(s) are registered (a step the flow runs without declaring it cannot be checked ahead of time)`
      );
    }
  }

  if (app.timerService?.running === true) {
    const why =
      "the app's timer service is RUNNING in this process: the --config module started it (app.start() / a server entry). It would fire timers and schedules from the CLI. Point --config at the side-effect-free composition module";
    console.error(`loom: warning: ${why}`);
    structural.push(why);
  }
  return { lines, flagBlockers, structural };
}

function result(
  base: Pick<LifecycleResult, "action" | "dryRun" | "executionId"> & Partial<LifecycleResult>
): LifecycleResult {
  const refusal = base.refusal;
  const failure = base.failure;
  return {
    ok: refusal === undefined && failure === undefined,
    lines: [],
    exitCode: refusal !== undefined ? 2 : failure !== undefined ? 1 : 0,
    ...base,
  };
}

/** Top-level keys a schema parse dropped (zod strips unknown keys by default; ADR 0077). */
function strippedKeys(before: unknown, after: unknown): string[] {
  const plain = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!plain(before) || !plain(after)) return [];
  return Object.keys(before).filter((k) => !Object.hasOwn(after, k));
}

// ── resume ────────────────────────────────────────────────────────────────────

export interface ResumeArgs extends LifecycleFlags {
  executionId: string;
  event: string;
  payload: unknown;
  payloadFromFile: boolean;
  waitId?: string;
}

export async function resumeExecution(args: ResumeArgs): Promise<LifecycleResult> {
  const principal = principalOf(args);
  const config = requireConfigOnly("resume", args);
  const r = makeRedactor(args.redact);
  const app = await loadLoomApp(config);
  try {
    const runtime = app.runtime;
    if (runtime === undefined) {
      throw new UsageError(`${config} must default-export a LoomApp from defineConfig(...)`);
    }
    const id = args.executionId;
    const base = { action: "resume", dryRun: !args.apply, executionId: id } as const;
    const event = {
      eventType: args.event,
      payload: args.payload,
      ...(args.waitId !== undefined && { waitId: args.waitId }),
    };

    // The authorizer-gated read of the execution (op "query"). Read-only: a denial records
    // nothing ("a read must never write", loadStateCore).
    let state: ExecutionState | null;
    try {
      state = await runtime.loadState(id, { principal });
    } catch (err) {
      const refusal = refusalOf(err, args.showPayload);
      if (refusal === undefined) throw err;
      return result({ ...base, refusal: r.scrub(refusal) });
    }
    if (state === null)
      return result({ ...base, before: null, refusal: `no such execution ${id}` });
    const before = snapshotOf(state);
    if (state.status !== "suspended") {
      return result({
        ...base,
        before,
        refusal: `execution ${id} is ${state.status}, not suspended: there is nothing to resume`,
      });
    }

    // What the flow's declared gate contract (ADR 0077) makes of this payload. The registered
    // (current) flow's schema is shown; the runtime re-parses with the version the execution
    // is pinned to on --apply.
    const flow = runtime.getFlow(state.workflowId);
    const schemas = flow?.definition.resumeSchemas;
    const schema =
      schemas !== undefined && Object.hasOwn(schemas, args.event) ? schemas[args.event] : undefined;
    let parsed: unknown = args.payload;
    let stripped: string[] = [];
    const parseLines: string[] = [];
    // Predictions only. On --apply the runtime is authoritative and checks in ITS order
    // (authenticator, then gate, then shape). The gate/prediction text is printed only to a
    // caller the app's QUERY authorizer admitted (the read above); it is not hidden from a
    // caller who passes that gate, and an unverified caller is refused by the runtime on --apply
    // before the gate or shape is checked.
    let predicted: string | undefined;
    if (schema !== undefined) {
      const p = schema.safeParse(args.payload);
      if (!p.success) {
        r.mask(args.payload);
        predicted = r.scrub(
          `payload fails the flow's resumeSchemas["${args.event}"]: ${issueText(p.error.issues, args.showPayload)}`
        );
      } else {
        parsed = p.data;
        stripped = strippedKeys(args.payload, parsed);
      }
    }
    if (schema !== undefined && predicted === undefined) {
      parseLines.push(`resumeSchemas["${args.event}"]: payload parses`);
      if (stripped.length > 0) {
        parseLines.push(
          `  the schema STRIPS these keys, so they will NOT be recorded: ${stripped.join(", ")}`
        );
      }
    } else if (schema === undefined) {
      parseLines.push(
        `resumeSchemas: none declared for "${args.event}" (the payload is recorded as given)`
      );
    }
    const shown =
      args.payloadFromFile && args.showPayload !== true
        ? "(from --payload-file; not shown, pass --show-payload to display)"
        : JSON.stringify(r.scrub(r.mask(parsed)));

    // Gate check, predicted. Authoritative only on --apply (the runtime re-checks after the
    // authenticator, so an unauthenticated caller never learns the gate).
    const gate = state.suspendedOn;
    const hasWaits = (gate?.waits?.length ?? 0) > 0;
    if (!hasWaits && gate?.on !== undefined && gate.on !== args.event) {
      predicted ??= `wrong event type: execution ${id} waits on "${gate.on}", not "${args.event}"`;
    }

    const lease = await leaseLiveness(app, id);
    // The park a resume answers. An approval signed to a park (ADR 0117) must bind THIS number.
    let parkSeq: number | undefined;
    try {
      parkSeq = await runtime.parkedAtSequence(id, { principal });
    } catch (err) {
      const refusal = refusalOf(err, args.showPayload);
      if (refusal === undefined) throw err;
      return result({ ...base, before, refusal: r.scrub(refusal) });
    }
    const pre = preflight(app, runtime, state.workflowId, args);
    const lines = [
      `resume ${args.apply ? "APPLY" : "DRY RUN (pass --apply to act)"} - execution ${id} (${before.workflowId})`,
      `  now: ${describe(before)}${parkSeq !== undefined ? `; park at sequence ${parkSeq} (an approval signed to a park binds this, ADR 0117)` : ""}`,
      `  event: ${args.event}${args.waitId !== undefined ? ` (wait ${args.waitId})` : ""} as ${principal.actor}${principal.tenant !== undefined ? ` in tenant ${principal.tenant}` : ""}`,
      ...parseLines.map((l) => `  ${l}`),
      `  payload recorded as: ${shown}`,
      `  resume authenticator: ${runtime.hasResumeAuthenticator() ? "configured; verifies on --apply" : "none configured on this app"}`,
      "  execution authorizer: evaluated on --apply (for this principal)",
      `  lease: ${livenessLine(lease)}`,
      ...pre.lines.map((l) => `  ${l}`),
      `  note: ${IN_PROCESS}`,
    ];
    if (lease.state === "held") {
      return result({
        ...base,
        before,
        lines,
        refusal: `another live owner (${lease.owner}) holds this execution's lease until ${new Date(lease.expiresAt).toISOString()}; nothing appended`,
      });
    }
    if (pre.structural.length > 0) {
      return result({ ...base, before, lines, refusal: pre.structural.join("; ") });
    }
    const blockers = [...pre.flagBlockers];
    if (lease.state === "unknown" && args.force !== true) {
      blockers.push(
        `the lease holder cannot be determined (${lease.why.replace(/^unknown \(|\)$/g, "")}); a live owner could be mid-run on this execution. Pass --force to resume anyway (the fence stops that owner's NEXT write, not an effect already running)`
      );
    }
    if (!args.apply) {
      if (blockers.length > 0) lines.push(`  --apply would be refused: ${blockers.join("; ")}`);
      return result({
        ...base,
        before,
        lines,
        ...(predicted !== undefined && { refusal: predicted }),
      });
    }
    if (blockers.length > 0) {
      return result({ ...base, before, lines, refusal: blockers.join("; ") });
    }

    // ── apply: the runtime's own resume path, answering exactly the park we just read ──
    try {
      if (parkSeq === undefined) {
        return result({
          ...base,
          before,
          lines,
          refusal: `execution ${id} has no locatable unanswered park to answer (compacted away, or answered meanwhile)`,
        });
      }
      const handle = await runtime.resume(id, event, { principal, fenceIfParkedAt: parkSeq });
      const done = await conclude(
        runtime,
        handle,
        principal,
        r,
        args.showPayload,
        "the resumed execution did not complete"
      );
      lines.push(`  resumed: ${describe(done.after)}`);
      return result({
        ...base,
        before,
        after: done.after,
        lines,
        ...(done.refusal !== undefined && { refusal: done.refusal }),
        ...(done.failure !== undefined && { failure: done.failure }),
      });
    } catch (err) {
      const refusal = refusalOf(err, args.showPayload);
      if (refusal === undefined) {
        return result({ ...base, before, lines, failure: r.scrub(errorText(err)) });
      }
      return result({ ...base, before, lines, refusal: r.scrub(refusal) });
    }
  } finally {
    await app.close?.();
  }
}

// ── cancel ────────────────────────────────────────────────────────────────────

export interface CancelArgs extends LifecycleFlags {
  executionId: string;
  reason?: string;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export async function cancelExecution(args: CancelArgs): Promise<LifecycleResult> {
  const principal = principalOf(args);
  const config = requireConfigOnly("cancel", args);
  const r = makeRedactor(args.redact);
  const app = await loadLoomApp(config);
  try {
    const runtime = app.runtime;
    if (runtime === undefined) {
      throw new UsageError(`${config} must default-export a LoomApp from defineConfig(...)`);
    }
    const id = args.executionId;
    const base = { action: "cancel", dryRun: !args.apply, executionId: id } as const;
    let state: ExecutionState | null = null;
    let shredded = false;
    try {
      state = await runtime.loadState(id, { principal });
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name === "PayloadShreddedError") {
        // An erased (crypto-shredded) parked execution is exactly what an operator cancels. The
        // runtime's own cancel folds a redacted view for it, so the pre-read is skipped, not fatal.
        shredded = true;
      } else {
        const refusal = refusalOf(err, args.showPayload);
        if (refusal === undefined) throw err;
        return result({ ...base, refusal: r.scrub(refusal) });
      }
    }
    if (!shredded && state === null)
      return result({ ...base, before: null, refusal: `no such execution ${id}` });
    const before = state !== null ? snapshotOf(state) : undefined;
    if (state !== null && TERMINAL.has(state.status)) {
      return result({
        ...base,
        before: snapshotOf(state),
        refusal: `execution ${id} is already ${state.status} (terminal): nothing to cancel`,
      });
    }
    const lease = await leaseLiveness(app, id);
    const lines = [
      `cancel ${args.apply ? "APPLY" : "DRY RUN (pass --apply to act)"} - execution ${id}${before !== undefined ? ` (${before.workflowId})` : ""}`,
      before !== undefined
        ? `  now: ${describe(before)}`
        : "  now: state unreadable (shredded): its payloads were erased; the cancel is recorded without reading them",
      `  as ${principal.actor}${principal.tenant !== undefined ? ` in tenant ${principal.tenant}` : ""}; execution authorizer: evaluated on --apply`,
      `  lease: ${livenessLine(lease)}`,
      "  effect: records EXECUTION_CANCELLED under a fence (K8.2); runs nothing in this process. The fence stops the owner's NEXT write, not an effect already running",
    ];
    if (lease.state === "held" && args.force !== true) {
      return result({
        ...base,
        ...(before !== undefined && { before }),
        lines,
        refusal: `another live owner (${lease.owner}) holds this execution's lease until ${new Date(lease.expiresAt).toISOString()}; pass --force to fence it out (its next write is rejected; an effect already running is not stopped), or wait`,
      });
    }
    if (lease.state === "unknown" && args.force !== true) {
      const why = `the lease holder cannot be determined (${lease.why.replace(/^unknown \(|\)$/g, "")}); a live owner could be mid-run on this execution. Pass --force to cancel anyway (the fence stops that owner's next write, not an effect already running)`;
      if (!args.apply) {
        lines.push(`  --apply would be refused: ${why}`);
        return result({ ...base, ...(before !== undefined && { before }), lines });
      }
      return result({
        ...base,
        ...(before !== undefined && { before }),
        lines,
        refusal: why,
      });
    }
    if (!args.apply) return result({ ...base, ...(before !== undefined && { before }), lines });
    try {
      const cancelled = await runtime.cancel(id, args.reason, { principal });
      if (!cancelled) {
        return result({
          ...base,
          ...(before !== undefined && { before }),
          lines,
          refusal: `execution ${id} is already terminal: nothing was cancelled`,
        });
      }
      let after: ExecutionSnapshot | undefined;
      try {
        const next = await runtime.loadState(id, { principal });
        after = next !== null ? snapshotOf(next) : undefined;
      } catch {
        after = undefined; // still unreadable (shredded)
      }
      lines.push(
        `  cancelled: ${after !== undefined ? describe(after) : "recorded (state unreadable)"}`
      );
      return result({
        ...base,
        ...(before !== undefined && { before }),
        ...(after !== undefined && { after }),
        lines,
      });
    } catch (err) {
      const refusal = refusalOf(err, args.showPayload);
      if (refusal === undefined) {
        return result({
          ...base,
          ...(before !== undefined && { before }),
          lines,
          failure: r.scrub(errorText(err)),
        });
      }
      return result({
        ...base,
        ...(before !== undefined && { before }),
        lines,
        refusal: r.scrub(refusal),
      });
    }
  } finally {
    await app.close?.();
  }
}

// ── start ─────────────────────────────────────────────────────────────────────

export interface StartArgs extends LifecycleFlags {
  flowId: string;
  input: unknown;
  inputFromFile: boolean;
  id?: string;
  idempotencyKey?: string;
}

/**
 * The execution id an `--idempotency-key` stands for: stable, charset-safe, never the key itself.
 *
 * Derivation: `sha256` over a domain-separated, length-prefixed encoding of (tenant, flowId, key),
 * first 32 hex digits, prefixed `idem-`. The TENANT is part of it so one tenant cannot squat or
 * probe another's key (the same key in two tenants yields two ids). The acting principal is not:
 * the key names the logical request, not who retries it, so a different operator repeating it in
 * the same tenant meets the same start-once refusal. No tenant is its own namespace.
 */
export function idempotentExecutionId(flowId: string, key: string, tenant?: string): string {
  const field = (v: string): string => `${Buffer.byteLength(v)}:${v}`;
  const material = [
    "loom.cli.start.idempotency.v1",
    tenant === undefined ? "-" : `t${field(tenant)}`,
    field(flowId),
    field(key),
  ].join("|");
  return `idem-${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

export async function startExecution(args: StartArgs): Promise<LifecycleResult> {
  const principal = principalOf(args);
  const config = requireConfigOnly("start", args);
  if (args.id !== undefined && args.idempotencyKey !== undefined) {
    throw new UsageError("pass --id or --idempotency-key, not both");
  }
  const r = makeRedactor(args.redact);
  const app = await loadLoomApp(config);
  try {
    const runtime = app.runtime;
    if (runtime === undefined) {
      throw new UsageError(`${config} must default-export a LoomApp from defineConfig(...)`);
    }
    const executionId =
      args.id ??
      (args.idempotencyKey !== undefined
        ? idempotentExecutionId(args.flowId, args.idempotencyKey, principal.tenant)
        : undefined);
    const base = {
      action: "start",
      dryRun: !args.apply,
      executionId: executionId ?? null,
    } as const;
    const flow = runtime.getFlow(args.flowId);
    if (flow === undefined) {
      const known = runtime.getFlowIds().slice(0, 20);
      return result({
        ...base,
        refusal: `no flow registered with id "${args.flowId}"${known.length > 0 ? ` (registered: ${known.join(", ")})` : ""}`,
      });
    }

    if (executionId !== undefined) {
      try {
        if ((await runtime.loadState(executionId, { principal })) !== null) {
          return result({
            ...base,
            refusal: `execution ${executionId} already exists (a start with a chosen id is start-once, ADR 0103)`,
          });
        }
      } catch (err) {
        const refusal = refusalOf(err, args.showPayload);
        if (refusal === undefined) throw err;
        return result({ ...base, refusal: r.scrub(refusal) });
      }
    }

    // The runtime is handed the RAW input - exactly what the app's own start() call would
    // record - and on --apply the runtime alone validates it (`validateInput`), AFTER its
    // authorizer. The schema prediction below is a dry-run courtesy, shown past the query gate.
    const schema = flow.definition.inputSchema;
    const enforced = runtime.validatesInput();
    let predicted: string | undefined;
    let schemaLine = "no input schema declared";
    if (schema !== undefined) {
      if (!enforced) {
        schemaLine = "schema not enforced by the app (validateInput is off) - recorded as given";
      } else if (!args.apply) {
        const p = schema.safeParse(args.input);
        if (p.success) {
          schemaLine = "parses against the flow's input schema (enforced by the app)";
        } else {
          r.mask(args.input);
          schemaLine = "does NOT parse against the flow's input schema";
          predicted = r.scrub(
            `input fails the flow's input schema: ${issueText(p.error.issues, args.showPayload)}`
          );
        }
      } else {
        schemaLine = "input schema enforced by the app on --apply";
      }
    }

    const shown =
      args.inputFromFile && args.showPayload !== true
        ? "(from --input-file; not shown, pass --show-payload to display)"
        : JSON.stringify(r.scrub(r.mask(args.input)));
    const pre = preflight(app, runtime, args.flowId, args);
    const lines = [
      `start ${args.apply ? "APPLY" : "DRY RUN (pass --apply to act)"} - flow ${args.flowId}`,
      `  execution id: ${executionId ?? "(a fresh id is minted)"}${args.idempotencyKey !== undefined ? ` (derived from --idempotency-key, scoped to tenant ${principal.tenant ?? "(none)"})` : ""}`,
      `  as ${principal.actor}${principal.tenant !== undefined ? ` in tenant ${principal.tenant}` : ""}; execution authorizer: evaluated on --apply`,
      `  input: ${schemaLine}; recorded as: ${shown}`,
      ...pre.lines.map((l) => `  ${l}`),
      `  note: ${IN_PROCESS}; the flow runs until it completes or parks`,
    ];
    if (pre.structural.length > 0) {
      return result({ ...base, lines, refusal: pre.structural.join("; ") });
    }
    if (!args.apply) {
      if (pre.flagBlockers.length > 0) {
        lines.push(`  --apply would be refused: ${pre.flagBlockers.join("; ")}`);
      }
      return result({ ...base, lines, ...(predicted !== undefined && { refusal: predicted }) });
    }
    if (pre.flagBlockers.length > 0) {
      return result({ ...base, lines, refusal: pre.flagBlockers.join("; ") });
    }
    try {
      const handle = await runtime.start(args.flowId, args.input, {
        principal,
        ...(executionId !== undefined && { executionId }),
      });
      const done = await conclude(
        runtime,
        handle,
        principal,
        r,
        args.showPayload,
        "the execution did not complete"
      );
      lines.push(`  started ${handle.executionId}: ${describe(done.after)}`);
      return result({
        ...base,
        executionId: handle.executionId,
        after: done.after,
        lines,
        ...(done.refusal !== undefined && { refusal: done.refusal }),
        ...(done.failure !== undefined && { failure: done.failure }),
      });
    } catch (err) {
      const refusal = refusalOf(err, args.showPayload);
      if (refusal === undefined) {
        return result({ ...base, lines, failure: r.scrub(errorText(err)) });
      }
      return result({ ...base, lines, refusal: r.scrub(refusal) });
    }
  } finally {
    await app.close?.();
  }
}

/** Text for the terminal: the plan/outcome lines, then the refusal or failure (on stderr by the caller). */
export function renderLifecycle(res: LifecycleResult): string {
  return res.lines.join("\n");
}
