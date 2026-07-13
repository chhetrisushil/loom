import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  type AppModel,
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
import { unifiedDiff } from "./diff";
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
  deleted: string[];
  skipped: string[];
  /** True when `--dry-run`: the plan was computed but nothing was written. */
  dryRun: boolean;
  /** The computed change plan (for rendering a terraform-style preview). */
  plan: FilePlan;
  /** Which planner produced the plan, and any reasoning-ladder elevations. */
  planner: "deterministic" | "model";
  elevations?: { from: string; to: string; reason: string }[];
  /** Path of the spec lockfile written after applying (absent on dry-run). */
  lockfile?: string;
  /** Typecheck result, when `--check` was requested. */
  typecheck?: TypecheckResult;
  /** True when the user declined the plan at the confirmation prompt. */
  aborted?: boolean;
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
  /**
   * Plan with a local Gemma model (via the optional `@loom/appgen-model` package) instead
   * of the deterministic grammar parser. `path` is a local `.gguf`; `bigPath` is an
   * optional stronger tier to elevate to. Falls back to deterministic if the package or
   * model is unavailable. Ignored when `offline` is set.
   */
  model?: { path: string; bigPath?: string; tier?: string };
  /** Force the deterministic, model-free planner (overrides `model`). */
  offline?: boolean;
  /**
   * Called with the computed plan (and which planner produced it) before anything is
   * written. Return `false` to abort without writing. Omitted → apply unconditionally (the
   * default, and what tests use).
   */
  confirm?: (plan: FilePlan, planner: Planner, elevations?: Elevation[]) => Promise<boolean>;
}

export type Planner = "deterministic" | "model";
export type Elevation = { from: string; to: string; reason: string };

// biome-ignore lint/suspicious/noExplicitAny: @loom/appgen-model is an optional, lazily-loaded peer.
type AppgenModelModule = any;

// A genuine dynamic `import()` preserved through `new Function`. tsc under `module:
// CommonJS` would down-level `import()` to `require()`, which cannot load an ESM-only
// package (@loom/appgen-model pulls in node-llama-cpp, an ESM/top-level-await module).
// biome-ignore lint/security/noGlobalEval: intentional — the only way to keep a real ESM import from CJS output.
const esmImport = new Function("s", "return import(s)") as (
  s: string
) => Promise<AppgenModelModule>;

/**
 * Load the optional `@loom/appgen-model` package. Resolution order:
 *  1. from the target project (`dir`) — the intended UX is
 *     `pnpm add @loom/appgen-model node-llama-cpp` in your app;
 *  2. from the CLI itself (when hoisted into the CLI's own node_modules);
 *  3. as a sibling of `@loom/appgen` (which the CLI always resolves) — `appgen-model`
 *     sits next to `appgen` both in the source monorepo (`packages/*`) and in an
 *     installed layout (`node_modules/@loom/*`), so in-repo dev works without a
 *     per-app install;
 *  4. the bare specifier.
 */
async function loadAppgenModel(dir: string): Promise<AppgenModelModule> {
  const { createRequire } = await esmImport("node:module");
  const { pathToFileURL } = await esmImport("node:url");
  for (const anchor of [path.join(path.resolve(dir), "package.json"), __filename]) {
    try {
      const resolved = createRequire(anchor).resolve("@loom/appgen-model");
      return await esmImport(pathToFileURL(resolved).href);
    } catch {
      // try the next anchor
    }
  }
  try {
    // @loom/appgen resolves to `<base>/appgen/dist/index.js`; its sibling is
    // `<base>/appgen-model/dist/index.js` in both packages/* and node_modules/@loom/*.
    const appgenMain = createRequire(__filename).resolve("@loom/appgen");
    const sibling = path.resolve(
      path.dirname(appgenMain),
      "..",
      "..",
      "appgen-model",
      "dist",
      "index.js"
    );
    if (fs.existsSync(sibling)) return await esmImport(pathToFileURL(sibling).href);
  } catch {
    // fall through to the bare specifier
  }
  return await esmImport("@loom/appgen-model");
}

/**
 * Plan the change: a local model when `--model` is set and the optional
 * `@loom/appgen-model` package is installed, otherwise the deterministic parser. The
 * model path itself also falls back to deterministic internally on any model failure, so
 * this always resolves to a valid ChangeSpec.
 */
async function planChange(
  intent: string,
  model: AppModel,
  opts: AppgenOptions
): Promise<ChangeSpec> {
  if (opts.model !== undefined && opts.offline !== true) {
    try {
      const m = await loadAppgenModel(opts.dir);
      const routes = [m.gemmaRoute(opts.model.path, opts.model.tier ?? m.DEFAULT_TIER)];
      if (opts.model.bigPath !== undefined) routes.push(m.gemmaRoute(opts.model.bigPath, "12b"));
      const spec: ChangeSpec = await m.planChangesModel(intent, model, { routes });
      // The model ran but produced nothing usable → planChangesModel already fell back to
      // the deterministic parser. Say so loudly, so it isn't silently the wrong output.
      if (spec.planner !== "model") {
        process.stderr.write(
          "appgen: --model produced no valid plan — used the deterministic parser (output may " +
            "not reflect your intent). Try a stronger --model (E4B+) on Node 20/22 LTS, or name " +
            'steps explicitly (e.g. "… Step fetch. Step transform.").\n'
        );
      }
      return spec;
    } catch (err) {
      process.stderr.write(
        `appgen: local-model planner unavailable (${
          err instanceof Error ? err.message : String(err)
        }); using the deterministic parser. Install @loom/appgen-model + node-llama-cpp to enable it.\n`
      );
    }
  }
  return planChangesDeterministic(intent, model);
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
    changeSpec = await planChange(opts.intent, model, opts);
  }
  const plan = applyChanges(changeSpec, model);

  const result: AppgenResult = {
    specName: changeSpec.name,
    written: [],
    overwritten: [],
    deleted: [],
    skipped: [],
    dryRun: opts.dryRun === true,
    plan,
    planner: changeSpec.planner,
    ...(changeSpec.elevations !== undefined && { elevations: changeSpec.elevations }),
  };

  if (opts.dryRun === true) return result; // preview only — no writes, no io.close

  // Interactive confirmation (if provided): abort cleanly on a "no", without writing.
  const hasChanges = plan.creates.length + plan.edits.length + plan.deletes.length > 0;
  if (
    opts.confirm !== undefined &&
    hasChanges &&
    !(await opts.confirm(plan, changeSpec.planner, changeSpec.elevations))
  ) {
    result.aborted = true;
    io.close?.();
    return result;
  }

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
    for (const d of plan.deletes) {
      const dest = path.join(opts.dir, d.path);
      fs.rmSync(dest, { force: true });
      result.deleted.push(dest);
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

/** A one-line, human-readable tag for which planner produced a plan (and any elevations). */
export function plannerTag(planner: Planner, elevations?: Elevation[]): string {
  if (planner !== "model") return "[deterministic]";
  const el =
    elevations && elevations.length > 0
      ? `, elevated ${elevations.map((e) => `${e.from}→${e.to}`).join(", ")}`
      : "";
  return `[model${el}]`;
}

/**
 * Render a plan as a terraform-style preview with a real unified diff per edit (used by
 * `--dry-run` and the interactive confirmation). Pass `diff: false` for a compact summary,
 * and `planner`/`elevations` to show which planner produced it.
 */
export function renderPlan(
  plan: FilePlan,
  dir: string,
  opts: { diff?: boolean; planner?: Planner; elevations?: Elevation[] } = {}
): string {
  const showDiff = opts.diff !== false;
  const tag = opts.planner !== undefined ? ` ${plannerTag(opts.planner, opts.elevations)}` : "";
  const lines: string[] = [];
  lines.push(
    (plan.isNewProject ? `plan: new project → ${dir}` : `plan: update app → ${dir}`) + tag
  );
  for (const c of plan.creates) lines.push(`  + create ${c.path}`);
  for (const e of plan.edits) {
    lines.push(`  ~ edit   ${e.path}`);
    for (const nt of e.notes) lines.push(`      • ${nt}`);
    if (showDiff) for (const dl of unifiedDiff(e.before, e.after)) lines.push(`      ${dl}`);
  }
  for (const d of plan.deletes) lines.push(`  ✗ delete ${d.path}`);
  for (const s of plan.skips) lines.push(`  - skip   ${s.path} (${s.reason})`);
  if (plan.regenRegistration) lines.push("  ~ edit   app/loom.gen.ts (re-wire flow registration)");
  const n = plan.creates.length + plan.edits.length + plan.deletes.length;
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
