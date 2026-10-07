import type { PrincipalCodec, PrincipalIdentityMode } from "@loom/workflow-runtime";

// ── R3k (ADR 0111 D1) — how the durable principal may carry identity ───────────────────────
//
// The kernel records `{ tenant, actor, onBehalfOf }` on sequence 0 of every execution so its
// effects keep running as the owner. A log is permanent and `eraseSubject` cannot redact a
// plaintext field, so under an erasure obligation that subset must never be written verbatim:
//
//   strict OR a composed compliance plugin ──┬─ crypto composed      → "encrypted" (+ registered paths)
//                                            ├─ principalCodec given → "ref"       (identity never written)
//                                            └─ neither              → REFUSE to compose
//   otherwise                                ──── crypto composed      → "encrypted";  else "verbatim"
//
// Outside strict/compliance the verbatim subset is the zero-config default; its non-redactability
// is a documented non-goal.

/** What a crypto plugin's stores expose for `defineConfig` to register paths on (ADR 0111 D1). */
export interface SensitivePathRegistry {
  registerSensitive(eventType: string, paths: readonly string[]): void;
}
/** The snapshot half: the fold carries the principal at `variables._principal`. */
export interface SensitiveSnapshotRegistry {
  registerSensitive(paths: readonly string[]): void;
}

/**
 * `security.crypto` — the crypto plugin's stores, handed over so `defineConfig` can register the
 * principal's identity paths on them. Pass the SAME instances the app's stores are built from
 * (`EncryptingEventStore`, and `EncryptingSnapshotStore` when snapshots are encrypted).
 */
export interface PrincipalCryptoOptions {
  events: SensitivePathRegistry;
  snapshots?: SensitiveSnapshotRegistry;
}

/** The identity subset's event-payload paths (`EXECUTION_STARTED.principal.identity.*`). */
export const PRINCIPAL_EVENT_PATHS = [
  "principal.identity.tenant",
  "principal.identity.actor",
  "principal.identity.onBehalfOf",
] as const;
/** The same fields in the folded state a snapshot stores. */
export const PRINCIPAL_STATE_PATHS = [
  "variables._principal.identity.tenant",
  "variables._principal.identity.actor",
  "variables._principal.identity.onBehalfOf",
] as const;

/**
 * ADR 0116 — a late outcome's `recordedBy` is the caller's actor (or a codec ref), so it is the
 * same identity and is registered with the crypto plugin alongside the start's subset.
 */
export const OUTCOME_EVENT_PATHS = ["recordedBy"] as const;
export const OUTCOME_STATE_PATHS = ["variables._outcomes[].recordedBy"] as const;

/**
 * `defineConfig` refuses to compose: the app is under an erasure obligation (`security.strict`
 * or a composed compliance plugin) and nothing keeps the principal's identity out of a permanent,
 * un-redactable log. Names the three ways out.
 */
export class PrincipalRecordingRefusedError extends Error {
  readonly retryable = false;
  constructor(readonly because: "strict" | "compliance" | "strict and compliance") {
    super(
      [
        `[loom] cannot compose this app — ${because} means a principal's identity (tenant, actor, onBehalfOf) must never be written verbatim into the log, but neither crypto nor a principalCodec is configured. Do one of:`,
        "  - compose crypto: pass `security.crypto: { events, snapshots }` (your EncryptingEventStore / EncryptingSnapshotStore) so the identity is encrypted at rest and shredded with the subject;",
        "  - supply `security.principalCodec` so the log records only an opaque `ref` (the identity stays in your own table);",
        "  - turn strict / compliance off (`security.strict: false`, no `security.compliance`).",
      ].join("\n")
    );
    this.name = "PrincipalRecordingRefusedError";
  }
}

export interface PrincipalPolicyInput {
  strict: boolean;
  compliance: boolean;
  crypto: PrincipalCryptoOptions | undefined;
  codec: PrincipalCodec | undefined;
}

/** Decide the identity mode, or throw {@link PrincipalRecordingRefusedError}. Pure; registers nothing. */
export function resolvePrincipalIdentity(input: PrincipalPolicyInput): PrincipalIdentityMode {
  if (input.crypto !== undefined) return "encrypted";
  if (!input.strict && !input.compliance) return "verbatim";
  if (input.codec !== undefined) return "ref";
  throw new PrincipalRecordingRefusedError(
    input.strict && input.compliance
      ? "strict and compliance"
      : input.strict
        ? "strict"
        : "compliance"
  );
}

/** Register the identity paths with the crypto plugin's stores (idempotent: the stores union). */
export function registerPrincipalPaths(crypto: PrincipalCryptoOptions): void {
  crypto.events.registerSensitive("EXECUTION_STARTED", PRINCIPAL_EVENT_PATHS);
  crypto.events.registerSensitive("OUTCOME_RECORDED", OUTCOME_EVENT_PATHS);
  crypto.snapshots?.registerSensitive([...PRINCIPAL_STATE_PATHS, ...OUTCOME_STATE_PATHS]);
}
