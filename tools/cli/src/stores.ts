import fs from "node:fs";
import { createRequire } from "node:module";
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
import { STORE_FLAG_HELP, hasStoreFlags, storeFlagsOf } from "./storeFlags";

// The flag helpers live in ./storeFlags so the CLI front door can use them without loading this
// module (which pulls the SQLite driver). Re-exported for existing importers.
export { STORE_FLAG_HELP, hasStoreFlags, storeFlagsOf };

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
async function loadModule(
  file: string,
  registerEsm?: () => (() => void) | undefined
): Promise<Record<string, unknown>> {
  try {
    return require(file) as Record<string, unknown>;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // A `.ts` config with top-level await cannot be transformed to CommonJS: tsx's CJS hook
    // fails with an esbuild transform error. Any such error on a TS file retries through the
    // ESM hook, which handles TLA; a genuine syntax error then fails there with its own message.
    const tsTransformFailure =
      TS_CONFIG.test(file) &&
      /top-level await|transform failed|TransformError|esbuild/i.test(
        err instanceof Error ? `${err.name} ${err.message}` : String(err)
      );
    if (code !== "ERR_REQUIRE_ESM" && code !== "ERR_REQUIRE_ASYNC_MODULE" && !tsTransformFailure) {
      throw err;
    }
    registerEsm?.();
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

/** A config module that could not be loaded; `cause` holds the original error (and its stack). */
export class ConfigLoadError extends CliError {
  constructor(message: string, exitCode: number, cause?: unknown) {
    super(message, exitCode);
    this.name = "ConfigLoadError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** The `tsx` loader API as the CLI uses it — resolved from the USER's project, never bundled. */
type TsxApi = { register(): (() => void) | undefined };

const TS_CONFIG = /\.(?:ts|mts|cts)$/;

/**
 * Register a TypeScript loader for a `.ts` config, or refuse (exit 2). The CLI ships no
 * transpiler: `tsx` must resolve from the CONFIG's own directory (the project that already
 * has its types and dependencies), so it is the user's version that runs.
 */
function registerTsLoader(file: string): {
  unregister: () => void;
  esm: () => (() => void) | undefined;
} {
  const from = path.dirname(file);
  // Resolve AS the config's own directory would (its node_modules chain), not ours.
  const fromConfig = createRequire(path.join(from, "noop.js"));
  const resolveApi = (spec: string): string | undefined => {
    try {
      return fromConfig.resolve(spec);
    } catch {
      return undefined;
    }
  };
  const cjs = resolveApi("tsx/cjs/api");
  if (cjs === undefined) {
    throw new ConfigLoadError(
      `cannot load TypeScript config ${file}: built? point --config at the compiled .js, or install tsx in that project (\`pnpm add -D tsx\`)`,
      2
    );
  }
  const unregisters: Array<() => void> = [];
  const un = (fromConfig(cjs) as TsxApi).register();
  if (typeof un === "function") unregisters.push(un);
  return {
    unregister: () => {
      for (const u of unregisters.reverse()) u();
    },
    // A config with top-level await cannot be `require`d; register the ESM hook for the import.
    esm: () => {
      const api = resolveApi("tsx/esm/api");
      if (api === undefined) return undefined;
      const u = (fromConfig(api) as TsxApi).register();
      if (typeof u === "function") unregisters.push(u);
      return u;
    },
  };
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
 *
 * `LOOM_QUIET=1` is set for the duration of the import (unless `LOOM_DEBUG=1` / `--verbose`):
 * `defineConfig` prints `[loom] …` notices to stderr when it composes, and a diagnostic CLI
 * that imports your app must not bury its own answer under them.
 *
 * A failure is reported as `while loading <abs file>: <message>` plus a hint; the original
 * error (stack included) is its `cause`, printed by `--verbose` / `LOOM_DEBUG=1`.
 */
export async function loadLoomApp(modulePath: string): Promise<Partial<LoomApp>> {
  // Restored in `finally`: defineConfig reads it while composing, which happens during the import,
  // so restoring afterwards cannot re-enable autostart for the app already built - and a caller
  // that goes on to spawn processes (`loom dev`) must not hand them our inspect-only switch.
  const autostartBefore = process.env.LOOM_NO_AUTOSTART;
  process.env.LOOM_NO_AUTOSTART = "1";
  const file = path.resolve(modulePath);
  const quietBefore = process.env.LOOM_QUIET;
  if (process.env.LOOM_DEBUG !== "1") process.env.LOOM_QUIET = "1";
  let loader: ReturnType<typeof registerTsLoader> | undefined;
  try {
    if (TS_CONFIG.test(file)) loader = registerTsLoader(file);
    let mod: Record<string, unknown>;
    try {
      mod = await loadModule(file, loader?.esm);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException).code;
      const hint =
        /top-level await/i.test(message) && TS_CONFIG.test(file)
          ? 'top-level await needs an ES-module config: name it loom.config.mts, or set "type": "module" in its package.json (tsx compiles a plain .ts in a CommonJS package to CommonJS)'
          : code === "MODULE_NOT_FOUND" && !fs.existsSync(file)
            ? "no such file - built? point --config at the compiled .js"
            : code === "MODULE_NOT_FOUND"
              ? "a dependency of the config is missing - is it installed (and built, for a workspace package)?"
              : "run with --verbose (or LOOM_DEBUG=1) for the stack";
      throw new ConfigLoadError(`while loading ${file}: ${message}\n  hint: ${hint}`, 1, err);
    }
    return (mod.default ?? mod.app ?? mod) as Partial<LoomApp>;
  } finally {
    loader?.unregister();
    if (autostartBefore === undefined) Reflect.deleteProperty(process.env, "LOOM_NO_AUTOSTART");
    else process.env.LOOM_NO_AUTOSTART = autostartBefore;
    if (quietBefore === undefined) Reflect.deleteProperty(process.env, "LOOM_QUIET");
    else process.env.LOOM_QUIET = quietBefore;
  }
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
 *
 * Existence is not enough: a zero-byte or non-SQLite file would be opened read-write and
 * migrated into a database. So the file must also begin with the 16-byte SQLite header.
 * (Chosen over a readonly open because the plugin stores run `CREATE TABLE` migrations on
 * construction, which a readonly handle cannot do.)
 */
export function requireExistingFile(flag: string, file: string): void {
  if (file === ":memory:" || file.startsWith("file:")) return;
  if (!fs.existsSync(file)) {
    throw new CliError(
      `--${flag}: no such file ${path.resolve(file)} (cwd ${process.cwd()}) — not creating it. Check the path.`
    );
  }
  const header = Buffer.alloc(SQLITE_HEADER.length);
  let n = 0;
  try {
    const fd = fs.openSync(file, "r");
    try {
      n = fs.readSync(fd, header, 0, header.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    throw new CliError(`--${flag}: cannot read ${path.resolve(file)}: ${(err as Error).message}`);
  }
  if (n < header.length || !header.equals(SQLITE_HEADER)) {
    throw new CliError(
      `--${flag}: ${path.resolve(file)} is not a SQLite database (empty or wrong header) — refusing to open it.`
    );
  }
}

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");

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
