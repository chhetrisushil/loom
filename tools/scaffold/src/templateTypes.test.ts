import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SEAM_KEYS, pluginFiles } from "./plugin";

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

/** `@loom/x` → its built declaration file, wherever that package lives. */
function loomPaths(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const base of ["packages", "plugins", "tools"]) {
    for (const name of readdirSync(join(REPO_ROOT, base), { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      out[`@loom/${name.name}`] = [`${base}/${name.name}/dist/index.d.ts`];
    }
  }
  return out;
}

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
          types: [],
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
