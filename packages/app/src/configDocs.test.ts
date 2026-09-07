import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GROUPED_OPTIONS } from "./defineConfig";

// ── Fitness function: the config reference can't document an option that throws ──
//
// `docs/usage.md` — the public "building an app" guide — listed nine options in its
// `LoomConfig` table that `defineConfig` REFUSES: `effectMiddleware`, `authorizer`,
// `policies`, `validate`, `dispatcher`, `onEvent`, `secrets`, `retention`, `compliance`.
// They moved into groups, the flat spellings throw with no deprecation window, and the
// table was never updated — so the first thing a reader copies out of it fails at boot.
//
// The sweep that moved everything else looked at CODE BLOCKS, and every one of those was
// clean. This one was a prose table, which is exactly the surface a code sweep cannot see
// and a reader trusts most.
//
// It reads `GROUPED_OPTIONS` — the same table `normalizeConfig` throws from — so a future
// regrouping updates the doc requirement automatically instead of leaving a second copy.

const REPO_ROOT = resolve(__dirname, "../../..");
const USAGE = "docs/usage.md";
const GUIDE = "docs/user-guide.md";

/**
 * The `LoomApp` members the user guide's §9 reference block declares.
 *
 * That block had drifted the other way from the usage table: it was CORRECT about every
 * option and silently missing six members — `tools`, `skills`, `schedules`, `memory`,
 * `knowledge` and `verify`. An interface reference that omits `app.memory` is not slightly
 * incomplete, it is the reason a reader concludes the surface does not exist.
 */
function documentedAppMembers(): string[] {
  const doc = readFileSync(resolve(REPO_ROOT, GUIDE), "utf8");
  const start = doc.indexOf("interface LoomApp");
  const block = doc.slice(start, doc.indexOf("\n}", start));
  return [...block.matchAll(/^ {2}([a-zA-Z]+)[?(:]/gm)].map((m) => m[1] as string);
}

/** The real members, read off the built declaration rather than a copy of it. */
function realAppMembers(): string[] {
  const dts = readFileSync(resolve(REPO_ROOT, "packages/app/dist/defineConfig.d.ts"), "utf8");
  const start = dts.indexOf("interface LoomApp");
  let depth = 0;
  let end = start;
  for (let i = dts.indexOf("{", start); i < dts.length; i++) {
    if (dts[i] === "{") depth++;
    else if (dts[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  return [...dts.slice(start, end).matchAll(/^ {4}([a-zA-Z]+)[?(:]/gm)].map((m) => m[1] as string);
}

/** The first-column keys of the `LoomConfig` reference table in Step 3. */
function documentedKeys(): string[] {
  const doc = readFileSync(resolve(REPO_ROOT, USAGE), "utf8");
  const section = doc.slice(doc.indexOf("## Step 3"), doc.indexOf("## Step 4"));
  const keys: string[] = [];
  for (const line of section.split("\n")) {
    if (!line.startsWith("| `")) continue;
    // A row may name several related options: "| `flows` / `flowModules` | …".
    const cell = line.slice(1, line.indexOf("|", 1));
    for (const m of cell.matchAll(/`([a-zA-Z.]+)`/g)) keys.push(m[1] as string);
  }
  return keys;
}

describe("the usage guide's config table matches defineConfig", () => {
  const documented = documentedKeys();
  const moved = new Map<string, string>();
  for (const [group, options] of GROUPED_OPTIONS) {
    for (const option of options) moved.set(option, `${group}.${option}`);
  }

  it("finds the table (the sweep itself can't silently match nothing)", () => {
    expect(documented.length).toBeGreaterThan(10);
    expect(moved.size).toBeGreaterThan(10);
  });

  it("documents no option that defineConfig would throw on", () => {
    const throwing = documented
      .filter((key) => moved.has(key))
      .map((key) => `${key} → ${moved.get(key)}`);
    expect(
      throwing,
      `${USAGE} documents flat option(s) that defineConfig REFUSES:\n  ${throwing.join("\n  ")}`
    ).toEqual([]);
  });

  it("the user guide's LoomApp block names every member the app actually has", () => {
    // Requires `pnpm build` — it reads the emitted declaration, which is the point: the
    // doc is checked against what ships, not against the source it was written beside.
    const real = realAppMembers();
    const documented = new Set(documentedAppMembers());
    expect(real.length).toBeGreaterThan(8);
    const missing = real.filter((m) => !documented.has(m));
    expect(missing, `${GUIDE}'s LoomApp block omits: ${missing.join(", ")}`).toEqual([]);
  });

  it("documents every group, so a new namespace cannot ship unmentioned", () => {
    const groups = GROUPED_OPTIONS.map(([group]) => group);
    const doc = readFileSync(resolve(REPO_ROOT, USAGE), "utf8");
    expect(groups.filter((g) => !doc.includes(`\`${g}\``))).toEqual([]);
  });
});
