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

const USAGE = "usage: create-loom-app <directory>";

function main(argv: string[]): void {
  const target = argv[2];
  if (!target) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (target === "--help" || target === "-h") {
    console.log(USAGE);
    return;
  }
  // A flag is not a directory name. Without this, `create-loom-app --help` scaffolds eleven
  // files into a folder literally called `--help` and reports success — the argument was
  // never validated because the only check was that it existed.
  if (target.startsWith("-")) {
    console.error(`create-loom-app: "${target}" is not a directory name\n${USAGE}`);
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
// `require.main === module`, not a filename check: `npm create loom-app` and any global
// install invoke this through a symlink named `create-loom-app`, where argv[1] never ends
// in "index.js" — the scaffolder would exit 0 having created nothing.
if (require.main === module) {
  main(process.argv);
}
