import { loomPlugin } from "@loom/compiler";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [loomPlugin(), react()],
  resolve: { conditions: ["require", "default"] },
  optimizeDeps: {
    include: [
      "@loom/app",
      "@loom/a2ui",
      "@loom/blueprint-runtime",
      "@loom/capability",
      "@loom/core",
      "@loom/intent",
      "@loom/effect-runtime",
      "@loom/event-runtime",
      "@loom/projection-runtime",
      "@loom/plugin-renderer-react",
      "@loom/sdk",
      "@loom/snapshot-runtime",
      "@loom/telemetry",
      "@loom/workflow-runtime",
    ],
  },
  // The @loom/* workspace packages ship CommonJS. `vite build` hands them to
  // Rollup, whose CommonJS interop cannot statically trace named exports through
  // the transitive re-export getter chain (e.g. "step$ is not exported by
  // dist/index.js"). transformMixedEsModules resolves those named exports.
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
      include: [/node_modules/, /packages\/.*\/dist/, /plugins\/.*\/dist/],
    },
  },
});
