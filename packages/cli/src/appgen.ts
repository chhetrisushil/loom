import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  type ChangeSpec,
  type FilePlan,
  type GeneratedFile,
  type TypecheckResult,
  applyChanges,
  makeLock,
  planChangesDeterministic,
  readLockfile,
  scanApp,
  typecheck,
  writeLockfile,
} from "@loom/appgen";
import { generateRegistration } from "@loom/scaffold";
import { discoverFlows } from "./gen";

export type Conflict =
  | { action: "rename"; newPath: string }
  | { action: "skip" }
  | { action: "overwrite" };

export interface AppgenIO {
  exists(p: string): boolean;
  write(p: string, contents: string): void;
  /** Called only when a target path already exists; returns how to resolve it. */
  resolveConflict(existingPath: string): Promise<Conflict>;
  /** Release any resources (e.g. a readline handle) once the run is done. */
  close?(): void;
}

export interface AppgenResult {
  specName: string;
  written: string[];
  overwritten: string[];
  skipped: string[];
  /** True when `--dry-run`: the plan was computed but nothing was written. */
  dryRun: boolean;
  /** The computed change plan (for rendering a terraform-style preview). */
  plan: FilePlan;
  /** Path of the spec lockfile written after applying (absent on dry-run). */
  lockfile?: string;
  /** Typecheck result, when `--check` was requested. */
  typecheck?: TypecheckResult;
}

export interface AppgenOptions {
  intent: string;
  dir: string;
  /** Compute and return the plan without writing anything. */
  dryRun?: boolean;
  /** Replay a previously written ChangeSpec lockfile instead of planning from intent. */
  fromSpec?: string;
  /** Typecheck the app after applying (in-process tsc). */
  check?: boolean;
  /** Timestamp source for the lockfile (ms). Injectable for deterministic tests. */
  now?: number;
}

/**
 * `loom appgen <intent>` — the AI-native, brownfield-aware scaffolder. Four stages:
 * scan the app (deterministic), plan the change against it (deterministic here; a local
 * model can be swapped in), turn the plan into files/edits (deterministic), then write.
 * All NL understanding lives in the plan stage and emits a structured ChangeSpec —
 * codegen never sees raw NL. This handler owns file IO and per-file conflict resolution
 * (rename / skip / overwrite); `--dry-run` computes the plan and writes nothing.
 *
 *   - Net-new `dir`      → a full runnable project (package.json, tsconfig, app/config.ts,
 *     app/main.ts, app/loom.gen.ts, app/flows/<id>/flow.ts).
 *   - Existing Loom app  → new `app/flows/<id>/flow.ts` per new capability + surgical,
 *     formatting-preserving edits to existing flows, then regenerate `app/loom.gen.ts`.
 */
export async function cmdAppgen(
  opts: AppgenOptions,
  io: AppgenIO = defaultIO()
): Promise<AppgenResult> {
  const model = scanApp(opts.dir);
  // Replay a lockfile verbatim, or plan the delta from the intent (deterministic here;
  // a local model can be swapped in without changing anything downstream).
  let intent = opts.intent;
  let changeSpec: ChangeSpec;
  if (opts.fromSpec !== undefined) {
    const lock = readLockfile(opts.fromSpec);
    changeSpec = lock.changeSpec;
    intent = lock.intent;
  } else {
    changeSpec = planChangesDeterministic(opts.intent, model);
  }
  const plan = applyChanges(changeSpec, model);

  const result: AppgenResult = {
    specName: changeSpec.name,
    written: [],
    overwritten: [],
    skipped: [],
    dryRun: opts.dryRun === true,
    plan,
  };

  if (opts.dryRun === true) return result; // preview only — no writes, no io.close

  try {
    // New files go through per-file conflict resolution; in-place edits are the point of
    // the run, so they overwrite directly (the FlowEditor already guarded human code).
    for (const c of plan.creates) {
      await writeFile({ path: c.path, contents: c.contents }, opts.dir, io, result);
    }
    for (const e of plan.edits) {
      const dest = path.join(opts.dir, e.path);
      io.write(dest, e.after);
      result.overwritten.push(dest);
    }
    // Re-wire the flow set (pre-existing + newly written) so `flowModules` stays correct.
    if (plan.regenRegistration) {
      regenerateRegistration(opts.dir, io, result);
    }
    // Record the accepted ChangeSpec as a replayable lockfile (provenance + `--from-spec`).
    const now = opts.now ?? Date.now();
    const lock = makeLock(intent, changeSpec, new Date(now).toISOString());
    result.lockfile = writeLockfile(opts.dir, lock, `${now}.spec.json`);
  } finally {
    io.close?.();
  }

  if (opts.check === true) result.typecheck = typecheck(opts.dir);

  return result;
}

/** Render a plan as a terraform-style preview (used by `--dry-run`). */
export function renderPlan(plan: FilePlan, dir: string): string {
  const lines: string[] = [];
  lines.push(plan.isNewProject ? `plan: new project → ${dir}` : `plan: update app → ${dir}`);
  for (const c of plan.creates) lines.push(`  + create ${c.path}`);
  for (const e of plan.edits) {
    lines.push(`  ~ edit   ${e.path}`);
    for (const n of e.notes) lines.push(`      • ${n}`);
  }
  for (const s of plan.skips) lines.push(`  - skip   ${s.path} (${s.reason})`);
  if (plan.regenRegistration) lines.push("  ~ edit   app/loom.gen.ts (re-wire flow registration)");
  const n = plan.creates.length + plan.edits.length;
  lines.push("");
  lines.push(
    `${n} change${n === 1 ? "" : "s"}, ${plan.skips.length} skipped — run with --apply to write`
  );
  return lines.join("\n");
}

/** Write one generated file under `dir`, applying per-file conflict resolution. */
async function writeFile(
  file: GeneratedFile,
  dir: string,
  io: AppgenIO,
  result: AppgenResult
): Promise<void> {
  let dest = path.join(dir, file.path);
  let overwrite = false;
  let skip = false;

  // Rename loops until the path is free, skip drops the file, overwrite writes in place.
  while (io.exists(dest)) {
    const choice = await io.resolveConflict(dest);
    if (choice.action === "skip") {
      skip = true;
      break;
    }
    if (choice.action === "overwrite") {
      overwrite = true;
      break;
    }
    dest = path.isAbsolute(choice.newPath) ? choice.newPath : path.join(dir, choice.newPath);
  }

  if (skip) {
    result.skipped.push(dest);
    return;
  }
  io.write(dest, file.contents);
  (overwrite ? result.overwritten : result.written).push(dest);
}

/** Rewrite `<dir>/app/loom.gen.ts` from the flows discovered on disk (the `loom gen` step). */
function regenerateRegistration(dir: string, io: AppgenIO, result: AppgenResult): void {
  const appDir = path.join(dir, "app");
  const genPath = path.join(appDir, "loom.gen.ts");
  const existed = io.exists(genPath);
  io.write(genPath, generateRegistration(discoverFlows(appDir)));
  (existed ? result.overwritten : result.written).push(genPath);
}

function defaultIO(): AppgenIO {
  // A line-queue reader over stdin: robust for both interactive TTYs and piped input
  // (where readline emits every buffered line up front, which `rl.question` would drop
  // between successive prompts). Prompts are written manually; EOF resolves pending
  // reads with "" so a closed stream never hangs the process.
  let rl: readline.Interface | undefined;
  const buffered: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let closed = false;

  const ask = (q: string): Promise<string> => {
    if (rl === undefined) {
      rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else buffered.push(line);
      });
      rl.on("close", () => {
        closed = true;
        for (const waiter of waiters.splice(0)) waiter("");
      });
    }
    process.stdout.write(q);
    const next = buffered.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (closed) return Promise.resolve("");
    return new Promise((resolve) => waiters.push(resolve));
  };

  return {
    exists: (p) => fs.existsSync(p),
    write: (p, contents) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, contents);
    },
    resolveConflict: async (existingPath) => {
      for (;;) {
        const answer = (await ask(`${existingPath} exists — [r]ename / [s]kip / [o]verwrite? `))
          .trim()
          .toLowerCase();
        if (answer === "s" || answer === "skip") return { action: "skip" };
        if (answer === "o" || answer === "overwrite") return { action: "overwrite" };
        if (answer === "r" || answer === "rename") {
          const newPath = (await ask("New name: ")).trim();
          if (newPath.length > 0) return { action: "rename", newPath };
        }
        // Unrecognized input → re-prompt.
      }
    },
    close: () => rl?.close(),
  };
}
