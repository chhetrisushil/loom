import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LoomApp } from "@loom/app";
import type { BranchRegistry, EventStore, LeaseStore, TimerStore } from "@loom/event-runtime";
import {
  SqliteBranchRegistry,
  SqliteEventStore,
  SqliteLeaseStore,
  SqliteSnapshotStore,
} from "@loom/plugin-sqlite";
import type { SnapshotStore } from "@loom/snapshot-runtime";
import type { ArchiveStores, WorkflowRuntime } from "@loom/workflow-runtime";
import { CliError } from "./args";

// ── Where an operator command gets its storage ───────────────────────────────
//
// Loom's premise is that storage is yours: `storage: { kind: "custom", … }`, symmetric 1P/3P
// plugins (ADR 0043), conformance kits so a third-party store is a first-class one. A CLI that
// recognises `postgres://` and a file path would bless exactly two backends and leave every
// other conforming store unreachable by every diagnostic — it does not generalise, it moves
// the wall.
//
// So this knows NO backends. It asks the application (`--config`), which is the convention
// `loom verify` already uses. `--db` stays as the SQLite shorthand: a dev machine with loose
// files is a real front door, and it is how every existing invocation is spelled.

export interface ResolvedStores {
  eventStore: EventStore;
  /**
   * Absent on the `--db` path unless `--snap` was given. Without one every state folds from
   * the log: slower and identical, so a caller substitutes an in-memory store rather than
   * demanding the deployment's full wiring.
   */
  snapshotStore?: SnapshotStore;
  branchRegistry?: BranchRegistry;
  leaseStore?: LeaseStore;
  timerStore?: TimerStore;
  /**
   * The app's own runtime — present only on the `--config` path, because only a composition
   * has the flows and effects registered.
   *
   * It is the difference between a pass that can LOOK and one that can ACT: folding state
   * needs nothing but the log, while re-driving an execution runs its steps. A command that
   * writes must refuse the `--db` shorthand rather than re-drive into an empty registry.
   */
  runtime?: WorkflowRuntime;
  /**
   * The archive retention copies into — `durability.retention.archive`, present only on the
   * `--config` path (the `--db` shorthand names archives with its own flags).
   */
  archive?: ArchiveStores;
  /** How these were resolved — messages about what is MISSING must say which half to fix. */
  origin: "config" | "db";
  close(): Promise<void>;
}

export interface StoreFlags {
  config?: string;
  db?: string;
  snap?: string;
  branches?: string;
  leases?: string;
}

/** True when the caller gave enough to resolve anything at all. */
export function hasStoreFlags(flags: StoreFlags): boolean {
  return flags.config !== undefined || flags.db !== undefined;
}

export const STORE_FLAG_HELP =
  "pass --config <module> (your app's stores, any backend) or --db <events.db> (SQLite shorthand)";

/**
 * Resolve the stores an operator command should read.
 *
 * `--config` wins when both are given: it is the specific answer, and silently preferring the
 * shorthand would point a command at a different deployment than the one named.
 */
export async function resolveStores(flags: StoreFlags): Promise<ResolvedStores> {
  if (flags.config !== undefined) return await fromConfig(flags.config);
  if (flags.db !== undefined) return fromSqlite(flags);
  throw new Error(`no storage given: ${STORE_FLAG_HELP}`);
}

/**
 * Load a config module whether it is CommonJS or ESM.
 *
 * This package compiles to CommonJS, and `tsc` downlevels a literal `import()` into
 * `require()` — which cannot load an ESM module at all, and cannot load a `file://` URL.
 * Unit tests run through esbuild's ESM pipeline and never see it; the built binary fails on
 * the first line. So: `require` for CJS (the shape `loom verify` has always assumed), and a
 * real dynamic import — hidden from the compiler behind `new Function` — for ESM, including
 * modules with top-level await, which `require(esm)` refuses even on Node 22+.
 */
async function loadModule(file: string): Promise<Record<string, unknown>> {
  try {
    return require(file) as Record<string, unknown>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ERR_REQUIRE_ESM" && code !== "ERR_REQUIRE_ASYNC_MODULE") throw err;
    const url = pathToFileURL(file).href;
    try {
      // Hidden from the compiler: a literal `import()` in this CommonJS build becomes
      // `require()`, which is what we are escaping.
      const esmImport = new Function("u", "return import(u)") as (
        u: string
      ) => Promise<Record<string, unknown>>;
      return await esmImport(url);
    } catch (viaFunction) {
      // Vitest evaluates this file in a VM with no dynamic-import callback, so the trick
      // above cannot run there — but there the pipeline is already ESM, so the literal
      // `import()` is a REAL import and is never downlevelled. Each path covers exactly
      // where the other cannot go.
      if (!/dynamic import callback/i.test(String(viaFunction))) throw viaFunction;
      return (await import(url)) as Record<string, unknown>;
    }
  }
}

/**
 * Load an app from its config module without running it.
 *
 * `LOOM_NO_AUTOSTART` is set BEFORE the import because composing an app starts its timer
 * service, and that happens while the module is evaluated — a read-only command must not fire
 * due timers and scheduled flows as a side effect of being pointed at a deployment.
 *
 * Shared so every command that loads a config gets that guarantee, rather than each one
 * remembering to: `loom doctor` used a bare `require` and therefore did start it.
 */
export async function loadLoomApp(modulePath: string): Promise<Partial<LoomApp>> {
  process.env.LOOM_NO_AUTOSTART = "1";
  const mod = await loadModule(path.resolve(modulePath));
  return (mod.default ?? mod.app ?? mod) as Partial<LoomApp>;
}

async function fromConfig(modulePath: string): Promise<ResolvedStores> {
  const app = await loadLoomApp(modulePath);
  if (app.stores?.eventStore === undefined) {
    throw new Error(
      `${modulePath} must default-export a LoomApp from defineConfig(...) (no stores found)`
    );
  }
  const { eventStore, snapshotStore, branchRegistry, leaseStore, timerStore } = app.stores;
  return {
    eventStore,
    snapshotStore,
    ...(app.runtime !== undefined && { runtime: app.runtime }),
    ...(branchRegistry !== undefined && { branchRegistry }),
    ...(leaseStore !== undefined && { leaseStore }),
    ...(timerStore !== undefined && { timerStore }),
    ...(app.lifecycle?.archive !== undefined && { archive: app.lifecycle.archive }),
    origin: "config",
    close: async () => {
      await app.close?.();
    },
  };
}

/**
 * `--db` names a store that already exists. A SQLite open CREATES a missing file, so a mistyped
 * path used to answer "(no events)" (exit 0) and leave an empty database behind — a typo read
 * as "nothing happened". Refuse before opening anything, naming the absolute path and cwd.
 */
function requireExistingFile(flag: string, file: string): void {
  if (file === ":memory:" || file.startsWith("file:")) return;
  if (fs.existsSync(file)) return;
  throw new CliError(
    `--${flag}: no such file ${path.resolve(file)} (cwd ${process.cwd()}) — not creating it. Check the path.`
  );
}

function fromSqlite(flags: StoreFlags): ResolvedStores {
  requireExistingFile("db", flags.db as string);
  if (flags.snap !== undefined) requireExistingFile("snap", flags.snap);
  if (flags.branches !== undefined) requireExistingFile("branches", flags.branches);
  if (flags.leases !== undefined) requireExistingFile("leases", flags.leases);
  const eventStore = new SqliteEventStore(flags.db as string);
  // Optional by design: without a snapshot store every state folds from the log — slower and
  // identical. A diagnostic must not require the deployment's full wiring.
  const snapshotStore = flags.snap !== undefined ? new SqliteSnapshotStore(flags.snap) : undefined;
  const branchRegistry =
    flags.branches !== undefined ? new SqliteBranchRegistry(flags.branches) : undefined;
  const leaseStore = flags.leases !== undefined ? new SqliteLeaseStore(flags.leases) : undefined;
  return {
    eventStore,
    ...(snapshotStore !== undefined && { snapshotStore }),
    ...(branchRegistry !== undefined && { branchRegistry }),
    ...(leaseStore !== undefined && { leaseStore }),
    origin: "db",
    close: async () => {
      await eventStore.close();
      await snapshotStore?.close();
      await branchRegistry?.close();
      await leaseStore?.close();
    },
  };
}

/** Parsed CLI flags → the subset that decides where storage comes from. */
export function storeFlagsOf(flags: Record<string, string | undefined>): StoreFlags {
  return {
    ...(flags.config !== undefined && { config: flags.config }),
    ...(flags.db !== undefined && { db: flags.db }),
    ...(flags.snap !== undefined && { snap: flags.snap }),
    ...(flags.branches !== undefined && { branches: flags.branches }),
    ...(flags.leases !== undefined && { leases: flags.leases }),
  };
}

/**
 * Refuse precisely when a store cannot answer the question, naming the capability and the
 * store. Optional SPI members (`listExecutions`, `head`, `removeLineage`, `LeaseStore.get`)
 * are exactly where a BYO backend legitimately differs from the SQLite one every command was
 * written against — so "it threw" is not an acceptable way to find out.
 */
export function requireCapability<T extends object>(
  store: T,
  member: keyof T & string,
  what: string
): string | undefined {
  if (typeof store[member] === "function") return undefined;
  return `${what} needs \`${member}\`, and the configured ${store.constructor.name} does not implement it.`;
}

/**
 * Fail an unknown execution id loudly (exit 1) instead of printing an empty timeline: a
 * mistyped id used to read as "nothing happened". Names how many executions the store holds
 * when it can enumerate them.
 */
export async function noSuchExecution(
  store: {
    listExecutions?: () => Promise<string[]>;
  },
  executionId: string
): Promise<CliError> {
  let tail = "";
  if (store.listExecutions !== undefined) {
    const n = (await store.listExecutions()).filter((id) => !id.startsWith("__loom_")).length;
    tail = ` (${n} execution${n === 1 ? "" : "s"} in this store — try loom census)`;
  }
  return new CliError(`no such execution ${executionId}${tail}`, 1);
}
