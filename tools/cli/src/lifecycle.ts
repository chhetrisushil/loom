import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ExecutionState } from "@loom/core";
import type { PrincipalChain } from "@loom/effect-runtime";
import type { ExecutionHandle } from "@loom/workflow-runtime";
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
//     (encrypted) payloads, fencing, heartbeat leases, and — because the continuation runs in
//     THIS process through the app's effect runtime — the kill switch, quotas and the
//     capability ring. The `--db` shorthand is refused: a bare store has none of them.
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
// The imported app is loaded with LOOM_NO_AUTOSTART so its timers, schedules and workers do not
// start; a suspend that needs a wake leaves its timer row for the app's own workers.

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

function refusalOf(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  if (REFUSAL_ERRORS.has(err.name)) return `${err.name}: ${err.message}`;
  if (/^No execution found for id/.test(err.message)) return err.message;
  if (/was cancelled; resume refused|resume refused \(terminal/.test(err.message)) {
    return err.message;
  }
  return undefined;
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

/** Wait for a handle to settle (complete, suspend, fail or cancel); never throws. */
async function settle(handle: ExecutionHandle): Promise<string | undefined> {
  const done = handle.waitForCompletion().then(
    () => undefined,
    (err: unknown) => (err instanceof Error ? err.message : String(err))
  );
  const parked = handle.waitForSuspend().then(
    () => undefined,
    () => undefined
  );
  // Both promises are consumed above, so neither can become an unhandled rejection.
  return await Promise.race([done, parked]);
}

/** The live, unexpired lease on `executionId`, when the app's heartbeat store can say. */
async function liveLease(
  app: AppLike,
  executionId: string
): Promise<{ owner: string; expiresAt: number } | undefined> {
  const store = app.heartbeat?.store;
  if (store?.get === undefined) return undefined;
  const lease = await store.get(executionId);
  return lease !== null && lease !== undefined && lease.expiresAt > Date.now()
    ? { owner: lease.owner, expiresAt: lease.expiresAt }
    : undefined;
}

const IN_PROCESS =
  "effects of the continuation run IN THIS PROCESS through your app's effect runtime (its kill switch, quotas and capability ring apply); the app's timers, schedules and workers are NOT started";

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
      const refusal = refusalOf(err);
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
    // (authenticator, then gate, then shape), so an unverified caller learns nothing of the
    // contract; this dry-run preview is shown only to a principal the authorizer let query.
    let predicted: string | undefined;
    if (schema !== undefined) {
      const p = schema.safeParse(args.payload);
      if (!p.success) {
        const issues = p.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ");
        r.mask(args.payload);
        predicted = r.scrub(`payload fails the flow's resumeSchemas["${args.event}"]: ${issues}`);
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

    const lease = await liveLease(app, id);
    // The park a resume answers. An approval signed to a park (ADR 0117) must bind THIS number.
    let parkSeq: number | undefined;
    try {
      parkSeq = await runtime.parkedAtSequence(id, { principal });
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal === undefined) throw err;
      return result({ ...base, before, refusal: r.scrub(refusal) });
    }
    const lines = [
      `resume ${args.apply ? "APPLY" : "DRY RUN (pass --apply to act)"} - execution ${id} (${before.workflowId})`,
      `  now: ${describe(before)}${parkSeq !== undefined ? `; park at sequence ${parkSeq} (an approval signed to a park binds this, ADR 0117)` : ""}`,
      `  event: ${args.event}${args.waitId !== undefined ? ` (wait ${args.waitId})` : ""} as ${principal.actor}${principal.tenant !== undefined ? ` in tenant ${principal.tenant}` : ""}`,
      ...parseLines.map((l) => `  ${l}`),
      `  payload recorded as: ${shown}`,
      `  resume authenticator: ${runtime.hasResumeAuthenticator() ? "configured; verifies on --apply" : "none configured on this app"}`,
      "  execution authorizer: evaluated on --apply (for this principal)",
      `  lease: ${lease !== undefined ? `HELD by ${lease.owner} until ${new Date(lease.expiresAt).toISOString()}` : "none live"}`,
      `  note: ${IN_PROCESS}`,
    ];
    if (lease !== undefined) {
      return result({
        ...base,
        before,
        lines,
        refusal: `another live owner (${lease.owner}) holds this execution's lease until ${new Date(lease.expiresAt).toISOString()}; nothing appended`,
      });
    }
    if (!args.apply) {
      return result({
        ...base,
        before,
        lines,
        ...(predicted !== undefined && { refusal: predicted }),
      });
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
      const failure = await settle(handle);
      const after = snapshotOf(handle.getState());
      lines.push(`  resumed: ${describe(after)}`);
      return result({
        ...base,
        before,
        after,
        lines,
        ...(failure !== undefined && after.status !== "suspended" && after.status !== "completed"
          ? { failure: r.scrub(`the resumed execution did not complete: ${failure}`) }
          : {}),
      });
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal === undefined) {
        return result({ ...base, before, lines, failure: r.scrub(errorText(err)) });
      }
      return result({ ...base, before, lines, refusal: r.scrub(refusal) });
    }
  } finally {
    await app.close?.();
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

// ── cancel ────────────────────────────────────────────────────────────────────

export interface CancelArgs extends LifecycleFlags {
  executionId: string;
  reason?: string;
  /** Fence out a live lease holder (K8.2 fence-then-cancel). Refused unless given. */
  force?: boolean;
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
    let state: ExecutionState | null;
    try {
      state = await runtime.loadState(id, { principal });
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal === undefined) throw err;
      return result({ ...base, refusal: r.scrub(refusal) });
    }
    if (state === null)
      return result({ ...base, before: null, refusal: `no such execution ${id}` });
    const before = snapshotOf(state);
    if (TERMINAL.has(state.status)) {
      return result({
        ...base,
        before,
        refusal: `execution ${id} is already ${state.status} (terminal): nothing to cancel`,
      });
    }
    const lease = await liveLease(app, id);
    const lines = [
      `cancel ${args.apply ? "APPLY" : "DRY RUN (pass --apply to act)"} - execution ${id} (${before.workflowId})`,
      `  now: ${describe(before)}`,
      `  as ${principal.actor}${principal.tenant !== undefined ? ` in tenant ${principal.tenant}` : ""}; execution authorizer: evaluated on --apply`,
      `  lease: ${lease !== undefined ? `HELD by ${lease.owner} until ${new Date(lease.expiresAt).toISOString()}` : "none live"}`,
      "  effect: records EXECUTION_CANCELLED under a fence (K8.2); runs nothing in this process",
    ];
    if (lease !== undefined && args.force !== true) {
      return result({
        ...base,
        before,
        lines,
        refusal: `another live owner (${lease.owner}) holds this execution's lease until ${new Date(lease.expiresAt).toISOString()}; pass --force to fence it out (its next write is rejected), or wait`,
      });
    }
    if (!args.apply) return result({ ...base, before, lines });
    try {
      const cancelled = await runtime.cancel(id, args.reason, { principal });
      if (!cancelled) {
        return result({
          ...base,
          before,
          lines,
          refusal: `execution ${id} is already terminal: nothing was cancelled`,
        });
      }
      const next = await runtime.loadState(id, { principal });
      const after = next !== null ? snapshotOf(next) : undefined;
      lines.push(`  cancelled: ${describe(after)}`);
      return result({ ...base, before, ...(after !== undefined && { after }), lines });
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal === undefined) {
        return result({ ...base, before, lines, failure: r.scrub(errorText(err)) });
      }
      return result({ ...base, before, lines, refusal: r.scrub(refusal) });
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

/** The execution id an `--idempotency-key` stands for: stable, charset-safe, never the key itself. */
export function idempotentExecutionId(flowId: string, key: string): string {
  return `idem-${createHash("sha256").update(`${flowId}\0${key}`).digest("hex").slice(0, 32)}`;
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
        ? idempotentExecutionId(args.flowId, args.idempotencyKey)
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

    let parsed: unknown = args.input;
    const schema = flow.definition.inputSchema;
    if (schema !== undefined) {
      const p = schema.safeParse(args.input);
      if (!p.success) {
        const issues = p.error.issues
          .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
          .join("; ");
        r.mask(args.input);
        return result({
          ...base,
          refusal: r.scrub(`input fails the flow's input schema: ${issues}`),
        });
      }
      parsed = p.data;
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
        const refusal = refusalOf(err);
        if (refusal === undefined) throw err;
        return result({ ...base, refusal: r.scrub(refusal) });
      }
    }

    const shown =
      args.inputFromFile && args.showPayload !== true
        ? "(from --input-file; not shown, pass --show-payload to display)"
        : JSON.stringify(r.scrub(r.mask(parsed)));
    const lines = [
      `start ${args.apply ? "APPLY" : "DRY RUN (pass --apply to act)"} - flow ${args.flowId}`,
      `  execution id: ${executionId ?? "(a fresh id is minted)"}${args.idempotencyKey !== undefined ? " (derived from --idempotency-key)" : ""}`,
      `  as ${principal.actor}${principal.tenant !== undefined ? ` in tenant ${principal.tenant}` : ""}; execution authorizer: evaluated on --apply`,
      `  input: ${schema !== undefined ? "parses against the flow's input schema" : "no input schema declared"}; ${shown}`,
      `  note: ${IN_PROCESS}; the flow runs until it completes or parks`,
    ];
    if (!args.apply) return result({ ...base, lines });
    try {
      const handle = await runtime.start(args.flowId, args.input, {
        principal,
        ...(executionId !== undefined && { executionId }),
      });
      const failure = await settle(handle);
      const after = snapshotOf(handle.getState());
      lines.push(`  started ${handle.executionId}: ${describe(after)}`);
      return result({
        ...base,
        executionId: handle.executionId,
        after,
        lines,
        ...(failure !== undefined && after.status !== "suspended" && after.status !== "completed"
          ? { failure: r.scrub(`the execution did not complete: ${failure}`) }
          : {}),
      });
    } catch (err) {
      const refusal = refusalOf(err);
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
