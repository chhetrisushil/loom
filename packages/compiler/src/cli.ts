#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildManifest, printWarnings } from "./manifest";
import { transformFile } from "./transform";
import type { PluginState } from "./types";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "dist") {
      walk(full, out);
    } else if (entry.isFile() && /\.[jt]sx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const [, , srcDir = "src", outDir = "dist-loom"] = process.argv;

  const state: PluginState = {
    chunks: new Map(),
    steps: new Map(),
    stepsByVarName: new Map(),
    flows: new Map(),
  };

  const files = walk(path.resolve(srcDir));
  for (const file of files) {
    const code = fs.readFileSync(file, "utf-8");
    const result = transformFile(code, file, state);
    if (result) {
      const rel = path.relative(path.resolve(srcDir), file);
      const dest = path.join(outDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, result.code, "utf-8");
      if (result.map) {
        fs.writeFileSync(`${dest}.map`, result.map, "utf-8");
      }
    }
  }

  for (const [virtualId, chunk] of state.chunks) {
    const fileName = `${virtualId.replace("\0loom:chunk:", "chunks/")}.js`;
    const dest = path.join(outDir, fileName);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, chunk.chunkSource, "utf-8");
  }

  const manifest = buildManifest(state, outDir);
  printWarnings(manifest);
  fs.writeFileSync(
    path.join(outDir, "loom-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8"
  );

  console.log(`[loom-compiler] Done. Processed ${files.length} source files.`);
}

main().catch((err) => {
  console.error("[loom-compiler] Fatal:", err);
  process.exit(1);
});
