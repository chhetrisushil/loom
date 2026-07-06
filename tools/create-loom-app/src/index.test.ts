import { describe, expect, it } from "vitest";
import { scaffoldFiles } from "./index";

describe("scaffoldFiles", () => {
  it("emits a defineConfig-wired skeleton with the app name", () => {
    const files = scaffoldFiles("acme-support");

    // The essential files a developer writes.
    for (const f of [
      "package.json",
      "src/tools.ts",
      "src/steps.ts",
      "src/flow.ts",
      "src/middleware.ts",
      "src/config.ts",
      "src/main.ts",
      "src/greet.test.ts",
    ]) {
      expect(files[f], f).toBeTruthy();
    }

    expect(files["package.json"]).toContain('"name": "acme-support"');
    expect(files["package.json"]).toContain("@loom/app");
    expect(files["src/config.ts"]).toContain("defineConfig");
    expect(files["src/middleware.ts"]).toContain("retryMiddleware");
    expect(files["src/flow.ts"]).toContain("flow$");
    // Generated code must not contain unresolved template placeholders.
    for (const content of Object.values(files)) {
      expect(content).not.toContain("${");
    }
  });
});
