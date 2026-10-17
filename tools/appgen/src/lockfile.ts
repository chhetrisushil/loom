import * as fs from "node:fs";
import * as path from "node:path";
import type { ChangeSpec } from "./changeSpec";
import { safeWriteFile } from "./safeWrite";
import {
  MAX_INTENT_LENGTH,
  changeSpecDataIssues,
  specStructureIssues,
  textIssues,
} from "./specText";

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
 * outside this pure-ish writer. `containment` is the symlink-containment root (default `root`; the CLI
 * passes the cwd-based root from `containmentRootFor`, so a linked `root` below the cwd is refused).
 */
export function writeLockfile(
  root: string,
  lock: AppgenLock,
  fileName: string,
  containment: string = root
): string {
  const dest = path.join(root, ".loom", "appgen", fileName);
  // Never through a link (a planted `.loom` or lockfile): same writer as every other project write.
  safeWriteFile(containment, dest, `${JSON.stringify(lock, null, 2)}\n`);
  return dest;
}

// A `--from-spec` lockfile is hand-editable, shareable data and a replay never goes through
// the model validator, so read-time is the only gate: re-assert EVERY field a codegen sink
// reads (ids as path segments and identifiers, names / intents / models / grants as comment,
// string and markdown text) with the very predicates `validateChangeSpec` uses, so a crafted
// spec cannot traverse out of the output dir (`../...`), inject code, or spoof a reviewer
// with invisible/bidi characters.
/** Read and validate a lockfile written by {@link writeLockfile}. */
export function readLockfile(file: string): AppgenLock {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AppgenLock>;
  if (
    typeof raw !== "object" ||
    raw === null ||
    raw.changeSpec === undefined ||
    !Array.isArray(raw.changeSpec.capabilities)
  ) {
    throw new Error(`not a valid appgen lockfile: ${file}`);
  }
  const issues: string[] = [];
  // Same message as `validateChangeSpec` (parity): an empty plan is refused, not replayed as a no-op.
  if (raw.changeSpec.capabilities.length === 0) {
    issues.push("the plan has no capabilities — it is empty");
  }
  issues.push(...changeSpecDataIssues(raw.changeSpec));
  // The top-level intent is echoed into provenance text, so it gets the same text rule.
  issues.push(...textIssues("intent", raw.intent, MAX_INTENT_LENGTH));
  // Structure (duplicate step / flow ids, generated-name collisions, modify/delete in a new
  // flow) only once every field is type-correct, via the very implementation the model
  // validator uses. A lockfile has no app to compare against, so no `existing`.
  if (issues.length === 0) issues.push(...specStructureIssues(raw.changeSpec));
  if (issues.length > 0) {
    throw new Error(
      `appgen lockfile: unsafe or malformed spec in ${file}:\n${issues.map((i) => `  - ${i}`).join("\n")}`
    );
  }
  return raw as AppgenLock;
}
