import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
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
