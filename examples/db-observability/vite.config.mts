import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The browser dashboard. The package stays CommonJS (so the tsx CLI + vitest resolve
// the CJS @loom packages); this config is an .mts file so Vite loads it via its ESM
// API. The @loom/* packages compile to CJS, so they're pre-bundled + resolved via the
// "require" condition.
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ["require", "default"] },
  // Pre-bundle the CJS @loom packages the browser imports as runtime values. Only
  // packages declared in this example's package.json are listed — @loom/effect-runtime
  // is a transitive dep of @loom/llm (imported type-only here), so it must NOT be an
  // explicit entry or Vite fails to resolve it from the example root.
  optimizeDeps: {
    include: [
      "@loom/blueprint-runtime",
      "@loom/core",
      "@loom/llm",
      "@loom/projection-runtime",
      "@loom/plugin-renderer-react",
    ],
  },
  build: {
    outDir: "dist/ui",
    commonjsOptions: {
      transformMixedEsModules: true,
      include: [/node_modules/, /packages\/.*\/dist/, /plugins\/.*\/dist/],
    },
  },
});
