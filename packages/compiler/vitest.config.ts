import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["require", "default"] },
  test: {
    environment: "node",
    // The compiler currently ships no unit tests; don't fail the suite for it
    // (matches @loom/sdk). Tests can be added later without changing this.
    passWithNoTests: true,
  },
});
