import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * This package's own `name` and `version`, read from its package.json so the MCP handshake
 * (`clientInfo` / `serverInfo`) never advertises a stale hard-coded version. The package compiles
 * to CommonJS with output directly under `dist/`, so `..` from both `dist/` and `src/` (tests) is
 * the package root. Read once, on first use.
 */
let cached: { name: string; version: string } | undefined;

export function packageInfo(): { name: string; version: string } {
  if (cached === undefined) {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      name: string;
      version: string;
    };
    cached = { name: pkg.name, version: pkg.version };
  }
  return cached;
}
