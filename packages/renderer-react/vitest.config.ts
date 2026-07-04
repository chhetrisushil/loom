import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ["require", "default"] },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
