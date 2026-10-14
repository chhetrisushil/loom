import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EVENT_KIND_CLASS } from "@loom/event-runtime";
import { knownEventTypes } from "@loom/replay-vm";
import { describe, expect, it } from "vitest";

// W2-0 fitness (Wave 2 design §3): the fold's handler table, the type-level kind list and the
// answering/ignorable classification are ONE set, and every handler that has no writer in the
// source tree is listed here with the item whose PR adds the writer. An item PR that adds a
// writer MUST delete its row (the "is stale" case below fails otherwise); a new handler with
// no writer and no row fails the first case.

/** Handlers that exist before their writer: kind → where the writer lands. */
const RESERVED_NO_WRITER: Record<string, string> = {
  // Pre-existing exceptions (design §3, §7 question 12): reserved long before Wave 2.
  PARALLEL_STARTED: "none (reserved with a handler since before Wave 2)",
  STEP_RETRYING: "none (reserved with a handler since before Wave 2)",
  // ADR 0130 residuals S1 (EVENT_SCHEMA 1.25.0): the shapes are frozen and the handlers present; the
  // writers (quarantineInbox / releaseInbox / auto-release) land in slice S5.
  INBOX_QUARANTINED: "ADR 0130 residuals S5 (quarantineInbox)",
  INBOX_RELEASED: "ADR 0130 residuals S5 (releaseInbox, auto-release)",
};

const ROOT = join(__dirname, "..", "..", "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

function allSources(): string[] {
  const out: string[] = [];
  for (const group of ["packages", "plugins", "tools"]) {
    for (const pkg of readdirSync(join(ROOT, group))) {
      try {
        sources(join(ROOT, group, pkg, "src"), out);
      } catch {
        // no src
      }
    }
  }
  return out;
}

/** A WRITE of `kind`: the literal in an envelope, a commit/emit/append call, or a lifecycle fact. */
function writerPattern(kind: string): RegExp {
  return new RegExp(
    `(?:eventType:\\s*|commit\\(\\s*|emit\\(\\s*|append\\(\\s*|emitLifecycleFact\\(\\s*)"${kind}"`
  );
}

describe("event kinds: handlers, type list, classification, writers", () => {
  it("the fold's handler table equals the classification map (itself `Record<EventKind, …>`, so equal to KERNEL_EVENT_KINDS by tsc)", () => {
    expect(Object.keys(EVENT_KIND_CLASS).sort()).toEqual(knownEventTypes());
  });

  it("every handler without a writer is listed as reserved, and nothing else is", () => {
    const text = allSources().map((f) => readFileSync(f, "utf8"));
    const writerless = knownEventTypes().filter((k) => {
      const re = writerPattern(k);
      return !text.some((t) => re.test(t));
    });
    expect(writerless.sort()).toEqual(Object.keys(RESERVED_NO_WRITER).sort());
  });
});

// P2-2 (W2-0 review): `EXECUTION_CONTINUED` is a terminal fact. A consumer keyed on the terminal
// EVENT KIND (not on the folded status) that lists the other terminals and forgets this one
// leaks per-execution state forever. Any literal array / Set that names BOTH
// EXECUTION_COMPLETED and EXECUTION_FAILED is a terminal-kind set and must name
// EXECUTION_CONTINUED, unless it is allowlisted with the reason it must not.

/** `file suffix` -> why the set deliberately omits EXECUTION_CONTINUED. */
const TERMINAL_SET_EXCEPTIONS: Record<string, string> = {
  "packages/orchestration/src/orchestration.ts":
    "ChildResult settlement: a continued child is `look at the head` (ADR 0109 D6), never a result; following `_continuedTo` is R1b's",
};

describe("terminal-kind sets", () => {
  it("every literal set naming EXECUTION_COMPLETED and EXECUTION_FAILED also names EXECUTION_CONTINUED (or is allowlisted)", () => {
    const offenders: string[] = [];
    const used = new Set<string>();
    for (const file of allSources()) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\[[^[\]]*\]/g)) {
        const body = m[0];
        if (!body.includes('"EXECUTION_COMPLETED"') || !body.includes('"EXECUTION_FAILED"')) {
          continue;
        }
        if (body.includes('"EXECUTION_CONTINUED"')) continue;
        const rel = file.slice(ROOT.length + 1);
        if (Object.hasOwn(TERMINAL_SET_EXCEPTIONS, rel)) {
          used.add(rel);
          continue;
        }
        offenders.push(`${rel}: ${body.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
    // an allowlist row that no longer matches anything is stale
    expect([...used].sort()).toEqual(Object.keys(TERMINAL_SET_EXCEPTIONS).sort());
  });
});
