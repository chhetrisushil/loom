import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { type GeneratedFile, generateFlows, generateProject, parseIntent } from "@loom/appgen";
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
}

/** A `dir` is treated as an existing Loom app if it already has a project manifest or a
 * generated flow registration / composition root (the folder-convention markers). */
function isExistingApp(dir: string, io: AppgenIO): boolean {
  return (
    io.exists(path.join(dir, "package.json")) ||
    io.exists(path.join(dir, "app", "loom.gen.ts")) ||
    io.exists(path.join(dir, "app", "config.ts"))
  );
}

/**
 * `loom appgen <intent>` — parse a natural-language intent into an AppSpec and generate a
 * Loom app following the folder convention. Parsing and code generation are delegated to
 * @loom/appgen (pure, offline — no LLM); this handler owns file IO, per-file conflict
 * resolution (rename / skip / overwrite), and choosing the mode based on `dir`:
 *
 *   - Empty / new `dir`  → a full runnable project (package.json, tsconfig, app/config.ts,
 *     app/main.ts, app/loom.gen.ts, app/flows/<id>/flow.ts).
 *   - Existing Loom app  → just `app/flows/<id>/flow.ts` per capability, then regenerate
 *     `app/loom.gen.ts` from the filesystem (`loom gen`) so existing flows stay wired.
 */
export async function cmdAppgen(
  opts: { intent: string; dir: string },
  io: AppgenIO = defaultIO()
): Promise<AppgenResult> {
  const spec = parseIntent(opts.intent);
  const existing = isExistingApp(opts.dir, io);
  const files = existing ? generateFlows(spec) : generateProject(spec);
  const result: AppgenResult = {
    specName: spec.name,
    written: [],
    overwritten: [],
    skipped: [],
  };

  try {
    for (const file of files) {
      await writeFile(file, opts.dir, io, result);
    }
    // In an existing app, statically re-wire the flow set (both pre-existing and newly
    // written flows) so `flowModules` stays correct — the `loom gen` step, unconditional.
    if (existing) {
      regenerateRegistration(opts.dir, io, result);
    }
  } finally {
    io.close?.();
  }

  return result;
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
