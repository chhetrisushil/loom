// ── K7 — data-plane isolation types ──────────────────────────────────────────

/**
 * Static description of an isolated tool (P5 — wiring is static). The tool's
 * CODE is a module the CHILD process loads — never a closure over parent state,
 * which is exactly the point: the boundary is a separate authority domain.
 */
export interface IsolatedToolSpec {
  /** The effect id this tool is registered under (used in durable facts/errors). */
  id: string;
  /** Absolute path of the module the child loads (CJS-requireable). */
  modulePath: string;
  /** Named export implementing `(input, ctx) => Promise<output>`. Default: `default`, else the module itself. */
  exportName?: string;
  /**
   * K7.3 — static egress allowlist, `host:port` entries (port explicit; 80/443
   * implied by the URL scheme must still be listed). All network I/O goes
   * through the brokered `ctx.fetch`; a target not listed here is denied
   * KERNEL-SIDE before any connection, with a durable `EGRESS_DENIED` fact.
   * Omit (or empty) = no egress at all.
   */
  egress?: string[];
  /**
   * K7.4 — credentials injected for THIS tool only. The child's environment is
   * scrubbed: it contains exactly these entries (plus PATH), never the parent's
   * env — an execution cannot name, enumerate, or copy other tools' secrets.
   */
  env?: Record<string, string>;
  /**
   * K7.3 — the most brokered fetches that may be IN FLIGHT for this tool at once.
   * Default 16.
   *
   * The allowlist bounds WHERE a request may go; this bounds HOW MANY. Without
   * it a tool — untrusted by construction, which is the whole premise of the
   * isolate — can issue fetches in a loop without awaiting them and drive
   * unbounded concurrent host-side requests at an allowlisted target, each with
   * a parent-side promise behind it. Excess is refused with `EGRESS_DENIED`,
   * the same durable fact an allowlist miss produces, because it is the same
   * kind of event: the boundary said no.
   *
   * A slot is held from admission until the request is finished AND any DNS lookup it started has
   * settled: on `fetchTimeoutMs` / abort the tool is answered at once, but a still-pending
   * (uncancellable) lookup keeps its slot, so pending lookups in the libuv threadpool are bounded
   * by this cap.
   */
  maxConcurrentFetches?: number;
  /**
   * Kill the child (non-cooperatively) if a run exceeds this. The window opens when the child
   * is READY to begin the run — process spawn and tool-module load are NOT charged to it (L23;
   * they have their own allowance, `coldStartMs`). Otherwise a host whose cold start is slower
   * than `timeoutMs` would kill every run, and since a kill discards the child, the next call
   * would cold-start again: a permanent failure loop.
   */
  timeoutMs?: number;
  /**
   * How long a cold child may take to boot the runner AND load the tool module, measured from
   * spawn, before it is killed and whatever waits on it (a run, `warm()`) fails with
   * `IsolatedToolStartupError`. Independent of `timeoutMs` on purpose (same shape as
   * `@loom/plugin-sandbox`'s `coldStartMs`, ADR 0089 D4). Default 10 000 ms; must be finite and
   * STRICTLY greater than 0 — it is the only clock a cold start is judged against, so 0 would
   * fail every cold start, forever. Set it above this host's real cold start.
   *
   * CAUTION — unlike the sandbox's trusted compile, this window also covers UNTRUSTED code: the
   * tool module's top-level statements run during the load phase. A tool can therefore spend up
   * to `coldStartMs` there, and if it forces a cold start on every call (exiting or being killed)
   * the per-call worst case is `coldStartMs + timeoutMs`. The error's `phase` says which half
   * failed: `"spawn"` (runner never booted: the environment) or `"load"` (the tool's own
   * top-level code hung, exited, or threw: a tool fault).
   */
  coldStartMs?: number;
  /**
   * L24 — the longest a single brokered fetch may take, start to finish (DNS, connect, response),
   * before the host aborts the request and fails the fetch inside the isolate with
   * `code: "FETCH_TIMEOUT"` (and `name: "IsolatedFetchTimeoutError"`) IMMEDIATELY. The
   * `maxConcurrentFetches` slot is freed with the request — except that a DNS lookup cannot be
   * cancelled (getaddrinfo occupies a libuv threadpool thread until it returns), so if the
   * deadline fires while the lookup is still pending the slot stays held until that lookup
   * settles. Pending lookups therefore never exceed `maxConcurrentFetches`. Without it a host that never answers
   * held a slot forever and enough of them starved every later fetch. Default 30 000 ms; must be
   * finite and > 0. Fetches are also aborted when the run that issued them ends or is killed.
   */
  fetchTimeoutMs?: number;
  /** K9.3 delivery semantic, same as ToolEffect's. */
  idempotent?: boolean;
  /**
   * Pre-warm at construction: spawn the persistent child process eagerly so the
   * FIRST `execute` doesn't pay the fork + tool-module-load cold start
   * (~50–200ms). Opt-in — omit for lazy spawn on first use (a warm child that is
   * never invoked just idles until `close()` or process exit). Advisory, so a
   * failed warm falls back to lazy spawn.
   */
  warm?: boolean;
}

/** The response shape the brokered `ctx.fetch` returns inside the child. */
export interface IsolatedFetchResponse {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface IsolatedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * The ctx an ISOLATED tool receives — the marshaled host-function subset of
 * `EffectContext` (K7 amendment A3): scalar identity fields plus `emit`
 * (forwarded to the parent's journal over the IPC channel — messages are
 * ordered, so every emit a completing tool sent lands before its result),
 * `signal` (aborts on parent-side cancellation/timeout; the parent ALSO kills
 * the process — the non-cooperative path), and the brokered `fetch`.
 */
export interface IsolatedToolContext {
  executionId: string;
  stepId: string;
  workflowId: string;
  attempt: number;
  idempotencyKey?: string;
  emit(eventType: string, payload: unknown): void;
  signal: AbortSignal;
  fetch(url: string, init?: IsolatedFetchInit): Promise<IsolatedFetchResponse>;
}

// ── IPC protocol (parent ⇄ child over Node fork() IPC — ordered, JSON) ───────

export interface RunMessage {
  type: "run";
  runId: number;
  modulePath: string;
  exportName?: string;
  input: unknown;
  ctx: {
    executionId: string;
    stepId: string;
    workflowId: string;
    attempt: number;
    idempotencyKey?: string;
  };
}

export interface AbortMessage {
  type: "abort";
  runId: number;
}

export interface FetchResultMessage {
  type: "fetch-result";
  fetchId: number;
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
  /** Typed failure kind, so the tool can tell a deadline from a refusal or a network error. */
  code?: "FETCH_TIMEOUT" | "FETCH_ABORTED";
}

/** Parent asks a fresh child to load the tool module ahead of the first run (cold-start phase). */
export interface WarmMessage {
  type: "warm";
  modulePath: string;
}

export type ParentToChild = RunMessage | AbortMessage | FetchResultMessage | WarmMessage;

export interface EmitMessage {
  type: "emit";
  runId: number;
  eventType: string;
  payload: unknown;
}

export interface FetchMessage {
  type: "fetch";
  runId: number;
  fetchId: number;
  url: string;
  init?: IsolatedFetchInit;
}

export interface ResultMessage {
  type: "result";
  runId: number;
  output: unknown;
}

export interface ErrorMessage {
  type: "error";
  runId: number;
  message: string;
}

/** The runner itself is up (trusted code only; no tool code has run yet). */
export interface BootedMessage {
  type: "booted";
}

/** The tool module's top-level code threw while loading (a tool fault, phase "load"). */
export interface LoadErrorMessage {
  type: "load-error";
  message: string;
}

/** Child finished booting and loading the tool module: a run may now start its clock. */
export interface ReadyMessage {
  type: "ready";
}

export type ChildToParent =
  | BootedMessage
  | LoadErrorMessage
  | ReadyMessage
  | EmitMessage
  | FetchMessage
  | ResultMessage
  | ErrorMessage;

/**
 * Exit code the runner uses when its IPC channel closes (parent gone, or the tool severed it).
 * The parent reads it to tell "the channel closed" from a real crash.
 */
export const RUNNER_DISCONNECT_EXIT_CODE = 70;
