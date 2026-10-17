import { describe, expect, it } from "vitest";
import { type PluginFinding, checkPlugin, wiresConformance } from "./plugin";

const WIRED = [
  'import { runEventStoreConformance } from "@loom/conformance";',
  "runEventStoreConformance(() => new X());",
].join("\n");

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
      [WIRED]
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
      [WIRED]
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
      [WIRED]
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
      [WIRED]
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
      [WIRED]
    );
    expect(levels(findings, "warn").join()).toMatch(/peer-depend/);
  });

  it("warns on missing loom-plugin keyword and missing conformance", () => {
    const findings = checkPlugin({ name: "loom-plugin-x" }, []);
    expect(levels(findings, "warn").join()).toMatch(/keyword/);
    expect(levels(findings, "warn").join()).toMatch(/conformance/);
  });

  it("warns when the name follows neither convention", () => {
    const findings = checkPlugin({ name: "my-thing" }, [WIRED]);
    expect(levels(findings, "warn").join()).toMatch(/neither/);
  });

  it("allows a legitimate workflow-runtime dependency (a2a/renderer pattern)", () => {
    const findings = checkPlugin(
      { name: "@loom/plugin-a2a", dependencies: { "@loom/workflow-runtime": "workspace:*" } },
      [WIRED]
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
      [WIRED],
      { publish: true }
    );
    // no publish-readiness warnings for a complete manifest
    expect(levels(ready, "warn")).toEqual([]);
  });
});

describe("wiresConformance", () => {
  const IMPORT = 'import { runEventStoreConformance } from "@loom/conformance";';
  it("accepts a real import plus a real call", () => {
    expect(wiresConformance(`${IMPORT}\nrunEventStoreConformance(() => new X());`)).toBe(true);
  });
  it("rejects the scaffold's commented-out call", () => {
    expect(wiresConformance(`${IMPORT}\n// runEventStoreConformance(() => new X());`)).toBe(false);
    expect(wiresConformance(`${IMPORT}\n/* runEventStoreConformance(() => new X()); */`)).toBe(
      false
    );
  });
  it("rejects a call named only inside a string, and a commented-out import", () => {
    expect(wiresConformance(`${IMPORT}\nconst s = "runEventStoreConformance(";`)).toBe(false);
    expect(
      wiresConformance(
        '// import { runEventStoreConformance } from "@loom/conformance";\nrunEventStoreConformance(x);'
      )
    ).toBe(false);
  });
  it("rejects a bare mention and an import without a call", () => {
    expect(wiresConformance("@loom/conformance")).toBe(false);
    expect(wiresConformance(IMPORT)).toBe(false);
  });
  it("accepts an aliased import, a namespace import, a default import and a subpath", () => {
    expect(wiresConformance('import { runA as go } from "@loom/conformance";\ngo(x);')).toBe(true);
    expect(wiresConformance('import * as c from "@loom/conformance";\nc.runAConformance(x);')).toBe(
      true
    );
    expect(wiresConformance('import c from "@loom/conformance";\nc.runAConformance(x);')).toBe(
      true
    );
    expect(
      wiresConformance('import { runA } from "@loom/conformance/event-store";\nrunA(x);')
    ).toBe(true);
    expect(wiresConformance('import { type T, runA } from "@loom/conformance";\nrunA(x);')).toBe(
      true
    );
  });
  it("accepts dynamic import and require bindings", () => {
    expect(
      wiresConformance('const c = await import("@loom/conformance");\nc.runAConformance(x);')
    ).toBe(true);
    expect(
      wiresConformance('const { runA: go, b } = await import("@loom/conformance");\ngo(x);')
    ).toBe(true);
    expect(wiresConformance('const { runA } = require("@loom/conformance");\nrunA(x);')).toBe(true);
    expect(wiresConformance('(await import("@loom/conformance")).runAConformance(x);')).toBe(true);
    expect(wiresConformance('const c = await import("@loom/conformance");\nc.other(x);')).toBe(
      false
    );
  });
  it("sees a call inside a template ${ } but not template text", () => {
    expect(wiresConformance(`${IMPORT}\nconst s = \`a \${runEventStoreConformance(x)} b\`;`)).toBe(
      true
    );
    expect(wiresConformance(`${IMPORT}\nconst s = \`runEventStoreConformance(x)\`;`)).toBe(false);
    expect(
      wiresConformance(`${IMPORT}\nconst s = \`\${ {a: 1}.a } \${runEventStoreConformance(x)}\`;`)
    ).toBe(true);
  });
  it("a regex literal holding a quote or backtick does not open a phantom string", () => {
    expect(wiresConformance(`${IMPORT}\nconst r = /["'\`]/;\nrunEventStoreConformance(x);`)).toBe(
      true
    );
    expect(wiresConformance(`${IMPORT}\nx.replace(/\`/g, "");\nrunEventStoreConformance(x);`)).toBe(
      true
    );
    // ...and a division is not a regex
    expect(
      wiresConformance(`${IMPORT}\nconst h = a / b; runEventStoreConformance(x); c / d;`)
    ).toBe(true);
    expect(wiresConformance(`${IMPORT}\nconst r = /runEventStoreConformance(/;`)).toBe(false);
  });
  it("rejects a type-only import, an unrelated object's method and a local definition", () => {
    expect(wiresConformance('import type { runA } from "@loom/conformance";\nrunA(x);')).toBe(
      false
    );
    expect(wiresConformance('import { type runA } from "@loom/conformance";\nrunA(x);')).toBe(
      false
    );
    expect(wiresConformance(`${IMPORT}\nother.runEventStoreConformance(1);`)).toBe(false);
    expect(wiresConformance(`${IMPORT}\nfunction runMyConformance() {}`)).toBe(false);
    expect(wiresConformance('import { x } from "@loom/other";\nrunA(x);')).toBe(false);
    expect(
      wiresConformance('import * as c from "@loom/conformance";\nother.runAConformance(1);')
    ).toBe(false);
  });
  it("handles a large semicolon-less file linearly (and correctly)", () => {
    const lines: string[] = [];
    for (let i = 0; i < 20000; i++) lines.push(`import a${i} from "./m${i}"`);
    const noKit = lines.join("\n");
    expect(wiresConformance(noKit)).toBe(false);
    expect(wiresConformance(`${noKit}\n${IMPORT}\nrunEventStoreConformance(x)`)).toBe(true);
  });
  it("checkPlugin warns when only a comment mentions the kit", () => {
    const findings = checkPlugin({ name: "loom-plugin-x", keywords: ["loom-plugin"] }, [
      `${IMPORT}\n// runEventStoreConformance(() => new X());`,
    ]);
    expect(levels(findings, "warn").join()).toMatch(/conformance/);
  });
});
