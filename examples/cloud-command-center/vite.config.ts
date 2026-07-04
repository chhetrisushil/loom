import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { loomPlugin } from "@loom/compiler";

export default defineConfig({
  plugins: [loomPlugin(), react()],
  resolve: { conditions: ["require", "default"] },
  optimizeDeps: {
    include: [
      "@loom/blueprint-runtime",
      "@loom/core",
      "@loom/effect-runtime",
      "@loom/event-runtime",
      "@loom/projection-runtime",
      "@loom/renderer-react",
      "@loom/snapshot-runtime",
      "@loom/workflow-runtime",
    ],
  },
});
