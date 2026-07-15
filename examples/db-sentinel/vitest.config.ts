import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["require", "default"] },
  test: { environment: "node", testTimeout: 120_000 },
});
