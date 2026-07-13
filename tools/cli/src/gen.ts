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

/**
 * `loom gen [--dir app]` — write `<dir>/loom.gen.ts` registering the discovered
 * flows, agents, and tools (the folder convention). Returns per-kind counts.
 */
export function cmdGen(dir: string): {
  out: string;
  count: number;
  flows: number;
  agents: number;
  tools: number;
} {
  const flows = discoverFlows(dir);
  const agents = discoverAgents(dir);
  const tools = discoverTools(dir);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "loom.gen.ts");
  fs.writeFileSync(out, generateRegistration(flows, agents, tools));
  return {
    out,
    count: flows.length,
    flows: flows.length,
    agents: agents.length,
    tools: tools.length,
  };
}

/** `loom new <kind> <name> [--dir app]` — scaffold a single flow/agent/tool file. */
export function cmdNew(
  kind: string,
  name: string,
  dir: string
): { path: string; created: boolean } {
  if (kind !== "flow" && kind !== "agent" && kind !== "tool") {
    throw new Error(`unknown kind "${kind}" — expected flow | agent | tool`);
  }
  const { path: rel, content } = newFile(kind, name);
  const dest = path.join(dir, rel.replace(/^app\//, ""));
  if (fs.existsSync(dest)) {
    return { path: dest, created: false };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content);
  return { path: dest, created: true };
}
