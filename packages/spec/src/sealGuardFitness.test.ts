import { type Dirent, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ── Fitness functions: ADR 0130 residuals D7 ─────────────────────────────────
//
// (1) Every read funnel into the fold/VM passes the seal guard. The runtime wraps the configured
//     event store ONCE (SealGuardedEventStore); every kernel file reads stored envelopes through the
//     store it is handed by the runtime. A NEW file that reads a store, or a read of the unguarded
//     `deps.eventStore`, fails here until someone decides it is guarded.
// (2) The operator detail (`sealedDetailOf`) is not on the main index.
// (3) The deterministic cipher seam: random IV by default, exported only from the testing subpath.

const ROOT = resolve(__dirname, "../../..");
const SKIP = new Set(["node_modules", "dist", ".turbo", ".vite", "coverage", ".git"]);
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (
        e.name.endsWith(".ts") &&
        !p.includes("__tests__") &&
        !/\.(test|bench|typecheck)\.ts$/.test(e.name)
      )
        out.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, dir));
  return out.sort();
}

const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("every read funnel passes the seal guard (ADR 0130 residuals D7)", () => {
  const KERNEL = sourceFiles("packages/workflow-runtime/src");

  it("the kernel files that read stored envelopes are exactly the pinned set (a new funnel must be decided)", () => {
    const readers = KERNEL.filter((f) =>
      /\b(readRangeOf\(|\.readFrom\(|[sS]tore\.read\(|\.readRange\()/.test(strip(read(f)))
    );
    // Each reads through the store the RUNTIME hands it (`this.eventStore`, `runtime.events`, or a
    // store argument supplied by the runtime), which is the SealGuardedEventStore. Reserved control
    // streams (inbox, quarantine, lifecycle) are exempt from the stream guard by design.
    expect(readers).toEqual([
      "packages/workflow-runtime/src/LogLifecycle.ts",
      "packages/workflow-runtime/src/WorkflowRuntime.ts",
      "packages/workflow-runtime/src/blankStream.ts",
      "packages/workflow-runtime/src/inbox.ts",
      "packages/workflow-runtime/src/placement.ts",
      "packages/workflow-runtime/src/recoverAbandoned.ts",
      "packages/workflow-runtime/src/sealGuard.ts",
    ]);
  });

  it("WorkflowRuntime assigns its event store ONLY as a SealGuardedEventStore and never reads deps.eventStore", () => {
    const src = strip(read("packages/workflow-runtime/src/WorkflowRuntime.ts"));
    expect(src).toMatch(/new SealGuardedEventStore\(deps\.eventStore\)/);
    expect(src.match(/this\.eventStore\s*=[^=]/g)).toHaveLength(1);
    expect(src).toMatch(/this\.eventStore\s*=\s*guardedEvents/);
    // the only other uses of the raw dependency: the inbox source (reserved streams, exempt) and the
    // appendBatch capability probe
    const uses = [...src.matchAll(/[^\n]*\n?[^\n]*deps\.eventStore\b[^\n]*/g)].map((m) => m[0]);
    for (const u of uses) {
      expect(u, u).toMatch(/SealGuardedEventStore|createInboxSource|appendBatch/);
    }
    expect(src).toMatch(/new SealGuardedSnapshotStore\(deps\.snapshotStore/);
  });

  it("the kernel components built by the app read through the runtime's guarded store", () => {
    const src = strip(read("packages/app/src/defineConfig.ts"));
    expect(src).toMatch(/new LogLifecycle\(runtime\.events,/);
  });

  it("the seal check runs before the policy: ownerForAuthz reads and refuses before authzDenial", () => {
    const src = read("packages/workflow-runtime/src/WorkflowRuntime.ts");
    const i = src.indexOf("private async ownerForAuthz(");
    const j = src.indexOf("principalLooksSealed(", i);
    const k = src.indexOf("private authzDenial(", i);
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    expect(j).toBeLessThan(k);
    expect(src.slice(i, k)).toMatch(/if \(err instanceof SealedStreamUnreadableError\) throw err/);
  });

  it("internal handlers test the brand, never a bare ExecutionDeniedError, for sealed refusals", () => {
    for (const f of [
      "packages/workflow-runtime/src/TimerService.ts",
      "packages/workflow-runtime/src/recoverAbandoned.ts",
    ]) {
      const src = strip(read(f));
      expect(src, f).toMatch(/isSealedUnreadable\(/);
      expect(src, f).not.toMatch(/instanceof SealedPayloadUnreadableError/);
    }
    // agent: the brand is checked before the generic denial classification
    const tf = strip(read("packages/agent/src/toolFailure.ts"));
    expect(tf.indexOf("loom.sealedUnreadable")).toBeGreaterThan(0);
    expect(tf.indexOf("SEALED_UNREADABLE] === true")).toBeLessThan(
      tf.indexOf("TERMINAL_ERROR_NAMES.has(")
    );
  });
});

describe("the operator detail stays off the main entry", () => {
  it("main index does not export sealedDetailOf; the operator entry and package exports do", () => {
    expect(strip(read("packages/workflow-runtime/src/index.ts"))).not.toMatch(/sealedDetailOf/);
    expect(strip(read("packages/workflow-runtime/src/operator.ts"))).toMatch(/sealedDetailOf/);
    const pkg = JSON.parse(read("packages/workflow-runtime/package.json")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(pkg.exports)).toContain("./operator");
    expect(read("packages/workflow-runtime/operator.js")).toMatch(/dist\/operator/);
  });

  it("the sealed error carries no caller-visible detail property", () => {
    const src = strip(read("packages/workflow-runtime/src/sealGuard.ts"));
    expect(src).toMatch(/const details = new WeakMap/);
    const cls = src.slice(
      src.indexOf("export class SealedStreamUnreadableError"),
      src.indexOf("Object.defineProperty(SealedStreamUnreadableError")
    );
    expect(cls).not.toMatch(/\breadonly\b|\bthis\.(reason|sequence|covers)\b/);
  });
});

describe("the deterministic cipher seam", () => {
  it("defaults to randomBytes(12), refuses a custom source in production, and is not on the main entry", () => {
    const crypto = strip(read("plugins/crypto/src/crypto.ts"));
    expect(crypto).toMatch(/ivOverride === undefined \? randomBytes\(12\)/);
    expect(crypto).toMatch(/NODE_ENV === "production"/);
    const idx = strip(read("plugins/crypto/src/index.ts"));
    expect(idx).not.toMatch(/seededIvSource|testing|IvSource/);
    expect(strip(read("plugins/crypto/src/testing.ts"))).toMatch(/export function seededIvSource/);
    const pkg = JSON.parse(read("plugins/crypto/package.json")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(pkg.exports)).toContain("./testing");
  });

  it("no non-test source outside the crypto stores passes an ivSource", () => {
    const offenders: string[] = [];
    for (const dir of ["packages", "plugins", "tools"]) {
      for (const pkg of readdirSync(join(ROOT, dir))) {
        for (const f of sourceFiles(`${dir}/${pkg}/src`)) {
          if (f.startsWith("plugins/crypto/src/")) continue;
          if (/\bivSource\b|seededIvSource/.test(strip(read(f)))) offenders.push(f);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
