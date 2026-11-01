// ── ADR 0144 D1/D2/D4 — the sandbox backend SPI ──────────────────────────────

/** What a backend is asked to run. Everything here is already verified and bounded by the effect. */
export interface SandboxRequest {
  /** Verified source text (its bytes matched their content address). */
  script: string;
  /** The caller's input, already JSON text and already within `maxInputBytes`. */
  inputJson: string;
  limits: { wallClockMs: number; memoryBytes: number };
  /** Aborted on cancellation. A backend should stop work; the effect ignores its outcome regardless. */
  signal?: AbortSignal;
}

/**
 * What happened, in a closed vocabulary. The backend reports; loom decides what it MEANS
 * (which channel, in which order, bounded how). A backend never throws a typed failure.
 */
export type SandboxOutcome =
  | { ok: true; value: unknown }
  | { ok: false; kind: "limit"; limit: "cpu" | "memory" | "wallClock" }
  | { ok: false; kind: "threw"; name?: string; message: string }
  /** The input overflowed memory while being parsed, before the script ran. */
  | { ok: false; kind: "inputTooLarge" }
  | { ok: false; kind: "infrastructure"; message: string };

/** What a backend enforces. The effect refuses what it cannot vouch for (ADR 0144 D4). */
export interface SandboxBackendCapabilities {
  /** `"javascript"`, `"python"`, … — selects the conformance fixtures. */
  language: string;
  /** Egress the script can reach. Anything but `"none"` needs `allowNetwork: true`. */
  network: "none" | "allowlist" | "open";
  /** `"hard"`: the run is killed at the deadline (plus grace). `"soft"`: checked cooperatively. */
  wallClock: "hard" | "soft";
  /** `memoryBytes` is enforced. */
  memory: boolean;
  /** A CPU budget is enforced. */
  cpu: boolean;
  /** No state survives from one run to the next. `false` needs `allowReusedEnvironment: true`. */
  freshPerRun: boolean;
}

export interface SandboxBackend {
  readonly capabilities: SandboxBackendCapabilities;
  evaluate(request: SandboxRequest): Promise<SandboxOutcome>;
  /** Advisory pre-warm (M6). */
  warm?(): Promise<void>;
  /** Release pools, connections, instances. */
  close?(): Promise<void>;
}
