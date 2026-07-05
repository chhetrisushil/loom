import path from "node:path";
import ts from "typescript";
import type { Plugin, ResolvedConfig } from "vite";
import { buildManifest, printWarnings } from "./manifest";
import { transformFile } from "./transform";
import type { PluginState } from "./types";

const VIRTUAL_PREFIX = "\0loom:chunk:";

export function loomPlugin(): Plugin {
  const state: PluginState = {
    chunks: new Map(),
    steps: new Map(),
    stepsByVarName: new Map(),
    flows: new Map(),
  };

  let resolvedConfig: ResolvedConfig;

  return {
    name: "loom",
    enforce: "pre",

    configResolved(config) {
      resolvedConfig = config;
    },

    resolveId(id) {
      if (id.startsWith(VIRTUAL_PREFIX) || id.startsWith("\0loom:")) {
        return id;
      }
      return undefined;
    },

    load(id) {
      if (id.startsWith(VIRTUAL_PREFIX)) {
        const chunk = state.chunks.get(id);
        if (chunk) {
          // Transpile TS → JS so Vite/Rollup can parse the chunk (no .ts extension on virtual ids)
          const result = ts.transpileModule(chunk.chunkSource, {
            compilerOptions: {
              target: ts.ScriptTarget.ESNext,
              module: ts.ModuleKind.ESNext,
            },
          });
          return { code: result.outputText };
        }
      }
      return undefined;
    },

    transform(code, id) {
      if (!/\.[jt]sx?$/.test(id) || id.includes("node_modules")) return undefined;
      const result = transformFile(code, id, state);
      if (!result) return undefined;
      return { code: result.code, map: result.map };
    },

    generateBundle() {
      const outDir = resolvedConfig?.build?.outDir ?? "dist";
      const manifest = buildManifest(state, path.relative(process.cwd(), outDir));
      printWarnings(manifest);

      this.emitFile({
        type: "asset",
        fileName: "loom-manifest.json",
        source: JSON.stringify(manifest, null, 2),
      });
    },
  };
}
