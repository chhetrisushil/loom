import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UserConfig } from "vitest/config";
import { defineConfig } from "vitest/config";

// ── One test config for the workspace ────────────────────────────────────────
//
// Sixty-three `vitest.config.ts` files, thirty-four byte-identical. Each package
// keeps its own (turbo runs `vitest run` per package, so the file has to exist),
// but the CONTENT lives here — which also means a change like the source-alias
// below is one edit rather than sixty-three.

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Map every workspace package name to its `src/index.ts`.
 *
 * WHY THIS IS OPT-IN. By default a package's tests import its siblings' built
 * `dist`, which is what a consumer gets — so that is what CI must test. The cost
 * lands on the inner loop: edit a dependency's source and the dependent's tests
 * do not see it until you rebuild, while the sourcemaps still point at `src`
 * with pre-edit line numbers, so the failure reads as a mystery rather than a
 * stale build.
 *
 * `LOOM_TEST_SRC=1 pnpm test` (or `pnpm test:src`) resolves siblings to source
 * instead: immediate feedback, at the price of no longer testing the published
 * shape. Deliberately not the default — the two answers differ, and CI wants the
 * one that ships.
 */
function sourceAliases(): { find: RegExp; replacement: string }[] {
  const out: { find: RegExp; replacement: string }[] = [];
  for (const tier of ["packages", "plugins", "tools"]) {
    const dir = join(ROOT, tier);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const manifest = join(dir, entry, "package.json");
      const index = join(dir, entry, "src", "index.ts");
      if (!existsSync(manifest) || !existsSync(index)) continue;
      const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (name === undefined) continue;
      out.push({ find: new RegExp(`^${name.replace(/[/\\-]/g, "\\$&")}$`), replacement: index });
    }
  }
  return out;
}

const useSource = process.env.LOOM_TEST_SRC === "1";

/** The shared base. Pass overrides for the few packages that need them. */
export function loomTest(overrides: UserConfig = {}): UserConfig {
  const { test: testOverrides, resolve: resolveOverrides, ...rest } = overrides;
  return defineConfig({
    ...rest,
    resolve: {
      // CJS-built workspace packages: prefer `require`, so vitest loads the same
      // entrypoint Node would.
      conditions: ["require", "default"],
      ...(useSource && { alias: sourceAliases() }),
      ...resolveOverrides,
    },
    test: { environment: "node", ...testOverrides },
  }) as UserConfig;
}
