import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SEAM_KEYS } from "./plugin";

// ── Fitness function: the cheatsheets enumerate, so they rot fastest ─────────
//
// A reference card is the densest list of names in the repo — syscalls, seams, commands —
// and nothing about it fails when one of those names changes. That is precisely the shape
// this repo keeps finding stale: `docs/plugins.md` had a seam list that drifted, ADR 0033
// had one that was five behind, `usage-cli.md` had one nobody checked.
//
// So the cards are checked against the things they claim to enumerate. Prose is left alone.

const REPO_ROOT = resolve(__dirname, "../../..");
const card = (rel: string) => readFileSync(resolve(REPO_ROOT, "docs", rel), "utf8");

const FEATURES = "cheatsheet-features.md";
const DX = "cheatsheet-dx.md";

describe("cheatsheets stay true to what they enumerate", () => {
  // Read from SOURCE rather than imported: this is a text-against-text check, and importing
  // the runtime here would make the scaffold package depend on it just to read two strings.
  const source = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

  it("Card I lists every kernel syscall", () => {
    const abi = source("packages/workflow-runtime/src/abi.ts");
    const block = abi.slice(abi.indexOf("KERNEL_SYSCALLS"));
    const syscalls = [...block.matchAll(/name:\s*"(\w+)"/g)].map((m) => m[1] as string);
    expect(syscalls.length, "the sweep itself must not match nothing").toBeGreaterThan(5);
    const text = card(FEATURES);
    const missing = syscalls.filter((n) => !text.includes(`ctx.${n}`));
    expect(missing, `the kernel has syscalls Card I never names: ${missing.join(", ")}`).toEqual(
      []
    );
  });

  it("Card I names the CURRENT kernel versions", () => {
    const abiVersion = /KERNEL_ABI_VERSION = "([\d.]+)"/.exec(
      source("packages/workflow-runtime/src/abi.ts")
    )?.[1];
    const schema = /EVENT_SCHEMA_VERSION = "([\d.]+)"/.exec(
      source("packages/replay-vm/src/eventHandlers.ts")
    )?.[1];
    expect(abiVersion).toBeDefined();
    expect(schema).toBeDefined();
    const text = card(FEATURES);
    expect(text, `ABI is ${abiVersion}`).toContain(`**${abiVersion}**`);
    expect(text, `event schema is ${schema}`).toContain(`**${schema}**`);
  });

  it("Card II lists every scaffoldable seam, and claims the right count", () => {
    const text = card(DX);
    const missing = SEAM_KEYS.filter((k) => !text.includes(`\`${k}\``));
    expect(missing, `${DX} omits seams: ${missing.join(", ")}`).toEqual([]);
    expect(text, "the headline seam count").toContain(`**${SEAM_KEYS.length}** plugin seams`);
  });

  it("Card II names every top-level CLI command", () => {
    // The usage text is the authoritative list — it is itself guarded against the code.
    const usage = readFileSync(resolve(REPO_ROOT, "docs/usage-cli.md"), "utf8");
    const commands = new Set(
      [...usage.matchAll(/^ {2}loom ([a-z-]+)/gm)].map((m) => m[1] as string)
    );
    expect(commands.size).toBeGreaterThan(15);
    const text = card(DX);
    // `gen`/`new` are shown in a shell block rather than a table, so match the word anywhere.
    const missing = [...commands].filter((c) => !text.includes(`loom ${c}`));
    expect(missing, `${DX} never mentions: ${missing.join(", ")}`).toEqual([]);
  });

  it("every conformance kit the repo ships is reachable from Card II's count", () => {
    const kits = execSync(
      'grep -c "export function run.*Conformance" packages/conformance/src/index.ts',
      { cwd: REPO_ROOT, encoding: "utf8" }
    ).trim();
    expect(card(DX)).toContain(`**${kits}** conformance kits`);
  });
});
