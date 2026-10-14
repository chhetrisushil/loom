import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Fitness function: every drive entry point leases (ADR 0130 D11, S7c) ──────
//
// A `WorkflowRuntime` run is started by exactly one private method, `execute`. The heartbeat lease
// must be taken BEFORE the fence and the first append, i.e. by the method that CALLS `execute`, and
// handed to it. A new path that drives without a lease would silently leave a `running` stream with
// no liveness evidence (the vacuous-check pattern: the poll would read "no lease" as nothing). This
// pin fails when `execute` gains a caller that does not take a lease, or one that does not pass it.

const SRC = resolve(__dirname, "../../workflow-runtime/src/WorkflowRuntime.ts");
const KNOWN_DRIVERS = [
  "restoreFromStateCore",
  "startCore",
  "resumeCore", // also the send/notify winner (`inboxWake`) and recovery / timer re-drives
  "resumeAsCore",
  "startSuccessorBody", // continue-as-new: the successor is leased before its EXECUTION_STARTED
].sort();

/** The method (declared at two-space indent) enclosing `index`, and its body text. */
function enclosingMethod(code: string, index: number): { name: string; body: string } {
  const head = code.slice(0, index);
  const re = /^ {2}(?:private |public |protected )?(?:async )?([A-Za-z$_][\w$]*)\s*[(<]/gm;
  let last: RegExpExecArray | null = null;
  for (let m = re.exec(head); m !== null; m = re.exec(head)) last = m;
  if (last === null) throw new Error("no enclosing method");
  const start = last.index;
  const next = code
    .slice(index)
    .search(
      /\n {2}(?:private |public |protected )?(?:async )?[A-Za-z$_][\w$]*\s*[(<][^\n]*\{\s*$/m
    );
  return {
    name: last[1] as string,
    body: code.slice(start, next === -1 ? code.length : index + next),
  };
}

function driversOf(code: string): Array<{ name: string; leases: boolean; passes: boolean }> {
  const out: Array<{ name: string; leases: boolean; passes: boolean }> = [];
  const re = /this\.execute\(/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    const { name, body } = enclosingMethod(code, m.index);
    // the call's argument list: up to the matching close paren
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
    }
    const call = code.slice(m.index, i);
    out.push({
      name,
      leases: /takeDriverLease\(|driverLeases\.acquire\(/.test(body),
      passes: /\blease\b|\bsuccLease\b/.test(call),
    });
  }
  return out;
}

describe("every WorkflowRuntime drive entry point takes a heartbeat lease", () => {
  const code = readFileSync(SRC, "utf8");
  it("the set of methods that call execute is the audited set", () => {
    const names = [...new Set(driversOf(code).map((d) => d.name))].sort();
    expect(names).toEqual(KNOWN_DRIVERS);
  });
  it("each takes the lease before running and hands it to execute", () => {
    for (const d of driversOf(code)) {
      expect(d.leases, `${d.name} calls execute without taking a driver lease`).toBe(true);
      expect(d.passes, `${d.name} does not pass its lease to execute`).toBe(true);
    }
  });
  it("the pin is not vacuous: a driver without a lease is detected", () => {
    const bad =
      "class X {\n  async sneaky(): Promise<void> {\n    this.execute(a, b);\n  }\n\n  private foo(): void {}\n}";
    const found = driversOf(bad);
    expect(found).toEqual([{ name: "sneaky", leases: false, passes: false }]);
  });
});
