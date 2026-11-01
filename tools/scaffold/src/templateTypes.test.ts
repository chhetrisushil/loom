import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SEAM_KEYS, pluginFiles, usesNodeGlobals } from "./plugin";

// ── Fitness function: a template must implement the SPI it claims ────────────
//
// Every seam emits a class saying `implements SomeSpi`, and nothing checked that it does.
// The scaffold is a GENERATOR: when an SPI gains a method or changes a signature, every
// existing plugin fails to compile loudly — and the template keeps emitting the old shape
// silently, handing the next author code that cannot work. A generator that outlives the
// sweep is the whole reason to test generators rather than only their output.
//
// One `tsc` over all twelve seams at once, against the packages' real .d.ts.

const REPO_ROOT = resolve(__dirname, "../../..");
const PROBE = join(REPO_ROOT, ".tmp-template-types");

/**
 * Every workspace package → its built declaration file.
 *
 * Keyed by the package's declared NAME, not its directory: `plugins/content` publishes
 * `@loom/plugin-content`, and assuming the two match silently omits exactly the seams whose
 * SPI lives in a plugin package.
 */
function loomPaths(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const base of ["packages", "plugins", "tools"]) {
    for (const entry of readdirSync(join(REPO_ROOT, base), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(REPO_ROOT, base, entry.name, "package.json");
      if (!existsSync(manifest)) continue;
      const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (name === undefined) continue;
      out[name] = [`${base}/${entry.name}/dist/index.d.ts`];
    }
  }
  return out;
}

/** `@types/node` is not hoisted to the root here, so point tsc at wherever pnpm put it. */
function nodeTypeRoot(): string {
  const pkg = require.resolve("@types/node/package.json", {
    paths: [join(REPO_ROOT, "tools/scaffold")],
  });
  // typeRoots entries CONTAIN type packages, so this is the @types directory itself.
  return resolve(pkg, "../..");
}

describe("a scaffolded package declares what its own code needs", () => {
  // The typecheck below supplies node's ambient types to every seam, which is what hid this:
  // `loom plugin new keystore` emitted a class with `Buffer` in four signatures and a
  // package.json with no @types/node, so the package it produced did not compile. A probe
  // that hands the compiler more than the real package declares cannot see that.
  it("the detector reads CODE, not prose", () => {
    // Two seams describe "the process" in a doc comment. Matching those would add a
    // dependency their code never uses — a sweep over comments measures prose.
    expect(usesNodeGlobals("const b = Buffer.from(x);")).toBe(true);
    expect(usesNodeGlobals("/** a resume arrives from OUTSIDE the process */")).toBe(false);
    expect(usesNodeGlobals("// whichever process happens to poll")).toBe(false);
    expect(usesNodeGlobals("export class X {}")).toBe(false);
  });

  it("a template using node globals ships @types/node", () => {
    const missing: string[] = [];
    for (const seam of SEAM_KEYS) {
      const files = pluginFiles(seam, `probe-${seam}`, { firstParty: false });
      const indexKey = Object.keys(files).find((f) => f.endsWith("src/index.ts")) as string;
      if (!usesNodeGlobals(files[indexKey] ?? "")) continue;
      const manifestKey = Object.keys(files).find((f) => f.endsWith("package.json")) as string;
      const manifest = JSON.parse(files[manifestKey] ?? "{}") as {
        devDependencies?: Record<string, string>;
      };
      if (manifest.devDependencies?.["@types/node"] === undefined) missing.push(seam);
    }
    expect(
      missing,
      `these seams emit node globals and scaffold a package that cannot compile: ${missing.join(", ")}`
    ).toEqual([]);
  });
});

describe("a scaffolded package declares exactly the @loom/* packages its source imports", () => {
  /** Peer dependencies a seam declares without importing them in src/index.ts (none today). */
  const JUSTIFIED_UNIMPORTED: Record<string, string[]> = {};

  /** `@loom/*` module specifiers in non-comment import/export-from statements. */
  function importedLoom(source: string): string[] {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const out = new Set<string>();
    for (const m of code.matchAll(/from\s+"(@loom\/[a-z0-9-]+)(?:\/[^"]*)?"/g))
      out.add(m[1] as string);
    return [...out];
  }

  it("peerDependencies cover every @loom import, and carry nothing unimported", () => {
    for (const seam of SEAM_KEYS) {
      const files = pluginFiles(seam, "probe", { firstParty: false });
      const src = files["loom-plugin-probe/src/index.ts"] as string;
      const pkg = JSON.parse(files["loom-plugin-probe/package.json"] as string) as {
        peerDependencies: Record<string, string>;
      };
      const peers = Object.keys(pkg.peerDependencies);
      const imported = importedLoom(src);
      expect(peers, `${seam}: imported but not a peer`).toEqual(expect.arrayContaining(imported));
      const extra = peers.filter(
        (p) => !imported.includes(p) && !(JUSTIFIED_UNIMPORTED[seam] ?? []).includes(p)
      );
      expect(extra, `${seam}: peer dependencies nothing imports`).toEqual([]);
      // the sandbox backend never touches @loom/core
      if (seam === "sandbox") expect(peers).not.toContain("@loom/core");
      // first-party tsconfig references follow the same list
      const fp = pluginFiles(seam, "probe", { firstParty: true })[
        "plugins/probe/tsconfig.json"
      ] as string;
      for (const i of imported) {
        expect(fp, `${seam}: ${i}`).toContain(`../../packages/${i.replace("@loom/", "")}`);
      }
    }
  });
});

describe("seam templates typecheck against the real SPIs", () => {
  afterAll(() => rmSync(PROBE, { recursive: true, force: true }));

  it("every seam's generated source compiles", () => {
    rmSync(PROBE, { recursive: true, force: true });
    mkdirSync(join(PROBE, "src"), { recursive: true });

    for (const seam of SEAM_KEYS) {
      const files = pluginFiles(seam, `probe-${seam}`, { firstParty: false });
      const key = Object.keys(files).find((f) => f.endsWith("src/index.ts"));
      expect(key, `${seam} emits no src/index.ts`).toBeDefined();
      writeFileSync(join(PROBE, "src", `${seam}.ts`), files[key as string] ?? "");
    }

    writeFileSync(
      join(PROBE, "tsconfig.json"),
      JSON.stringify({
        extends: "../tsconfig.base.json",
        compilerOptions: {
          noEmit: true,
          rootDir: "src",
          // `Buffer` appears in the KeyStore SPI, so the probe needs node's ambient types.
          types: ["node"],
          typeRoots: [nodeTypeRoot()],
          baseUrl: "..",
          paths: loomPaths(),
        },
        include: ["src/**/*"],
      })
    );

    try {
      execFileSync("npx", ["tsc", "--noEmit", "-p", join(PROBE, "tsconfig.json")], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (err) {
      const out = String((err as { stdout?: string }).stdout ?? err);
      // Report the template's own errors: "a seam is broken" without saying which one and
      // where sends the reader back to a blank screen.
      expect.fail(`seam templates do not typecheck against the built SPIs:\n${out}`);
    }
  }, 120_000);
});
