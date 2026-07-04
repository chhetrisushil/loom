import { defineConfig } from "vite";
import angular from "@analogjs/vite-plugin-angular";

export default defineConfig({
  plugins: [angular()],
  resolve: { conditions: ["require", "default"] },
  optimizeDeps: {
    include: [
      "@loom/core",
      "@loom/effect-runtime",
      "@loom/event-runtime",
      "@loom/projection-runtime",
      "@loom/snapshot-runtime",
      "@loom/telemetry",
      "@loom/workflow-runtime",
    ],
  },
});
