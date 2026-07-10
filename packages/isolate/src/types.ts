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
  /** Kill the child (non-cooperatively) if a run exceeds this. */
  timeoutMs?: number;
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
}

export type ParentToChild = RunMessage | AbortMessage | FetchResultMessage;

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

export type ChildToParent = EmitMessage | FetchMessage | ResultMessage | ErrorMessage;
