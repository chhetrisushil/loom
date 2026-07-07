import { defineConfig } from "vitest/config";

export default defineConfig({
  // Workspace packages publish their built CJS via the "require"/"default"
  // conditions — tell Vite to resolve them the same way.
  resolve: { conditions: ["require", "default"] },
  test: { environment: "node" },
});
