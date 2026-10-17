import * as fs from "node:fs";
import * as path from "node:path";
import {
  FLOW_TEMPLATES,
  THIRD_PARTY_SPECS,
  constructNameProblem,
  generateRegistration,
  importedPackages,
  isFlowTemplate,
  newFiles,
  templateNotes,
} from "@loom/scaffold";
import { UsageError } from "./args";
import { safeWriteFile } from "./safeWrite";
import { type TreeChange, watchTree } from "./watch";

/**
 * Discover flow modules under `<dir>/flows/<name>/flow.{ts,tsx}` — the folder
 * convention. Returns extension-less module specifiers relative to `dir` (where
 * `loom.gen.ts` is written), sorted for deterministic output.
 */
export function discoverFlows(dir: string): string[] {
  const flowsDir = path.join(dir, "flows");
  if (!fs.existsSync(flowsDir)) return [];
  const specifiers: string[] = [];
  for (const entry of fs.readdirSync(flowsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const ext of ["ts", "tsx"]) {
      const file = path.join(flowsDir, entry.name, `flow.${ext}`);
      if (fs.existsSync(file)) {
        specifiers.push(`./flows/${entry.name}/flow`);
        break;
      }
    }
  }
  return specifiers.sort();
}

/**
 * Discover flat-file modules under `<dir>/<sub>/<name>.{ts,tsx}` — the convention
 * `loom new agent/tool` scaffolds (`app/agents/<name>.ts`, `app/tools/<name>.ts`).
 * Returns extension-less specifiers, sorted. Shared by {@link discoverAgents} /
 * {@link discoverTools}.
 */
function discoverFlat(dir: string, sub: string): string[] {
  const base = path.join(dir, sub);
  if (!fs.existsSync(base)) return [];
  const specifiers: string[] = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const m = /^(.*)\.(ts|tsx)$/.exec(entry.name);
    if (m && !/\.(?:test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      specifiers.push(`./${sub}/${m[1]}`);
    }
  }
  return specifiers.sort();
}

/** Discover agent modules under `<dir>/agents/<name>.{ts,tsx}` (flat convention). */
export function discoverAgents(dir: string): string[] {
  return discoverFlat(dir, "agents");
}

/** Discover tool modules under `<dir>/tools/<name>.{ts,tsx}` (flat convention). */
export function discoverTools(dir: string): string[] {
  return discoverFlat(dir, "tools");
}

/** Discover skill modules under `<dir>/skills/<name>.{ts,tsx}` (flat convention). */
export function discoverSkills(dir: string): string[] {
  return discoverFlat(dir, "skills");
}

/** Discover schedule modules under `<dir>/schedules/<name>.{ts,tsx}` (flat convention). */
export function discoverSchedules(dir: string): string[] {
  return discoverFlat(dir, "schedules");
}

/** Discover memory modules under `<dir>/memories/<name>.{ts,tsx}` (flat convention). */
export function discoverMemories(dir: string): string[] {
  return discoverFlat(dir, "memories");
}

/** Discover projection modules under `<dir>/projections/<name>.{ts,tsx}` (flat convention). */
export function discoverProjections(dir: string): string[] {
  return discoverFlat(dir, "projections");
}

/**
 * `loom gen [--dir app]` — write `<dir>/loom.gen.ts` registering the discovered
 * flows, agents, tools, skills, schedules, and memories (the folder convention).
 * Returns per-kind counts.
 *
 * `root` is the symlink-containment root: nothing between it and `loom.gen.ts` may be a link. It
 * defaults to `dir` (an explicit `--dir` is trusted to be reached through a link); the CLI passes the
 * cwd when `--dir` was DEFAULTED, so a repo's own `app -> /outside` link is refused, not followed.
 */
export function cmdGen(
  dir: string,
  root: string = dir
): {
  out: string;
  count: number;
  flows: number;
  agents: number;
  tools: number;
  skills: number;
  schedules: number;
  memories: number;
  projections: number;
  /** The module specifiers `out` registers, in order (what a watcher compares against). */
  specifiers: string[];
} {
  // A typo'd --dir used to be created on the spot and "succeed" with 0 of everything.
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new UsageError(
      `loom gen: --dir "${dir}" is not an existing directory (resolved ${path.resolve(dir)}) — pass the folder that holds flows/, agents/, … (default "app")`
    );
  }
  const flows = discoverFlows(dir);
  const agents = discoverAgents(dir);
  const tools = discoverTools(dir);
  const skills = discoverSkills(dir);
  const schedules = discoverSchedules(dir);
  const memories = discoverMemories(dir);
  const projections = discoverProjections(dir);
  const out = path.join(dir, "loom.gen.ts");
  safeWriteFile(
    root,
    out,
    generateRegistration(flows, agents, tools, skills, schedules, memories, projections)
  );
  return {
    out,
    count: flows.length,
    flows: flows.length,
    agents: agents.length,
    tools: tools.length,
    skills: skills.length,
    schedules: schedules.length,
    memories: memories.length,
    projections: projections.length,
    specifiers: [
      ...flows,
      ...agents,
      ...tools,
      ...skills,
      ...schedules,
      ...memories,
      ...projections,
    ],
  };
}

/** The result line `loom gen` prints: `wrote <file> (2 flows, 0 agents, ...)`. */
export function genSummary(r: ReturnType<typeof cmdGen>): string {
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const parts = [
    plural(r.flows, "flow"),
    plural(r.agents, "agent"),
    plural(r.tools, "tool"),
    plural(r.skills, "skill"),
    plural(r.schedules, "schedule"),
    plural(r.memories, "memory").replace("memorys", "memories"),
    plural(r.projections, "projection"),
  ];
  return `wrote ${r.out} (${parts.join(", ")})`;
}

/** The convention folders `loom gen` discovers from (a change elsewhere never needs a regen). */
export const CONVENTION_FOLDERS: readonly string[] = [
  "flows",
  "agents",
  "tools",
  "skills",
  "schedules",
  "memories",
  "projections",
];

/** Every module specifier the convention currently yields - the only input to `loom.gen.ts`. */
function discoveredSpecifiers(dir: string): string[] {
  return [
    ...discoverFlows(dir),
    ...discoverAgents(dir),
    ...discoverTools(dir),
    ...discoverSkills(dir),
    ...discoverSchedules(dir),
    ...discoverMemories(dir),
    ...discoverProjections(dir),
  ];
}

export interface GenWatchOptions {
  /** One line of output (default: console.log). */
  log?: (line: string) => void;
  /** Stop watching and resolve. */
  signal?: AbortSignal;
  /** Symlink-containment root (default: the watched dir). See {@link cmdGen}. */
  root?: string;
  debounceMs?: number;
  pollMs?: number;
  /** Poll instead of `fs.watch` (tests / filesystems without events). */
  forcePoll?: boolean;
  /** Interval of the safety rescan / watcher re-arm (default 5000 ms). */
  safetyMs?: number;
}

/**
 * `loom gen --watch` - generate once, then regenerate whenever a module is ADDED, REMOVED or
 * RENAMED under a convention folder, until `signal` aborts (exit 0). Editing a file's contents
 * never changes `loom.gen.ts`, so it never regenerates; a transient failure (a folder briefly
 * missing mid-rename) is reported and watching continues.
 */
export async function genWatch(dir: string, options: GenWatchOptions = {}): Promise<number> {
  const root = options.root ?? dir;
  const log = options.log ?? ((line: string) => console.log(line));
  // The first generation is a plain `loom gen`: a bad --dir is a usage error, not a watch.
  const first = cmdGen(dir, root);
  log(genSummary(first));
  // `known` is what loom.gen.ts REGISTERS (from the same discovery that wrote it), not a second
  // look at the disk: a module added between the write and the watcher's first snapshot would
  // otherwise be in neither, and never generated.
  let known = first.specifiers;

  const watcher = watchTree(dir, {
    include: (file) => {
      const [top, ...rest] = file.split("/");
      return rest.length > 0 && CONVENTION_FOLDERS.includes(top as string) && /\.tsx?$/.test(file);
    },
    ...(options.debounceMs !== undefined && { debounceMs: options.debounceMs }),
    ...(options.pollMs !== undefined && { pollMs: options.pollMs }),
    ...(options.forcePoll !== undefined && { forcePoll: options.forcePoll }),
    ...(options.safetyMs !== undefined && { safetyMs: options.safetyMs }),
    onChange(changes: TreeChange[]) {
      if (changes.every((c) => c.kind === "changed")) return; // contents do not enter loom.gen.ts
      const now = discoveredSpecifiers(dir);
      const added = now.filter((s) => !known.includes(s));
      const removed = known.filter((s) => !now.includes(s));
      if (added.length === 0 && removed.length === 0) return; // e.g. a test file came and went
      const result = cmdGen(dir, root);
      known = result.specifiers;
      const delta = [...added.map((s) => `+${s}`), ...removed.map((s) => `-${s}`)].join(" ");
      log(`${genSummary(result)}  ${delta}`);
    },
    onError(err) {
      log(`loom gen --watch: ${err instanceof Error ? err.message : String(err)} (still watching)`);
    },
  });
  // Catch up with anything that landed between the write and the watcher's first snapshot.
  try {
    const now = discoveredSpecifiers(dir);
    if (now.length !== known.length || now.some((s, i) => s !== known[i])) {
      const result = cmdGen(dir, root);
      known = result.specifiers;
      log(genSummary(result));
    }
  } catch (err) {
    log(`loom gen --watch: ${err instanceof Error ? err.message : String(err)} (still watching)`);
  }
  log(
    `watching ${path.resolve(dir)} for added/removed modules (${watcher.mode === "watch" ? "fs.watch" : "polling"}) - Ctrl-C to stop`
  );

  await new Promise<void>((resolve) => {
    if (options.signal?.aborted) return resolve();
    options.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  watcher.close();
  return 0;
}

/** Nearest `package.json` at or above `dir`, parsed — or undefined when there is none. */
function nearestManifest(dir: string): Record<string, unknown> | undefined {
  let cur = path.resolve(dir);
  for (;;) {
    const file = path.join(cur, "package.json");
    if (fs.existsSync(file)) {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    }
    const up = path.dirname(cur);
    if (up === cur) return undefined;
    cur = up;
  }
}

/**
 * The exact `"pkg": "spec"` lines the app's `package.json` is missing for the packages the
 * generated files import. `@loom/*` take the spec the app already uses for `@loom/core`
 * (`workspace:*` in the monorepo, `*` + a `link:` override elsewhere). Never edits the file.
 */
function missingDependencies(dir: string, contents: string[]): string[] {
  const manifest = nearestManifest(dir);
  if (manifest === undefined) return [];
  const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const have = new Map<string, string>();
  for (const sec of sections) {
    const table = manifest[sec];
    if (table && typeof table === "object") {
      for (const [k, v] of Object.entries(table)) have.set(k, String(v));
    }
  }
  const loomSpec = have.get("@loom/core") ?? "workspace:*";
  const wanted = new Set(contents.flatMap(importedPackages));
  return [...wanted]
    .filter((p) => !have.has(p))
    .map((p) => `"${p}": "${p.startsWith("@loom/") ? loomSpec : (THIRD_PARTY_SPECS[p] ?? "*")}"`);
}

/**
 * `loom new <kind> <name> [--dir app]` — scaffold a single flow/agent/tool file (and, for a flow,
 * a sibling test). The name must be kebab-case and can never leave the convention folder.
 * `missingDeps` is the `package.json` lines the new files need that the app does not declare.
 */
export function cmdNew(
  kind: string,
  name: string,
  dir: string,
  template?: string,
  root: string = dir
): {
  path: string;
  created: boolean;
  extras: { path: string; created: boolean }[];
  missingDeps: string[];
  /** Manual follow-ups the template cannot do for you (wiring in the app's own config). */
  notes: string[];
} {
  const kinds = ["flow", "agent", "tool", "skill", "schedule", "memory", "projection", "sentinel"];
  if (!kinds.includes(kind)) {
    throw new UsageError(`unknown kind "${kind}" — expected ${kinds.join(" | ")}`);
  }
  const problem = constructNameProblem(name);
  if (problem !== undefined) throw new UsageError(`loom new: ${problem}`);
  if (template !== undefined) {
    if (kind !== "flow") {
      throw new UsageError(`loom new: --template applies to \`flow\` only (got kind "${kind}")`);
    }
    if (!isFlowTemplate(template)) {
      throw new UsageError(
        `loom new: unknown --template "${template}" - expected ${FLOW_TEMPLATES.join(" | ")}`
      );
    }
  }
  const files = newFiles(
    kind as Parameters<typeof newFiles>[0],
    name,
    template !== undefined && isFlowTemplate(template) ? template : "echo"
  );
  const written = files.map(({ path: rel, content }) => {
    const dest = path.join(dir, rel.replace(/^app\//, ""));
    if (fs.existsSync(dest)) return { path: dest, created: false };
    safeWriteFile(root, dest, content);
    return { path: dest, created: true };
  });
  const [main, ...extras] = written as [(typeof written)[number], ...typeof written];
  const fresh = files.filter((_, i) => written[i]?.created).map((f) => f.content);
  const chosen = template !== undefined && isFlowTemplate(template) ? template : "echo";
  return {
    ...main,
    extras,
    missingDeps: missingDependencies(dir, fresh),
    notes: main.created ? templateNotes(chosen, name) : [],
  };
}
