import { describe, expect, it } from "vitest";
import { SEAM_KEYS, listSeams, pluginFiles } from "./plugin";

describe("pluginFiles", () => {
  it("scaffolds a first-party store plugin under plugins/ with the @loom/plugin- name", () => {
    const files = pluginFiles("store", "acme", { firstParty: true });
    expect(Object.keys(files).sort()).toEqual([
      "plugins/acme/README.md",
      "plugins/acme/package.json",
      "plugins/acme/src/index.test.ts",
      "plugins/acme/src/index.ts",
      "plugins/acme/tsconfig.json",
    ]);
    const pkg = JSON.parse(files["plugins/acme/package.json"]!);
    expect(pkg.name).toBe("@loom/plugin-acme");
    expect(pkg.dependencies["@loom/event-runtime"]).toBe("workspace:*");
    // first-party references the workspace SPI packages
    expect(files["plugins/acme/tsconfig.json"]).toContain("../../packages/event-runtime");
  });

  it("scaffolds a third-party plugin as loom-plugin-* with peerDependencies + keyword", () => {
    const files = pluginFiles("store", "redis", { firstParty: false });
    const pkg = JSON.parse(files["loom-plugin-redis/package.json"]!);
    expect(pkg.name).toBe("loom-plugin-redis");
    expect(pkg.keywords).toContain("loom-plugin");
    expect(pkg.peerDependencies["@loom/snapshot-runtime"]).toBe("*");
    expect(pkg.dependencies).toBeUndefined();
  });

  it("derives a VALID camelCase preset identifier from a kebab-case name", () => {
    // regression: `${name}Storage` on a hyphenated name produced an invalid identifier.
    const index = pluginFiles("store", "acme-store", { firstParty: true })[
      "plugins/acme-store/src/index.ts"
    ]!;
    expect(index).toContain("export function acmeStoreStorage(");
    expect(index).not.toContain("acme-storeStorage");
  });

  it("emits the right preset/impl per seam", () => {
    expect(
      pluginFiles("dispatcher", "foo", { firstParty: false })["loom-plugin-foo/src/index.ts"]
    ).toContain("implements ExecutionDispatcher");
    expect(
      pluginFiles("telemetry", "foo", { firstParty: false })["loom-plugin-foo/src/index.ts"]
    ).toContain("TelemetryAdapter");
    expect(
      pluginFiles("middleware", "foo", { firstParty: false })["loom-plugin-foo/src/index.ts"]
    ).toContain("EffectMiddleware");
  });

  it("rejects an unknown seam", () => {
    expect(() => pluginFiles("nope", "x", { firstParty: true })).toThrow(/unknown seam/);
  });

  it("lists all seams", () => {
    expect(SEAM_KEYS).toEqual([
      "store",
      "dispatcher",
      "telemetry",
      "middleware",
      "timer",
      "projection",
      "worker",
      "llm",
      "authorizer",
    ]);
    const text = listSeams();
    for (const k of SEAM_KEYS) expect(text).toContain(k);
  });
});
