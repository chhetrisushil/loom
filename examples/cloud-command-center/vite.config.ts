import { loomPlugin } from "@loom/compiler";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The @loom/* workspace packages ship CommonJS. Vite pre-bundles them in dev via
// optimizeDeps, but `vite build` (build:ui) hands them to Rollup, whose CommonJS
// interop cannot statically trace named exports through the transitive re-export
// getter chain (e.g. "LlmEffect is not exported by dist/index.js").
// transformMixedEsModules lets the CommonJS plugin resolve those named exports.
export default defineConfig({
  plugins: [loomPlugin(), react()],
  resolve: { conditions: ["require", "default"] },
  optimizeDeps: {
    include: [
      "@loom/a2ui",
      "@loom/agent",
      "@loom/blueprint-runtime",
      "@loom/capability",
      "@loom/core",
      "@loom/effect-runtime",
      "@loom/event-runtime",
      "@loom/intent",
      "@loom/llm",
      "@loom/projection-runtime",
      "@loom/renderer-react",
      "@loom/snapshot-runtime",
      "@loom/workflow-runtime",
    ],
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
      include: [/node_modules/, /packages\/.*\/dist/],
    },
  },
});
