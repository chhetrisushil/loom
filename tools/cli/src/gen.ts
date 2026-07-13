import * as fs from "node:fs";
import * as path from "node:path";
import { generateRegistration, newFile } from "@loom/scaffold";

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
    if (m && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
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
} {
  const flows = discoverFlows(dir);
  const agents = discoverAgents(dir);
  const tools = discoverTools(dir);
  const skills = discoverSkills(dir);
  const schedules = discoverSchedules(dir);
  const memories = discoverMemories(dir);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "loom.gen.ts");
  fs.writeFileSync(out, generateRegistration(flows, agents, tools, skills, schedules, memories));
  return {
    out,
    count: flows.length,
    flows: flows.length,
    agents: agents.length,
    tools: tools.length,
    skills: skills.length,
    schedules: schedules.length,
    memories: memories.length,
  };
}

/** `loom new <kind> <name> [--dir app]` — scaffold a single flow/agent/tool file. */
export function cmdNew(
  kind: string,
  name: string,
  dir: string
): { path: string; created: boolean } {
  const kinds = ["flow", "agent", "tool", "skill", "schedule", "memory"];
  if (!kinds.includes(kind)) {
    throw new Error(`unknown kind "${kind}" — expected ${kinds.join(" | ")}`);
  }
  const { path: rel, content } = newFile(kind as Parameters<typeof newFile>[0], name);
  const dest = path.join(dir, rel.replace(/^app\//, ""));
  if (fs.existsSync(dest)) {
    return { path: dest, created: false };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  return { path: dest, created: true };
}
