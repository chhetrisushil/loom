import { describe, expect, it } from "vitest";
import { type PluginFinding, checkPlugin } from "./plugin";

const levels = (f: PluginFinding[], level: PluginFinding["level"]) =>
  f.filter((x) => x.level === level).map((x) => x.message);

describe("checkPlugin", () => {
  it("passes a well-formed third-party store plugin", () => {
    const findings = checkPlugin(
      {
        name: "loom-plugin-redis",
        keywords: ["loom", "loom-plugin"],
        peerDependencies: { "@loom/event-runtime": "*", "@loom/snapshot-runtime": "*" },
      },
      ['import { runEventStoreConformance } from "@loom/conformance";']
    );
    expect(levels(findings, "error")).toEqual([]);
    expect(levels(findings, "warn")).toEqual([]);
  });

  it("warns when the exports map cannot be entered from ESM", () => {
    // The shape 49 loom packages carried and the scaffold used to emit: matched in
    // order, `require` first, nothing an `import` offers — so it resolves for CJS and
    // raises ERR_PACKAGE_PATH_NOT_EXPORTED for ESM. tsc and a CJS runner both miss it.
    const findings = checkPlugin(
      {
        name: "loom-plugin-redis",
        keywords: ["loom", "loom-plugin"],
        exports: { ".": { require: "./dist/index.js", types: "./dist/index.d.ts" } },
      },
      ['import { runMemoryStoreConformance } from "@loom/conformance";']
    );
    expect(levels(findings, "warn")[0]).toMatch(/ERR_PACKAGE_PATH_NOT_EXPORTED/);
  });

  it("warns when `default` shadows a later condition", () => {
    const findings = checkPlugin(
      {
        name: "loom-plugin-redis",
        keywords: ["loom", "loom-plugin"],
        exports: { ".": { default: "./dist/index.js", require: "./dist/index.js" } },
      },
      ['import { runMemoryStoreConformance } from "@loom/conformance";']
    );
    expect(levels(findings, "warn")[0]).toMatch(/anything after it is dead/);
  });

  it("passes an exports map that resolves both ways", () => {
    const findings = checkPlugin(
      {
        name: "loom-plugin-redis",
        keywords: ["loom", "loom-plugin"],
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            require: "./dist/index.js",
            default: "./dist/index.js",
          },
        },
      },
      ['import { runMemoryStoreConformance } from "@loom/conformance";']
    );
    expect(levels(findings, "warn")).toEqual([]);
    expect(levels(findings, "ok")).toContain("exports resolve for both require() and import");
  });

  it("errors when the plugin depends on the replay fold engine", () => {
    const findings = checkPlugin(
      { name: "@loom/plugin-x", dependencies: { "@loom/replay-vm": "workspace:*" } },
      []
    );
    expect(levels(findings, "error")[0]).toMatch(/replay fold/);
  });

  it("warns a third-party plugin that bundles SPI packages instead of peering them", () => {
    const findings = checkPlugin(
      {
        name: "loom-plugin-x",
        keywords: ["loom-plugin"],
        dependencies: { "@loom/event-runtime": "*" },
      },
      ["conformance"]
    );
    expect(levels(findings, "warn").join()).toMatch(/peer-depend/);
  });

  it("warns on missing loom-plugin keyword and missing conformance", () => {
    const findings = checkPlugin({ name: "loom-plugin-x" }, []);
    expect(levels(findings, "warn").join()).toMatch(/keyword/);
    expect(levels(findings, "warn").join()).toMatch(/conformance/);
  });

  it("warns when the name follows neither convention", () => {
    const findings = checkPlugin({ name: "my-thing" }, ["@loom/conformance"]);
    expect(levels(findings, "warn").join()).toMatch(/neither/);
  });

  it("allows a legitimate workflow-runtime dependency (a2a/renderer pattern)", () => {
    const findings = checkPlugin(
      { name: "@loom/plugin-a2a", dependencies: { "@loom/workflow-runtime": "workspace:*" } },
      ["@loom/conformance"]
    );
    expect(levels(findings, "error")).toEqual([]);
  });

  it("with --publish, warns on npm-readiness gaps (version/description/license/repo/exports)", () => {
    const bare = checkPlugin(
      { name: "loom-plugin-x", keywords: ["loom-plugin"], version: "0.0.0" },
      [],
      {
        publish: true,
      }
    );
    const warns = levels(bare, "warn").join("\n");
    expect(warns).toMatch(/version is 0\.0\.0/);
    expect(warns).toMatch(/no description/);
    expect(warns).toMatch(/no license/);
    expect(warns).toMatch(/no repository/);
    expect(warns).toMatch(/exports\/main/);

    const ready = checkPlugin(
      {
        name: "loom-plugin-x",
        keywords: ["loom-plugin"],
        version: "1.0.0",
        description: "A store",
        license: "MIT",
        repository: "github:me/loom-plugin-x",
        exports: { ".": {} },
      },
      ["@loom/conformance"],
      { publish: true }
    );
    // no publish-readiness warnings for a complete manifest
    expect(levels(ready, "warn")).toEqual([]);
  });
});
