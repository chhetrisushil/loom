import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The browser dashboard. The package stays CommonJS (so the tsx CLI + vitest resolve
// the CJS @loom packages); this config is an .mts file so Vite loads it via its ESM
// API. The @loom/* packages compile to CJS, so they're pre-bundled + resolved via the
// "require" condition.
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ["require", "default"] },
  optimizeDeps: {
    include: [
      "@loom/blueprint-runtime",
      "@loom/core",
      "@loom/effect-runtime",
      "@loom/llm",
      "@loom/projection-runtime",
      "@loom/renderer-react",
    ],
  },
  build: {
    outDir: "dist/ui",
    commonjsOptions: {
      transformMixedEsModules: true,
      include: [/node_modules/, /packages\/.*\/dist/],
    },
  },
});
