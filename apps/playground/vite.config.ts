import { loomPlugin } from "@loomwork/compiler";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [loomPlugin(), react()],
  resolve: { conditions: ["require", "default"] },
  optimizeDeps: {
    include: [
      "@loomwork/app",
      "@loomwork/agent-surface",
      "@loomwork/blueprint-runtime",
      "@loomwork/capability",
      "@loomwork/core",
      "@loomwork/intent",
      "@loomwork/effect-runtime",
      "@loomwork/event-runtime",
      "@loomwork/projection-runtime",
      "@loomwork/plugin-a2ui",
      "@loomwork/plugin-renderer-react",
      "@loomwork/sdk",
      "@loomwork/snapshot-runtime",
      "@loomwork/telemetry",
      "@loomwork/workflow-runtime",
    ],
  },
  // The @loomwork/* workspace packages ship CommonJS. `vite build` hands them to
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
