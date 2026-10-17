import * as fs from "node:fs";
import * as path from "node:path";
import type { ChangeSpec } from "./changeSpec";
import { safeWriteFile } from "./safeWrite";

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
  const dest = path.join(root, ".loom", "appgen", fileName);
  // Never through a link (a planted `.loom` or lockfile): same writer as every other project write.
  safeWriteFile(root, dest, `${JSON.stringify(lock, null, 2)}\n`);
  return dest;
}

// Every id in a spec becomes a file-path segment and a codegen identifier; the live NL
// path guarantees this by construction (ids come from `slug()`), but a `--from-spec`
// lockfile is hand-editable/shareable data. Re-assert the slug shape on read so a crafted
// spec can't traverse out of the output dir (`../…`) or inject code via a non-identifier id.
const SAFE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function assertSafeId(id: unknown, what: string): void {
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    throw new Error(
      `appgen lockfile: unsafe ${what} id ${JSON.stringify(id)} — must be a kebab slug`
    );
  }
}

/** Read and validate a lockfile written by {@link writeLockfile}. */
export function readLockfile(file: string): AppgenLock {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AppgenLock>;
  if (raw.changeSpec === undefined || !Array.isArray(raw.changeSpec.capabilities)) {
    throw new Error(`not a valid appgen lockfile: ${file}`);
  }
  for (const cap of raw.changeSpec.capabilities) {
    assertSafeId(cap?.id, "capability");
    for (const step of cap?.steps ?? []) assertSafeId(step?.id, "step");
  }
  return raw as AppgenLock;
}
