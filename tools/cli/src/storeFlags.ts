import type { StoreFlags } from "./stores";

/** True when the caller gave enough to resolve anything at all. */
export function hasStoreFlags(flags: StoreFlags): boolean {
  return flags.config !== undefined || flags.db !== undefined;
}

export const STORE_FLAG_HELP =
  "pass --config <module> (your app's stores, any backend) or --db <events.db> (SQLite shorthand)";

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
