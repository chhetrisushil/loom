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
  EXECUTION_CONTINUED: "R1b (ADR 0109): ctx.continueAsNew",
  MESSAGE_CONSUMED: "R2 (ADR 0110): ctx.receive / ctx.select, runtime.send",
  PARALLEL_COMPLETED: "R6 (ADR 0112): the fail-fast scope outcome",
  // Pre-existing exceptions (design §3, §7 question 12): reserved long before Wave 2.
  PARALLEL_STARTED: "none (reserved with a handler since before Wave 2)",
  STEP_RETRYING: "none (reserved with a handler since before Wave 2)",
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
