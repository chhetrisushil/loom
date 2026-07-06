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

/** `loom gen [--dir app]` — write `<dir>/loom.gen.ts` from the discovered flows. */
export function cmdGen(dir: string): { out: string; count: number } {
  const specifiers = discoverFlows(dir);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "loom.gen.ts");
  fs.writeFileSync(out, generateRegistration(specifiers));
  return { out, count: specifiers.length };
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
