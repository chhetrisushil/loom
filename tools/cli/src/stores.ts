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

async function fromConfig(modulePath: string): Promise<ResolvedStores> {
  // Set BEFORE the import: composing an app starts its timer service, and that happens while
  // the module is evaluated. A read-only command must not fire due timers and scheduled flows
  // as a side effect of being pointed at a deployment.
  process.env.LOOM_NO_AUTOSTART = "1";

  const resolved = path.resolve(modulePath);
  const mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  const app = (mod.default ?? mod.app ?? mod) as Partial<LoomApp>;
  if (app.stores?.eventStore === undefined) {
    throw new Error(
      `${modulePath} must default-export a LoomApp from defineConfig(...) (no stores found)`
    );
  }
  const { eventStore, snapshotStore, branchRegistry, leaseStore, timerStore } = app.stores;
  return {
    eventStore,
    snapshotStore,
    ...(branchRegistry !== undefined && { branchRegistry }),
    ...(leaseStore !== undefined && { leaseStore }),
    ...(timerStore !== undefined && { timerStore }),
    origin: "config",
    close: async () => {
      await app.close?.();
    },
  };
}

function fromSqlite(flags: StoreFlags): ResolvedStores {
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
