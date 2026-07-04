import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { loomPlugin } from "@loom/compiler";

export default defineConfig({
  plugins: [loomPlugin(), react()],
  resolve: { conditions: ["require", "default"] },
  optimizeDeps: {
    include: [
      "@loom/a2ui",
      "@loom/blueprint-runtime",
      "@loom/capability",
      "@loom/core",
      "@loom/intent",
      "@loom/effect-runtime",
      "@loom/event-runtime",
      "@loom/projection-runtime",
      "@loom/renderer-react",
      "@loom/sdk",
      "@loom/snapshot-runtime",
      "@loom/telemetry",
      "@loom/workflow-runtime",
    ],
  },
});
