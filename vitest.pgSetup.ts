import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── One Postgres database per package under test ─────────────────────────────
//
// CI runs every package's suite against ONE `LOOM_TEST_POSTGRES_URL`, several packages at a
// time, and suites reset their tables with `TRUNCATE` — so one package could wipe another's
// rows mid-test ("No execution found for id: e1"). `loomTest()` points each package at its own
// database (`<db>_<package>`); this global setup creates it on first use.

const ROOT = dirname(fileURLToPath(import.meta.url));

export default async function setup(): Promise<void> {
  const admin = process.env.LOOM_TEST_POSTGRES_ADMIN_URL;
  const target = process.env.LOOM_TEST_POSTGRES_PACKAGE_DB;
  if (admin === undefined || target === undefined) return;
  // `pg` is a dependency of the Postgres plugin, not of the workspace root.
  const require = createRequire(join(ROOT, "plugins", "postgres", "package.json"));
  const { Client } = require("pg") as typeof import("pg");
  const client = new Client({ connectionString: admin });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${target}"`);
  } catch (err) {
    // 42P04 duplicate_database: an earlier run already created it.
    if ((err as { code?: string }).code !== "42P04") throw err;
  } finally {
    await client.end();
  }
}
