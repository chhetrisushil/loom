import { defineConfig } from "vite";

// No framework plugin — this app is plain Web Components (Custom Elements) over
// the framework-agnostic Loom render primitives (traverseBlueprint /
// resolveWidgetValue / ProjectionRuntime).
//
// The @loom/* workspace packages ship CommonJS; transformMixedEsModules lets
// Rollup trace their named exports through the re-export getter chain during
// `vite build`. @loom/a2a is used for its *types* only (import type …), so its
// Node http server never reaches the bundle.
export default defineConfig({
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
      "@loom/planner",
      "@loom/projection-runtime",
      "@loom/registry",
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
