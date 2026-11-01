import { describe, expect, it } from "vitest";
import { SEAM_KEYS, joinNoun, listSeams, pluginFiles, pluginNextSteps } from "./plugin";

describe("pluginFiles", () => {
  it("scaffolds a first-party store plugin under plugins/ with the @loom/plugin- name", () => {
    const files = pluginFiles("store", "acme", { firstParty: true });
    expect(Object.keys(files).sort()).toEqual([
      "plugins/acme/README.md",
      "plugins/acme/package.json",
      "plugins/acme/src/index.test.ts",
      "plugins/acme/src/index.ts",
      "plugins/acme/tsconfig.json",
      "plugins/acme/tsconfig.test.json",
      "plugins/acme/vitest.config.ts",
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
      "sandbox",
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

  it("scaffolds a sandbox backend wired to the kit, with the remote-backend checklist (ADR 0144 D6)", () => {
    for (const firstParty of [false, true]) {
      const files = pluginFiles("sandbox", "my-box", { firstParty });
      const dir = firstParty ? "plugins/my-box" : "loom-plugin-my-box";
      const index = files[`${dir}/src/index.ts`] as string;
      const test = files[`${dir}/src/index.test.ts`] as string;
      const readme = files[`${dir}/README.md`] as string;
      const pkg = JSON.parse(files[`${dir}/package.json`] as string) as Record<string, unknown>;
      expect(index).toContain("class MyBoxSandboxBackend implements SandboxBackend");
      // The most conservative honest claims: the worst case, every stronger value to be earned.
      expect(index).toMatch(
        /network: "open"[\s\S]*wallClock: "soft"[\s\S]*memory: false[\s\S]*cpu: false[\s\S]*freshPerRun: false/
      );
      expect(index).not.toMatch(/network: "none"|freshPerRun: true/);
      expect(index).toContain("EARNED");
      expect(readme).toMatch(/memory: false.*cpu: false.*exhaust the host/s);
      expect(test).toContain("runSandboxBackendConformance(");
      expect(JSON.stringify(pkg)).toContain("@loom/sandbox");
      // Registered from flow code: the README must not invent a defineConfig key.
      expect(readme).toContain("registerSandboxBackend");
      expect(readme).not.toContain("@loom/app");
      for (const item of [
        "No service account",
        "Egress denied",
        "One request per instance",
        "hard kill",
        "Memory and CPU caps",
        "No shared writable state",
      ]) {
        expect(readme, item).toContain(item);
      }
    }
    expect(listSeams()).toMatch(/sandbox[\s\S]*NOT defineConfig/);
  });

  it("does not repeat the seam's noun in a class name (sandbox: CloudrunSandboxBackend)", () => {
    const index = pluginFiles("sandbox", "cloudrun-sandbox", { firstParty: false })[
      "loom-plugin-cloudrun-sandbox/src/index.ts"
    ]!;
    expect(index).toContain("export class CloudrunSandboxBackend implements SandboxBackend");
    expect(index).toContain("export interface CloudrunSandboxBackendOptions");
    expect(index).not.toContain("SandboxSandbox");
    // A name that does not end in the noun is unchanged.
    expect(
      pluginFiles("sandbox", "my-box", { firstParty: false })["loom-plugin-my-box/src/index.ts"]
    ).toContain("class MyBoxSandboxBackend ");
    // The README and the test agree with the class.
    const files = pluginFiles("sandbox", "cloudrun-sandbox", { firstParty: false });
    expect(files["loom-plugin-cloudrun-sandbox/README.md"]).toContain(
      "new CloudrunSandboxBackend("
    );
    expect(files["loom-plugin-cloudrun-sandbox/src/index.test.ts"]).toContain(
      "new CloudrunSandboxBackend()"
    );
  });

  it("does not repeat the noun for another seam either (lease: foo-lease-store)", () => {
    const index = pluginFiles("lease", "foo-lease-store", { firstParty: false })[
      "loom-plugin-foo-lease-store/src/index.ts"
    ]!;
    expect(index).toContain("export class FooLeaseStore implements LeaseStore");
    expect(index).not.toContain("LeaseStoreLeaseStore");
    expect(joinNoun("FooTimer", "TimerStore")).toBe("FooTimerStore");
    expect(joinNoun("Foo", "TimerStore")).toBe("FooTimerStore");
    expect(joinNoun("fooTelemetry", "Telemetry")).toBe("fooTelemetry");
    expect(joinNoun("acmeStore", "Storage")).toBe("acmeStoreStorage");
  });

  it("no seam's description repeats its seam word back-to-back", () => {
    for (const seam of SEAM_KEYS) {
      for (const firstParty of [false, true]) {
        const files = pluginFiles(seam, "probe", { firstParty });
        const dir = firstParty ? "plugins/probe" : "loom-plugin-probe";
        const description = (JSON.parse(files[`${dir}/package.json`]!) as { description: string })
          .description;
        const readmeIntro = files[`${dir}/README.md`]!.split("\n")[2]!.replace(/\*\*/g, "");
        for (const text of [description, readmeIntro]) {
          expect(text, `${seam}: ${text}`).not.toMatch(/\b(\w+)[\s-]+\1\b/i);
        }
        expect(description, seam).not.toMatch(/\bsandbox plugin — Sandbox/i);
      }
    }
    const desc = JSON.parse(
      pluginFiles("sandbox", "x", { firstParty: false })["loom-plugin-x/package.json"]!
    ).description as string;
    expect(desc.startsWith("A Loom plugin — Sandbox backend")).toBe(true);
  });

  it("every seam ships a vitest config, @types/node and (third-party) engines + files", () => {
    for (const seam of SEAM_KEYS) {
      const tp = pluginFiles(seam, "probe", { firstParty: false });
      const pkg = JSON.parse(tp["loom-plugin-probe/package.json"]!);
      expect(tp["loom-plugin-probe/vitest.config.ts"], seam).toContain('from "vitest/config"');
      expect(pkg.devDependencies["@types/node"], seam).toBeDefined();
      expect(pkg.engines.node, seam).toBeDefined();
      expect(pkg.files, seam).toEqual(["dist"]);
      const fp = pluginFiles(seam, "probe", { firstParty: true });
      const fpkg = JSON.parse(fp["plugins/probe/package.json"]!);
      expect(fp["plugins/probe/vitest.config.ts"], seam).toBe(
        'import { loomTest } from "../../vitest.shared";\n\nexport default loomTest();\n'
      );
      expect(fpkg.devDependencies["@types/node"], seam).toBeDefined();
      expect(fpkg.scripts["typecheck:tests"], seam).toBe("tsc -p tsconfig.test.json");
      expect(fp["plugins/probe/tsconfig.test.json"], seam).toBeDefined();
    }
  });

  it("the sandbox stub explains non-JS fixtures and the shape of a remote evaluate (as comments)", () => {
    const files = pluginFiles("sandbox", "x", { firstParty: false });
    const index = files["loom-plugin-x/src/index.ts"]!;
    const live = index.replace(/^\s*\/\/.*$/gm, "");
    expect(index).toMatch(/\/\/.*fixtures[\s\S]*language: "javascript"/);
    expect(index).toContain("JAVASCRIPT_FIXTURES");
    expect(index).toContain("signal: request.signal");
    expect(index).toContain("never the response body");
    expect(index).toContain('kind: "infrastructure"');
    expect(live).not.toContain("fetch(");
    const test = files["loom-plugin-x/src/index.test.ts"]!;
    expect(test).toContain("fixtures");
    expect(test).toContain("JAVASCRIPT_FIXTURES");
    expect(test).toContain("timeoutMs");
    expect(files["loom-plugin-x/README.md"]).toContain("timeoutMs");
    expect(files["loom-plugin-x/README.md"]).toContain("300_000");
  });
});

describe("pluginNextSteps", () => {
  it("is truthful per seam: says un-comment only where the conformance test is commented out", () => {
    for (const seam of SEAM_KEYS) {
      const files = pluginFiles(seam, "probe", { firstParty: false });
      const test = files["loom-plugin-probe/src/index.test.ts"]!;
      const live = /^(?!\s*\/\/).*\brun\w+Conformance\(/m.test(test);
      const text = pluginNextSteps(files, { firstParty: false, root: "r" }).join("\n");
      expect(/un-comment/.test(text), `${seam}: ${text}`).toBe(!live);
    }
    const sandbox = pluginNextSteps(pluginFiles("sandbox", "x", { firstParty: false }), {
      firstParty: false,
      root: "r",
    }).join("\n");
    expect(sandbox).not.toContain("un-comment");
    expect(sandbox).toContain("already wired");
  });

  it("names the @loom/* packages a third-party plugin needs overridden, and not for first-party", () => {
    const tp = pluginNextSteps(pluginFiles("sandbox", "x", { firstParty: false }), {
      firstParty: false,
      root: "r",
    }).join("\n");
    expect(tp).toMatch(/depends on: .*@loom\/conformance.*@loom\/sandbox/);
    expect(tp).toContain("override");
    expect(tp).toContain("link:");
    const fp = pluginNextSteps(pluginFiles("sandbox", "x", { firstParty: true }), {
      firstParty: true,
      root: "r",
    }).join("\n");
    expect(fp).not.toContain("override");
  });
});
