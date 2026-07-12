import * as fs from "node:fs";
import * as path from "node:path";
import type { ChangeSpec } from "./changeSpec";

// ── Spec lockfile: the appgen equivalent of a golden log ─────────────────────
//
// Every applied generation records the accepted ChangeSpec (plus the intent that
// produced it and any reasoning-ladder elevations) to `.loom/appgen/<timestamp>.spec.json`.
// `loom appgen --from-spec <file>` replays it deterministically with NO model — the same
// change, reproducibly, which keeps CI and audits model-free. This is a distinct artifact
// from `loom eval` golden logs (which replay recorded event streams).

export interface AppgenLock {
  version: 1;
  /** ISO timestamp the lockfile was written (provenance only). */
  createdAt: string;
  /** The natural-language intent that produced the spec ("" when replayed from a spec). */
  intent: string;
  changeSpec: ChangeSpec;
}

/** Build a lockfile record around a ChangeSpec. */
export function makeLock(intent: string, changeSpec: ChangeSpec, createdAt: string): AppgenLock {
  return { version: 1, createdAt, intent, changeSpec };
}

/**
 * Write a lockfile to `<root>/.loom/appgen/<fileName>` and return its path. The caller
 * chooses `fileName` (typically `<timestamp>.spec.json`) so the timestamp source stays
 * outside this pure-ish writer.
 */
export function writeLockfile(root: string, lock: AppgenLock, fileName: string): string {
  const dir = path.join(root, ".loom", "appgen");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, fileName);
  fs.writeFileSync(dest, `${JSON.stringify(lock, null, 2)}\n`);
  return dest;
}

/** Read and minimally validate a lockfile written by {@link writeLockfile}. */
export function readLockfile(file: string): AppgenLock {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AppgenLock>;
  if (raw.changeSpec === undefined || !Array.isArray(raw.changeSpec.capabilities)) {
    throw new Error(`not a valid appgen lockfile: ${file}`);
  }
  return raw as AppgenLock;
}
