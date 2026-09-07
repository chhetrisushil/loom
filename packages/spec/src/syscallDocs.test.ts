import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { KERNEL_SYSCALLS } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";

// ── Fitness function: a doc that enumerates the syscall surface must enumerate it ──
//
// `architecture.md` carried two diagrams naming seven of the ten syscalls — `sleepUntil`,
// `stream` and `ui` had been added to the ABI and never to the picture — while the kernel
// specification, two directories away, listed all ten. It is the same shape as the CLI
// guide's `kernel-manifest` sample output, which had drifted to a version of the manifest
// that predates the memory SPI being versioned: a doc reproducing a versioned constant,
// with nothing checking that it still matches the constant.
//
// The heuristic is the whole design. A BLOCK (blank-line separated, so a mermaid diagram
// counts as one) that names ENOUGH syscalls is enumerating the surface — nobody mentions
// six of them in passing — and must therefore name all of them. Prose that discusses two or
// three syscalls is untouched, which is what keeps this from becoming a tax on writing.

const REPO_ROOT = resolve(__dirname, "../../..");
/** Naming this many in one block is an enumeration, not a discussion. */
const ENUMERATION_THRESHOLD = 6;

/** Docs are reviewed prose; ADRs and requirements are dated records of what was true then. */
const SKIP_DIRS = new Set(["adr", "requirements", "node_modules", "spec"]);

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...markdownFiles(full));
    } else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * The syscall NAMES. `KERNEL_SYSCALLS` is a list of records (`name`/`kind`/`since`/`summary`),
 * and the first cut of this file interpolated the records themselves — every pattern became
 * `\b[object Object]\b`, matched nothing, and the suite passed while checking nothing. It was
 * caught by removing a syscall from a diagram and watching the test stay green, which is the
 * only way this class of bug ever announces itself.
 */
const SYSCALL_NAMES: string[] = KERNEL_SYSCALLS.map((call) => call.name);

/** Every syscall named in a block, counted once each. */
function named(block: string): string[] {
  return SYSCALL_NAMES.filter((call) => new RegExp(`\\b${call}\\b`).test(block));
}

describe("syscall enumerations in docs match KERNEL_SYSCALLS", () => {
  const files = markdownFiles(resolve(REPO_ROOT, "docs"));

  it("finds docs to check (the sweep itself can't silently match nothing)", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(SYSCALL_NAMES.length).toBeGreaterThan(5);
    // The projection itself must be real — see SYSCALL_NAMES for why this line exists.
    expect(SYSCALL_NAMES.every((n) => typeof n === "string" && n.length > 0)).toBe(true);
  });

  it("a block naming most of the syscalls names all of them", () => {
    const incomplete: string[] = [];
    for (const file of files) {
      for (const block of readFileSync(file, "utf8").split(/\n\s*\n/)) {
        const found = named(block);
        if (found.length < ENUMERATION_THRESHOLD || found.length === SYSCALL_NAMES.length) {
          continue;
        }
        const missing = SYSCALL_NAMES.filter((c) => !found.includes(c));
        incomplete.push(
          `${relative(REPO_ROOT, file)}: names ${found.length}/${SYSCALL_NAMES.length}, missing ${missing.join(", ")}`
        );
      }
    }
    expect(incomplete, `incomplete syscall enumeration(s):\n  ${incomplete.join("\n  ")}`).toEqual(
      []
    );
  });
});
