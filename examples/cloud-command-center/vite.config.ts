import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { loomPlugin } from "@loom/compiler";

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
});
