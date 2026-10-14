import * as fs from "node:fs";
import * as path from "node:path";
import type { LoomApp } from "@loom/app";
import { cmdCheck } from "./check";
import { cmdLintClaimCheck } from "./lintClaimCheck";
import { loadLoomApp } from "./stores";
import { cmdVerify } from "./verify";

// ── `loom doctor` — one front door for the pre-flight checks ─────────────────
//
// The checks were already there: `loom check` (flow-graph, needs a manifest),
// `loom verify` (the @loom/verify rules, needs a config module), `loom lint
// claim-check` (needs a source dir). Three commands, three different inputs,
// and — measured across 22 shipped examples with 53 `defineConfig` call sites —
// zero apps running any of them. Fragmentation is the most plausible reason: a
// developer has to know all three exist before they can run one.
//
// This adds no checking capability whatsoever. It discovers the inputs, runs
// what it can, and — the part that matters — REPORTS WHAT IT SKIPPED AND WHY.
// A doctor that quietly runs one of three checks and prints "healthy" is worse
// than no doctor, because the green is cited as evidence. Every skip names the
// flag that would have enabled it.

export type DoctorStatus = "ok" | "failed" | "skipped" | "advisory";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  /** Why it was skipped, what failed, or what the advisory depends on. */
  detail: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  /** False if any check FAILED. A skipped check never fails the run — it is reported. */
  ok: boolean;
}

/** First existing candidate, or undefined. */
function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((c) => fs.existsSync(c));
}

const CONFIG_CANDIDATES = [
  "loom.config.js",
  "loom.config.mjs",
  "dist/loom.config.js",
  "dist/config.js",
];

export async function cmdDoctor(opts: {
  dir?: string;
  config?: string;
  manifest?: string;
}): Promise<{ text: string; result: DoctorResult }> {
  const dir = path.resolve(opts.dir ?? ".");
  const checks: DoctorCheck[] = [];
  const loadedApp = appLoader();

  // 1. Flow-graph checks over the compiler manifest.
  const manifest =
    opts.manifest !== undefined
      ? path.resolve(opts.manifest)
      : firstExisting([
          path.join(dir, "loom-manifest.json"),
          path.join(dir, "dist", "loom-manifest.json"),
        ]);
  if (manifest === undefined) {
    checks.push({
      name: "flow-graph (loom check)",
      status: "skipped",
      detail: "no loom-manifest.json found — build with the Loom compiler, or pass --manifest",
    });
  } else {
    try {
      const { result } = cmdCheck(manifest);
      checks.push({
        name: "flow-graph (loom check)",
        status: result.ok ? "ok" : "failed",
        detail: result.ok ? manifest : result.issues.join("; "),
      });
    } catch (err) {
      checks.push({ name: "flow-graph (loom check)", status: "failed", detail: String(err) });
    }
  }

  // 2. The @loom/verify rules. Needs a BUILT config module — the one input that
  //    cannot be discovered from source alone.
  const config =
    opts.config !== undefined
      ? path.resolve(opts.config)
      : firstExisting(CONFIG_CANDIDATES.map((c) => path.join(dir, c)));
  if (config === undefined) {
    checks.push({
      name: "runtime verification (loom verify)",
      status: "skipped",
      detail:
        "no built config module found — pass --config <module> exporting a LoomApp (build to JS first, or run under tsx)",
    });
  } else {
    try {
      const { result } = await cmdVerify(config, manifest);
      const errors = result.findings.filter((f) => f.severity === "error").length;
      const warns = result.findings.filter((f) => f.severity === "warn").length;
      // V5 — carry the rules' own coverage notes through the front door. Flattening a report
      // to "0 errors" is exactly how a partial check gets cited as a complete one, which is
      // the thing this command exists to prevent.
      const notes = result.findings.filter((f) => f.severity === "info");
      const counts = `${result.checked.length} rule(s), ${errors} error(s), ${warns} warning(s)`;
      checks.push({
        name: "runtime verification (loom verify)",
        status: result.ok ? (notes.length > 0 ? "advisory" : "ok") : "failed",
        detail:
          notes.length === 0
            ? counts
            : `${counts} — ${notes.length} rule(s) reported partial coverage: ${notes[0]?.message ?? ""}`,
      });
    } catch (err) {
      checks.push({
        name: "runtime verification (loom verify)",
        status: "failed",
        detail: String(err),
      });
    }
  }

  // 3. The memory store behind `app.memory` and every corpus. Two failure modes, both
  //    silent at boot and loud (or worse, quiet) much later.
  if (config === undefined) {
    checks.push({
      name: "memory store (durability + relevance recall)",
      status: "skipped",
      detail: "no built config module found — pass --config <module> exporting a LoomApp",
    });
  } else {
    checks.push(memoryStoreCheck(await loadedApp(config)));
  }

  // 4. Durable timers: can this deployment wake, and does anything own a wake.
  if (config === undefined) {
    for (const name of [TIMER_CHECK, OWNERSHIP_CHECK]) {
      checks.push({
        name,
        status: "skipped",
        detail: "no built config module found — pass --config <module> exporting a LoomApp",
      });
    }
  } else {
    checks.push(...timerChecks(await loadedApp(config)));
  }

  // 4b. ADR 0130 D11 heartbeat leases: is the liveness evidence cluster-visible and true?
  if (config === undefined) {
    checks.push({
      name: HEARTBEAT_CHECK,
      status: "skipped",
      detail: "no built config module found — pass --config <module> exporting a LoomApp",
    });
  } else {
    checks.push(heartbeatCheck(await loadedApp(config)));
  }

  // 5. Encrypted-at-rest durability: are the keys going to outlive the process?
  if (config === undefined) {
    checks.push({
      name: KEYS_CHECK,
      status: "skipped",
      detail: "no built config module found — pass --config <module> exporting a LoomApp",
    });
  } else {
    const loaded = await loadedApp(config);
    checks.push(encryptionKeyCheck(loaded));
    checks.push(plaintextSnapshotCheck(loaded));
    checks.push(archiveSnapshotCheck(loaded));
  }

  // 6. Claim-check reach-through (CC-5) over the source tree.
  try {
    const { findings } = cmdLintClaimCheck(dir);
    checks.push({
      name: "claim-check reach-through (loom lint)",
      status: findings.length === 0 ? "ok" : "failed",
      detail: findings.length === 0 ? dir : `${findings.length} finding(s)`,
    });
  } catch (err) {
    checks.push({
      name: "claim-check reach-through (loom lint)",
      status: "failed",
      detail: String(err),
    });
  }

  const result: DoctorResult = { checks, ok: !checks.some((c) => c.status === "failed") };
  return { text: formatDoctor(result), result };
}

/**
 * Is the configured memory store durable, and can it retrieve by relevance?
 *
 * The default is an in-memory store, which is right for a test and is the shape ADR 0090
 * opened with: an agent that restarted remembered nothing, and nothing said so. That is
 * reported as a SKIP rather than a failure, because a browser app or a test suite wants
 * exactly that — but the skip names it, so a partial-coverage line appears instead of a
 * clean bill of health.
 *
 * A store that IS configured and has no `search` is a failure. `recallRelevant` and
 * `KnowledgeBase.retrieve` refuse such a store at run time rather than degrading to the
 * newest N (ADR 0090 D3), so the app is one relevance query away from throwing — and
 * somebody chose that backend deliberately, which is what makes it a misconfiguration
 * rather than a default.
 */
function memoryStoreCheck(loaded: Partial<LoomApp> | Error): DoctorCheck {
  const name = "memory store (durability + relevance recall)";
  try {
    if (loaded instanceof Error) throw loaded;
    const store = (loaded as { stores?: { memoryStore?: { search?: unknown } } }).stores
      ?.memoryStore;
    if (store === undefined) {
      return {
        name,
        status: "skipped",
        detail:
          "no `memoryStore` configured — agent memory and any corpus live in the in-memory default and are LOST ON RESTART; pass memoryStore: new SqliteMemoryStore(...) to persist them",
      };
    }
    if (typeof store.search !== "function") {
      return {
        name,
        status: "failed",
        detail:
          "the configured memoryStore does not implement the optional `search` — recallRelevant() and KnowledgeBase.retrieve() REFUSE such a store rather than degrading to the newest N, so any relevance retrieval will throw at run time",
      };
    }
    return { name, status: "ok", detail: "configured, durable, and implements search()" };
  } catch (err) {
    return { name, status: "failed", detail: String(err) };
  }
}

const KEYS_CHECK = "encryption keys (will the log still be readable?)";

/**
 * K10 crypto-shredding turns the key into the erasure boundary — which means LOSING a key is
 * indistinguishable from shredding the subject. An encrypting store wired to keys that live
 * in a Map has a durable log whose contents evaporate on restart, and nothing fails at the
 * moment it happens: the writes succeed, and the data is unreadable from the next boot.
 *
 * Until now the only protection was prose — a README saying "back it with a KMS in
 * production". This is that sentence, enforced.
 *
 * Read structurally (`.keys.durable`) so the CLI does not depend on @loom/plugin-crypto:
 * a third party's own encrypting wrapper gets the same check for free by exposing the same
 * property.
 */
function encryptionKeyCheck(loaded: Partial<LoomApp> | Error): DoctorCheck {
  if (loaded instanceof Error) {
    return { name: KEYS_CHECK, status: "failed", detail: String(loaded) };
  }
  const wrappers = [
    ["eventStore", loaded.stores?.eventStore],
    ["snapshotStore", loaded.stores?.snapshotStore],
  ] as const;
  /** The KeyStore an encrypting wrapper exposes, or undefined for a plain store. */
  const keysOf = (store: unknown): { durable?: boolean } | undefined => {
    const keys = (store as { keys?: unknown } | undefined)?.keys;
    return typeof keys === "object" && keys !== null ? (keys as { durable?: boolean }) : undefined;
  };
  const encrypting = wrappers.filter(([, store]) => keysOf(store) !== undefined);

  if (encrypting.length === 0) {
    return {
      name: KEYS_CHECK,
      status: "skipped",
      detail: "no encrypting store wired — nothing here depends on key durability",
    };
  }

  const where = encrypting.map(([name]) => name).join(" + ");
  const ephemeral = encrypting.filter(([, store]) => keysOf(store)?.durable === false);
  if (ephemeral.length > 0) {
    return {
      name: KEYS_CHECK,
      status: "failed",
      detail: `${where} encrypts at rest with keys that declare themselves NON-DURABLE. Every encrypted field becomes permanently unreadable when this process ends — the log survives, its contents do not, and nothing fails at the time. Back it with a KMS/HSM or any KeyStore that persists.`,
    };
  }

  const undeclared = encrypting.filter(([, store]) => keysOf(store)?.durable === undefined);
  if (undeclared.length > 0) {
    return {
      name: KEYS_CHECK,
      status: "advisory",
      detail: `${where} encrypts at rest, and its KeyStore does not declare whether it survives a restart (\`KeyStore.durable\`). If it does not, every encrypted field is unreadable from the next boot. Declare it either way so this check can answer.`,
    };
  }

  return { name: KEYS_CHECK, status: "ok", detail: `${where} encrypts with a durable KeyStore` };
}

const SNAPSHOT_SEAL_CHECK = "snapshot-plaintext-under-encrypting-events";
const ARCHIVE_SEAL_CHECK = "archive-snapshot-plaintext-under-encrypting-events";

/**
 * ADR 0130 D8 - the retention ARCHIVE snapshot store gets the same rule as the runtime's: when the
 * event store seals, an archive snapshot store must report `sealsWholeState === true` AND share the
 * event store's KeyStore, or `LogLifecycle` refuses the archive as `unsafe-archive`.
 */
function archiveSnapshotCheck(loaded: Partial<LoomApp> | Error): DoctorCheck {
  if (loaded instanceof Error) {
    return { name: ARCHIVE_SEAL_CHECK, status: "failed", detail: String(loaded) };
  }
  const archive = (loaded.lifecycle as { archiveSnapshotStore?: unknown } | undefined)
    ?.archiveSnapshotStore as { keys?: unknown; sealsWholeState?: unknown } | undefined;
  const eventStore = loaded.stores?.eventStore as
    | { keys?: unknown; sealingCapability?: () => { covers?: readonly unknown[] } | undefined }
    | undefined;
  if (archive === undefined) {
    return {
      name: ARCHIVE_SEAL_CHECK,
      status: "skipped",
      detail: "no archive snapshot store is wired",
    };
  }
  let covers: readonly unknown[] | undefined;
  try {
    covers = eventStore?.sealingCapability?.()?.covers;
  } catch (err) {
    return {
      name: ARCHIVE_SEAL_CHECK,
      status: "failed",
      detail: `the event store's sealingCapability() threw: ${String(err)}`,
    };
  }
  const eventSeals =
    (covers !== undefined && covers.length > 0) ||
    (typeof eventStore?.keys === "object" && eventStore.keys !== null);
  if (!eventSeals) {
    return { name: ARCHIVE_SEAL_CHECK, status: "skipped", detail: "the event store seals nothing" };
  }
  // Mirror `LogLifecycle.archiveIsSafe` exactly, so this message is never false: the key-identity rule
  // applies only when the event store exposes `keys`; the whole-state rule only when it COVERS something.
  const eventKeys =
    typeof eventStore?.keys === "object" && eventStore.keys !== null ? eventStore.keys : undefined;
  const coversSomething = covers !== undefined && covers.length > 0;
  const keysOk = eventKeys === undefined || archive.keys === eventKeys;
  const wholeOk = !coversSomething || archive.sealsWholeState === true;
  if (keysOk && wholeOk) {
    return {
      name: ARCHIVE_SEAL_CHECK,
      status: "ok",
      detail: coversSomething
        ? "the archive snapshot store seals the whole folded state under the event store's KeyStore"
        : "the archive snapshot store shares the event store's KeyStore; the event store covers no path right now (once it does, the archive store must also seal the WHOLE state)",
    };
  }
  const allowed =
    (loaded as { security?: { crypto?: { allowPlaintextCheckpoints?: unknown } } }).security?.crypto
      ?.allowPlaintextCheckpoints === true;
  const fix =
    "Fix: build the archive snapshot store with `new EncryptingSnapshotStore(inner, keys, { sealState: true })` over the SAME KeyStore as the event store, or set `security.crypto.allowPlaintextCheckpoints: true`.";
  if (allowed) {
    return {
      name: ARCHIVE_SEAL_CHECK,
      status: "advisory",
      detail: `the archive snapshot store does not seal the whole state under the event store's KeyStore; \`allowPlaintextCheckpoints\` is set, so retention will archive plaintext checkpoints. ${fix}`,
    };
  }
  return {
    name: ARCHIVE_SEAL_CHECK,
    status: "failed",
    detail: `the event store seals payloads but the archive snapshot store does not seal the whole state under its KeyStore: retention refuses to archive ("unsafe-archive"), so nothing is reclaimed. ${fix}`,
  };
}

/**
 * ADR 0130 D8 — an event store that seals payloads beside a snapshot store that does not seal
 * the WHOLE folded state leaves the sealed data in plaintext in the checkpoint: a static
 * `sensitive` path list cannot name the dynamic `variables._waitAnswers.<waitId>` keys. Ships
 * BEFORE the kernel refuses to boot on it, so an operator can see it first.
 *
 * Read structurally, as {@link encryptionKeyCheck}: the event store seals iff it reports a
 * `sealingCapability()` with covers, or exposes a `keys` KeyStore; the snapshot store is fine
 * iff `sealsWholeState === true` AND it shares the event store's KeyStore.
 *
 * Residual, by design: this reads the WIRING, not the data at rest. It cannot say how many
 * plaintext snapshots a `sealState` store still holds, because `SnapshotStore` has no enumerating
 * method (only point reads by execution id), so a census would be a full scan per backend. Old
 * snapshots stay readable and are sealed by the next save; `legacyPlaintext: "refuse"` on the
 * store is the way to forbid them once none remain.
 */
function plaintextSnapshotCheck(loaded: Partial<LoomApp> | Error): DoctorCheck {
  if (loaded instanceof Error) {
    return { name: SNAPSHOT_SEAL_CHECK, status: "failed", detail: String(loaded) };
  }
  const eventStore = loaded.stores?.eventStore as
    | { keys?: unknown; sealingCapability?: () => { covers?: readonly unknown[] } | undefined }
    | undefined;
  const snapshotStore = loaded.stores?.snapshotStore as
    | { keys?: unknown; sealsWholeState?: unknown }
    | undefined;
  let covers: readonly unknown[] | undefined;
  try {
    covers = eventStore?.sealingCapability?.()?.covers;
  } catch (err) {
    return {
      name: SNAPSHOT_SEAL_CHECK,
      status: "failed",
      detail: `the event store's sealingCapability() threw: ${String(err)}`,
    };
  }
  const eventSeals =
    (covers !== undefined && covers.length > 0) ||
    (typeof eventStore?.keys === "object" && eventStore.keys !== null);
  if (!eventSeals) {
    return {
      name: SNAPSHOT_SEAL_CHECK,
      status: "skipped",
      detail: "the event store seals nothing — a plaintext checkpoint leaks nothing sealed",
    };
  }
  if (snapshotStore === undefined) {
    return {
      name: SNAPSHOT_SEAL_CHECK,
      status: "ok",
      detail: "the event store seals and no snapshot store is wired (no checkpoint to leak)",
    };
  }
  const allowed =
    (loaded as { security?: { crypto?: { allowPlaintextCheckpoints?: unknown } } }).security?.crypto
      ?.allowPlaintextCheckpoints === true;
  const sharesKeys =
    typeof eventStore?.keys === "object" &&
    eventStore.keys !== null &&
    snapshotStore.keys === eventStore.keys;
  if (snapshotStore.sealsWholeState === true && sharesKeys) {
    return {
      name: SNAPSHOT_SEAL_CHECK,
      status: "ok",
      detail: "the snapshot store seals the whole folded state under the event store's KeyStore",
    };
  }
  const hasKeys = typeof snapshotStore.keys === "object" && snapshotStore.keys !== null;
  const fix =
    "Fix: build the snapshot store with `new EncryptingSnapshotStore(inner, keys, { sealState: true })` using the SAME KeyStore as the event store, or set `security.crypto.allowPlaintextCheckpoints: true` to accept a plaintext checkpoint (for example on an encrypted volume, or while migrating). Without one of the two, the kernel refuses to boot (ADR 0130 D8).";
  if (allowed) {
    return {
      name: SNAPSHOT_SEAL_CHECK,
      status: "advisory",
      detail:
        "the event store seals but the snapshot store does not seal the whole state; `security.crypto.allowPlaintextCheckpoints` is set on this config (ADR 0130 D8), so the kernel accepts it. The checkpoint holds the folded state (including `variables._waitAnswers`) in plaintext.",
    };
  }
  if (hasKeys && snapshotStore.sealsWholeState !== true) {
    return {
      name: SNAPSHOT_SEAL_CHECK,
      status: "advisory",
      detail: `the snapshot store encrypts only static \`sensitive\` paths. Those cannot name the dynamic \`variables._waitAnswers.<waitId>\` keys, so a resumed wait's answer stays plaintext in the checkpoint. ${fix}`,
    };
  }
  return {
    name: SNAPSHOT_SEAL_CHECK,
    status: "failed",
    detail: `the event store seals payloads but the snapshot store ${hasKeys ? "does not share its KeyStore" : "is plaintext"}: the checkpoint writes the folded state (including \`variables._waitAnswers\`) unsealed, and a shred cannot erase it. The kernel refuses to boot on this (ADR 0130 D8). ${fix}`,
  };
}

const TIMER_CHECK = "durable timers (can this deployment wake?)";
const OWNERSHIP_CHECK = "timer wake ownership (does anything own a wake?)";

/**
 * Two questions about timers that nothing else asks.
 *
 * Neither is a lint over source: both read what the COMPOSITION wired, which is the only
 * place the answer lives. `defineConfig` already warns at boot when schedules are declared
 * with no store — this is the same fact where an operator will see it before deploying, plus
 * the ownership question, which nothing warned about at all.
 */
/**
 * Load the app once per RUN, and hand the same result to every check that needs it — a
 * failure to load is one fact about the deployment, not one per check.
 *
 * Deliberately not a module-level cache: that would never invalidate, so a long-lived
 * process would answer from a stale composition and the map would only grow.
 */
function appLoader(): (configPath: string) => Promise<Partial<LoomApp> | Error> {
  let loaded: Promise<Partial<LoomApp> | Error> | undefined;
  return (configPath) => {
    loaded ??= loadLoomApp(configPath).catch((err: unknown) =>
      err instanceof Error ? err : new Error(String(err))
    );
    return loaded;
  };
}

const HEARTBEAT_CHECK = "heartbeat leases (ADR 0130 D11)";

/**
 * Heartbeat leases make "a lease existed and expired" evidence of an abandoned driver. That is
 * only true when every node sees the same lease table, and only while a store outage cannot
 * leave a live driver holding an expired lease.
 */
function heartbeatCheck(loaded: Partial<LoomApp> | Error): DoctorCheck {
  if (loaded instanceof Error)
    return { name: HEARTBEAT_CHECK, status: "failed", detail: String(loaded) };
  const hb = loaded.heartbeat;
  if (hb === undefined)
    return {
      name: HEARTBEAT_CHECK,
      status: "skipped",
      detail: "this app does not report a heartbeat decision (built with an older @loom/app)",
    };
  if (!hb.enabled && hb.source === "off")
    return {
      name: HEARTBEAT_CHECK,
      status: "skipped",
      detail:
        "`durability.heartbeat.enabled: false` — drivers hold no lease; behaviour as before ADR 0130 D11",
    };
  if (!hb.enabled)
    return {
      name: HEARTBEAT_CHECK,
      status: "advisory",
      detail:
        "heartbeat disabled: a durable event store and no cluster-visible lease store could be derived (the storage preset exposes no `leaseStore`). Drivers hold no lease, so the poll re-drive keeps needing a host `isAbandoned`. Use a preset that exposes `leaseStore`, or set `durability.heartbeat.store`",
    };
  if (hb.storeInMemory && !hb.eventStoreInMemory)
    return {
      name: HEARTBEAT_CHECK,
      status: "failed",
      detail:
        "an in-memory lease store beside a durable event store: meaningless evidence across nodes — every other node sees no lease for this node's executions. Use the co-located lease store (`leaseStore` from the storage preset) or a shared one",
    };
  if (hb.onStoreError === "continue")
    return {
      name: HEARTBEAT_CHECK,
      status: "advisory",
      detail:
        "`onStoreError: \"continue\"` — drivers keep running through a lease-store outage, so an expired lease no longer proves liveness: this fleet's leases are HEURISTIC, the poll's default re-drive is OFF for it, and a refused execution is re-driven only with a host `isAbandoned` (an unexpired lease still vetoes it). The fence still protects the log",
    };
  const scope = hb.scope ?? "unknown";
  if (scope === "host")
    return {
      name: HEARTBEAT_CHECK,
      status: "advisory",
      detail: `lease store is visible to ONE host only: evidence holds only if every node shares it, so the poll's default re-drive stays OFF (${hb.source}, scope host)`,
    };
  if (scope === "unknown")
    return {
      name: HEARTBEAT_CHECK,
      status: "advisory",
      detail: `lease store scope is unknown (it declares no \`scope\`): cannot tell whether every node sees the same leases, so the poll's default re-drive stays OFF (${hb.source})`,
    };
  return {
    name: HEARTBEAT_CHECK,
    status: "ok",
    detail: `heartbeat leases on (${hb.source}, scope ${scope})`,
  };
}

function timerChecks(loaded: Partial<LoomApp> | Error): DoctorCheck[] {
  if (loaded instanceof Error) {
    return [TIMER_CHECK, OWNERSHIP_CHECK].map((name) => ({
      name,
      status: "failed" as const,
      detail: String(loaded),
    }));
  }
  const app = loaded;

  const timerStore = app.stores?.timerStore;
  const leaseStore = app.stores?.leaseStore;
  const schedules = app.schedules ?? [];
  // Gates are the one suspend surface that IS declared (ADR 0077 resumeSchemas); a timeout on
  // one lives in the runner body, where nothing static can see it.
  const gated = (app.runtime?.getFlowIds() ?? []).filter(
    (id) => Object.keys(app.runtime?.getFlow(id)?.definition.resumeSchemas ?? {}).length > 0
  );

  const timers: DoctorCheck =
    timerStore !== undefined
      ? {
          name: TIMER_CHECK,
          status: "ok",
          detail: `TimerStore wired${schedules.length > 0 ? `; ${schedules.length} schedule(s) can fire` : ""}`,
        }
      : schedules.length > 0
        ? {
            name: TIMER_CHECK,
            status: "failed",
            detail: `${schedules.length} schedule(s) declared and no \`timers: { store }\` — they can never fire`,
          }
        : gated.length > 0
          ? {
              name: TIMER_CHECK,
              status: "advisory",
              detail: `no \`timers: { store }\`, and ${gated.length} flow(s) declare resume gates — any \`ctx.sleep\` or \`suspend({ timeout })\` will never wake. Timeouts live in the runner body, so this is inference from the gates, not proof: \`suspension-safety\` sees real suspend points only when you build with the Loom compiler and pass --manifest (ADR 0086 reach analysis); without one it is silent about them rather than clean`,
            }
          : {
              name: TIMER_CHECK,
              status: "skipped",
              detail:
                "no `timers: { store }` and nothing declared that needs one (no schedules, no resume gates)",
            };

  const ownership: DoctorCheck =
    timerStore === undefined
      ? {
          name: OWNERSHIP_CHECK,
          status: "skipped",
          detail: "no timers configured, so there are no wakes to own",
        }
      : leaseStore !== undefined
        ? {
            name: OWNERSHIP_CHECK,
            status: "ok",
            detail: "`timers.leases` wired — a wake is claimed before it runs",
          }
        : {
            name: OWNERSHIP_CHECK,
            status: "advisory",
            detail:
              "a TimerStore with no `timers.leases`: if more than one process polls it, every node resumes the same due execution. Fencing (K9.4) makes that safe, not cheap — the loser still pays for its effects up to the point it loses. Harmless on a single node; wire `timers.leases` before there are two",
          };

  return [timers, ownership];
}

const GLYPH: Record<DoctorStatus, string> = { ok: "✓", failed: "✗", skipped: "–", advisory: "!" };

export function formatDoctor(result: DoctorResult): string {
  const lines = result.checks.map((c) => `  ${GLYPH[c.status]} ${c.name}\n      ${c.detail}`);
  const skipped = result.checks.filter((c) => c.status === "skipped").length;
  // Say the coverage out loud. "3 ok" and "1 ok, 2 skipped" must not read the same.
  const advisories = result.checks.filter((c) => c.status === "advisory").length;
  const caveats = [
    ...(skipped > 0 ? [`${skipped} could not run — coverage is partial`] : []),
    ...(advisories > 0 ? [`${advisories} advisory (depends on how you deploy)`] : []),
  ];
  // Caveats belong on BOTH branches: a failing run still needs to say what it could not
  // check, or fixing the failure reveals coverage the reader thought they already had.
  const base = result.ok ? "all checks passed" : "FAILED";
  const summary =
    caveats.length === 0
      ? base
      : result.ok
        ? `passed, but ${caveats.join("; ")}`
        : `FAILED — also: ${caveats.join("; ")}`;
  return `loom doctor\n\n${lines.join("\n")}\n\n${summary}\n`;
}
