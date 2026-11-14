import type * as SqlitePlugin from "@loomwork/plugin-sqlite";
import { CliError } from "./args";

// `@loomwork/plugin-sqlite` is an OPTIONAL peer of the CLI, not a dependency: it brings the native
// `better-sqlite3` driver, which an app on Postgres or a custom store never needs, and whose build
// can fail (no prebuilt binary, no toolchain) or be skipped (pnpm 10 blocks install scripts). Only
// the SQLite file flags (`--db`, `--snap`, `--branches`, `--leases`, and `loom sweep content`'s
// files) load it, at the moment they are used. `--config` never does.

const PLUGIN = "@loomwork/plugin-sqlite";

export const SQLITE_PLUGIN_MISSING = `this command reads SQLite files, which needs ${PLUGIN} (an optional peer of @loomwork/cli). Install it beside the CLI (npm install ${PLUGIN}), or name your app's own stores with --config <loom.config>.`;

/**
 * Load `@loomwork/plugin-sqlite`, or refuse with a {@link CliError} that says how to get it.
 * `load` is the module loader (`require` by default; the CLI compiles to CommonJS), injectable so
 * the missing-peer path can be tested in a workspace where the plugin is installed.
 */
export function loadSqlitePlugin(load: (id: string) => unknown = require): typeof SqlitePlugin {
  try {
    return load(PLUGIN) as typeof SqlitePlugin;
  } catch (err) {
    // Only the plugin itself being absent: a missing module INSIDE it is a real fault to surface.
    const e = err as { code?: unknown; message?: unknown };
    if (e.code === "MODULE_NOT_FOUND" && String(e.message).includes(`'${PLUGIN}'`)) {
      throw new CliError(SQLITE_PLUGIN_MISSING);
    }
    throw err;
  }
}
