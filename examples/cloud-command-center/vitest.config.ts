import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["require", "default"] },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
