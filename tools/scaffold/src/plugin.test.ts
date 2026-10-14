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
      "lease",
      "content",
      "durable-state",
      "read-model",
      "keystore",
      "memory",
      "projection",
      "worker",
      "llm",
      "authorizer",
      "execution-authorizer",
      "resume-authenticator",
      "timer-dispatcher",
      "policy",
    ]);
    const text = listSeams();
    for (const k of SEAM_KEYS) expect(text).toContain(k);
  });

  it("scaffolds a policy plugin wired to the conformance kit", () => {
    const files = pluginFiles("policy", "foo", { firstParty: false });
    const index = files["loom-plugin-foo/src/index.ts"]!;
    expect(index).toContain("implements Policy<A>");
    expect(index).toContain("propensity");
    expect(files["loom-plugin-foo/src/index.test.ts"]).toContain("runPolicyConformance");
    expect(files["loom-plugin-foo/package.json"]).toContain("@loom/learning");
  });

  it("scaffolds a memory plugin wired to the conformance kit", () => {
    const files = pluginFiles("memory", "foo", { firstParty: false });
    const index = files["loom-plugin-foo/src/index.ts"]!;
    expect(index).toContain("implements MemoryStore");
    expect(files["loom-plugin-foo/src/index.test.ts"]).toContain("runMemoryStoreConformance");
    expect(files["loom-plugin-foo/package.json"]).toContain("@loom/memory");
  });

  it("scaffolds the lease store's OPTIONAL batch methods as prose, and passes no spiVersion", () => {
    // A 2.1.0-shaped store (no batch methods) must pass the kit with no options, and a generated
    // throwing stub would advertise batch support the store lacks.
    const files = pluginFiles("lease", "foo", { firstParty: false });
    const index = files["loom-plugin-foo/src/index.ts"]!;
    const body = index.slice(index.indexOf("export class"));
    for (const m of ["acquireMany", "renewMany", "releaseMany"]) {
      expect(index, `${m} must be explained`).toContain(m);
      expect(body, `${m} must not be emitted as a member`).not.toContain(`${m}(`);
    }
    expect(files["loom-plugin-foo/src/index.test.ts"]).not.toContain("spiVersion");
  });

  it("scaffolds memory's OPTIONAL methods as prose, never as throwing stubs", () => {
    // The runtime tests for `replace`/`search`/`close` and falls back when they are
    // absent, so presence IS the feature flag: a generated stub that throws would
    // advertise a capability the store does not have, and eviction would fail
    // instead of taking the fallback path.
    const index = pluginFiles("memory", "foo", { firstParty: false })[
      "loom-plugin-foo/src/index.ts"
    ]!;
    const body = index.slice(index.indexOf("export class"));
    for (const optional of ["replace", "search", "close"]) {
      expect(index, `${optional} must be explained`).toContain(optional);
      expect(body, `${optional} must not be emitted as a member`).not.toContain(`${optional}(`);
    }
    expect(index).toContain("PRESENCE IS THE FEATURE FLAG");
  });

  it("scaffolds the key store's OPTIONAL wasDestroyed as a comment, never a throwing member", () => {
    // Conformance skips a store without `wasDestroyed`; a generated member that throws would
    // fail it (and advertise a destruction proof the store cannot give).
    const index = pluginFiles("keystore", "foo", { firstParty: false })[
      "loom-plugin-foo/src/index.ts"
    ]!;
    const body = index.slice(index.indexOf("export class"));
    expect(body).toContain("// wasDestroyed(");
    expect(body.replace(/^\s*\/\/.*$/gm, "")).not.toContain("wasDestroyed");
  });

  it("emits an exports map an ESM consumer can enter", () => {
    // The scaffold used to mint `{ require, types }` — the exact shape that left 49
    // packages in loom itself unreachable from `import`. A generator that reproduces
    // a defect outlives every sweep of it.
    const pkg = JSON.parse(
      pluginFiles("memory", "foo", { firstParty: false })["loom-plugin-foo/package.json"] as string
    ) as { exports: Record<string, Record<string, string>> };
    const root = pkg.exports["."] as Record<string, string>;
    expect(Object.keys(root)).toEqual(["types", "require", "default"]);
  });

  it("tells a policy author it is NOT a defineConfig seam", () => {
    // Every other seam wires through the composition root; this one is consumed
    // from flow code. Saying "defineConfig" here would send authors looking for a
    // config key that does not exist.
    const text = listSeams();
    expect(text).toMatch(/policy[\s\S]*NOT defineConfig/);
    expect(text).toContain("decideWithPolicy(");
  });
});
