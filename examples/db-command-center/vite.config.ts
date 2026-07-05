import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The @loom/* workspace packages ship CommonJS. Vite pre-bundles them in dev via
// optimizeDeps, but `vite build` (build:ui) hands them to Rollup, whose CommonJS
// interop cannot statically trace named exports through the transitive re-export
// getter chain. transformMixedEsModules lets the CommonJS plugin resolve them.
//
// NB: this example does NOT enable @loom/compiler's loomPlugin(). Its build-time
// handler$ extraction hoists each handler body into a virtual chunk, which can't
// re-resolve the shared modules our handlers import (the diagnostics ReAct
// runner, the mock tools, the LLM provider). handler$ works fine at runtime
// without it — LazyEffect resolves the HandlerRef directly. See
// examples/cloud-command-center for the loomPlugin() compiler demo.
//
// @loom/a2a is used for its *types* only (import type …) plus an in-process A2A
// transport (src/a2a/…); `import type` is fully elided, so its Node http server
// never reaches the bundle.
export default defineConfig({
  plugins: [react()],
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
