import * as fs from "node:fs";
import * as path from "node:path";
import { listSeams, pluginFiles } from "@loom/scaffold";

/**
 * `loom plugin new <seam> <name> [--first-party] [--dir .]` — scaffold a plugin
 * package for a seam. Writes a package.json, tsconfig, a preset/SPI stub, a
 * conformance-wired test, and a README. Never overwrites an existing file.
 */
export function cmdPluginNew(
  seam: string,
  name: string,
  opts: { firstParty: boolean; dir: string }
): { dir: string; written: string[]; skipped: string[] } {
  const files = pluginFiles(seam, name, { firstParty: opts.firstParty });
  const written: string[] = [];
  const skipped: string[] = [];
  let root = "";
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(opts.dir, rel);
    if (root === "")
      root = path.join(
        opts.dir,
        rel
          .split("/")
          .slice(0, opts.firstParty ? 2 : 1)
          .join("/")
      );
    if (fs.existsSync(dest)) {
      skipped.push(dest);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
    written.push(dest);
  }
  return { dir: root, written, skipped };
}

/** `loom plugin seams` — list the seams a plugin can target. */
export function cmdPluginSeams(): string {
  return listSeams();
}
