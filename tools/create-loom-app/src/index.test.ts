import { describe, expect, it } from "vitest";
import { scaffoldFiles } from "./index";

describe("scaffoldFiles", () => {
  it("emits a convention-following, defineConfig-wired skeleton", () => {
    const files = scaffoldFiles("acme-support");

    // The folder convention.
    for (const f of [
      "package.json",
      "loom.config.ts",
      "app/config.ts",
      "app/middleware.ts",
      "app/loom.gen.ts",
      "app/flows/greet/flow.ts",
      "app/main.ts",
      "app/greet.test.ts",
    ]) {
      expect(files[f], f).toBeTruthy();
    }

    expect(files["package.json"]).toContain('"name": "acme-support"');
    expect(files["package.json"]).toContain("@loom/app");
    expect(files["app/config.ts"]).toContain("defineConfig");
    expect(files["app/config.ts"]).toContain("flowModules");
    expect(files["app/middleware.ts"]).toContain("retryMiddleware");
    expect(files["app/flows/greet/flow.ts"]).toContain("flow$");
    // loom.gen.ts imports the starter flow so the app runs out of the box.
    expect(files["app/loom.gen.ts"]).toContain("./flows/greet/flow");
    // Generated code must not contain unresolved template placeholders.
    for (const content of Object.values(files)) {
      expect(content).not.toContain("${");
    }
  });
});
