#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { appFiles } from "@loom/scaffold";

/**
 * The file map for a new Loom app (folder convention, wired via defineConfig).
 * Templates live in `@loom/scaffold`, shared with `loom new`. Re-exported here as
 * `scaffoldFiles` for backwards compatibility.
 */
export const scaffoldFiles = appFiles;

function main(argv: string[]): void {
  const target = argv[2];
  if (!target) {
    console.error("usage: create-loom-app <directory>");
    process.exitCode = 1;
    return;
  }
  const root = path.resolve(process.cwd(), target);
  const appName = path.basename(root);
  const files = appFiles(appName);
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  console.log(`Scaffolded ${Object.keys(files).length} files into ${target}/`);
  console.log(`Next: cd ${target} && pnpm install && pnpm test`);
}

// Run only when invoked as a CLI (not when imported by tests).
if (process.argv[1]?.endsWith("index.js")) {
  main(process.argv);
}
