import * as fs from "node:fs";
import * as path from "node:path";
import {
  THIRD_PARTY_SPECS,
  constructNameProblem,
  generateRegistration,
  importedPackages,
  newFiles,
} from "@loom/scaffold";
import { UsageError } from "./args";

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
 */
export function cmdGen(dir: string): {
  out: string;
  count: number;
  flows: number;
  agents: number;
  tools: number;
  skills: number;
  schedules: number;
  memories: number;
  projections: number;
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
  fs.writeFileSync(
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
  };
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
  dir: string
): {
  path: string;
  created: boolean;
  extras: { path: string; created: boolean }[];
  missingDeps: string[];
} {
  const kinds = ["flow", "agent", "tool", "skill", "schedule", "memory", "projection", "sentinel"];
  if (!kinds.includes(kind)) {
    throw new UsageError(`unknown kind "${kind}" — expected ${kinds.join(" | ")}`);
  }
  const problem = constructNameProblem(name);
  if (problem !== undefined) throw new UsageError(`loom new: ${problem}`);
  const files = newFiles(kind as Parameters<typeof newFiles>[0], name);
  const written = files.map(({ path: rel, content }) => {
    const dest = path.join(dir, rel.replace(/^app\//, ""));
    if (fs.existsSync(dest)) return { path: dest, created: false };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    return { path: dest, created: true };
  });
  const [main, ...extras] = written as [(typeof written)[number], ...typeof written];
  const fresh = files.filter((_, i) => written[i]?.created).map((f) => f.content);
  return { ...main, extras, missingDeps: missingDependencies(dir, fresh) };
}
