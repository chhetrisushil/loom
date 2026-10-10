import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

// ── One Postgres database per TEST FILE (opt-in: `loomTest({ pgDatabasePerFile: true })`) ─────────
//
// `migrate()` takes a DATABASE-wide advisory lock with no timeout, held until COMMIT. Files of one
// package run in parallel against one database, so a slow migration in file A blocked `migrate()` in
// every sibling file, unbounded (a 61 s timeout flake). A database per file removes the shared lock.
//
// This is a vitest `setupFile`: it runs inside each test file's worker BEFORE the file is imported,
// so the file's top-level `process.env.LOOM_TEST_POSTGRES_URL` read sees its own database.
//
// NAMING / CLEANUP: `<packageDb>_<file slug>_<hash>`, stable per file path, REUSED across runs and
// never dropped (migrate() is idempotent; the package DB behaved the same). The set is bounded by the
// number of test files, so nothing piles up; only a renamed/deleted test file leaves one stale DB.
//
// CONNECTIONS: databases do not add connections. `max_connections` is server-wide, so the budget is
// unchanged: (concurrent test files) x (pool size per file) + 1 short-lived admin connection. Vitest
// runs at most `availableParallelism()` files at once.

const ROOT = dirname(fileURLToPath(import.meta.url));
const CREATE_LOCK = 745_001_13; // arbitrary constant: serialises CREATE DATABASE across workers

const admin = process.env.LOOM_TEST_POSTGRES_ADMIN_URL;
const pkgDb = process.env.LOOM_TEST_POSTGRES_PACKAGE_DB;
const testPath = expect.getState().testPath;

if (admin !== undefined && pkgDb !== undefined && testPath !== undefined) {
  const rel = relative(process.cwd(), testPath);
  const slug = rel
    .replace(/\.test\.ts$/, "")
    .replace(/^src[\\/]/, "")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
  const hash = createHash("sha1").update(rel).digest("hex").slice(0, 6);
  const suffix = `_${hash}`;
  const db = `${pkgDb}_${slug}`.slice(0, 63 - suffix.length) + suffix;

  // `pg` is a dependency of the Postgres plugin, not of the workspace root.
  const require = createRequire(join(ROOT, "plugins", "postgres", "package.json"));
  const { Client } = require("pg") as typeof import("pg");
  const client = new Client({ connectionString: admin });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [CREATE_LOCK]);
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [db]);
    if (rowCount === 0) await client.query(`CREATE DATABASE "${db}"`);
    await client.query("SELECT pg_advisory_unlock($1)", [CREATE_LOCK]);
  } finally {
    await client.end();
  }
  const url = new URL(admin);
  url.pathname = `/${db}`;
  process.env.LOOM_TEST_POSTGRES_URL = url.toString();
}
