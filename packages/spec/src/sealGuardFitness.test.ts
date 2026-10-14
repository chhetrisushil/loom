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

/** Any spelling of a read of the app's UNGUARDED `stores.eventStore`. */
const RAW_STORE_READ_SRC =
  "\\bstores\\s*(?:\\.\\s*eventStore\\b|\\[\\s*[\"'`]eventStore[\"'`]\\s*\\])|\\{[^}]*\\beventStore\\b[^}]*\\}\\s*=\\s*[\\w.$]*\\bstores\\b";
const RAW_STORE_READ = new RegExp(RAW_STORE_READ_SRC);
const RAW_STORE_READ_G = new RegExp(RAW_STORE_READ_SRC, "g");

describe("every read funnel passes the seal guard (ADR 0130 residuals D7)", () => {
  const KERNEL = sourceFiles("packages/workflow-runtime/src");

  it("the kernel files that read stored envelopes are exactly the pinned set (a new funnel must be decided)", () => {
    // A reader is pinned by what it TOUCHES, not by what it names its variable: a file that calls an
    // EventStore read method (`.read(`, `.readFrom(`, `.readRange(`, `readRangeOf(`) AND either
    // mentions the `EventStore` type (any identifier typed as one: `log.read(`, `es.read(`) or reaches
    // a runtime's store (`.events` / `.eventStore`).
    const readers = KERNEL.filter((f) => {
      const src = strip(read(f));
      return (
        /(\breadRangeOf\(|\.read\(|\.readFrom\(|\.readRange\()/.test(src) &&
        /(\bEventStore\b|\.events\b|\.eventStore\b)/.test(src)
      );
    });
    // Each reads through the store the RUNTIME hands it (`this.eventStore`, `runtime.events`, or a
    // store argument supplied by the runtime), which is the SealGuardedEventStore. Reserved control
    // streams (inbox, quarantine, lifecycle) are exempt from the stream guard by design.
    expect(readers).toEqual([
      "packages/workflow-runtime/src/LogLifecycle.ts",
      "packages/workflow-runtime/src/WorkflowRuntime.ts",
      "packages/workflow-runtime/src/blankStream.ts",
      "packages/workflow-runtime/src/inbox.ts",
      "packages/workflow-runtime/src/placement.ts",
      // ADR 0130 residuals D9: reads/writes the chain's quarantine + inbox streams (reserved control
      // streams, exempt from the stream guard) through the runtime's store; never an owner's log.
      "packages/workflow-runtime/src/quarantine.ts",
      "packages/workflow-runtime/src/redriveAbandoned.ts",
      "packages/workflow-runtime/src/sealGuard.ts",
    ]);
  });

  it("the at-rest reader is reached ONLY from sealGuard.ts (a kernel read of it elsewhere walks past the seal guard)", () => {
    const users = KERNEL.filter((f) => /\breadAtRest\b/.test(strip(read(f))));
    expect(users).toEqual(["packages/workflow-runtime/src/sealGuard.ts"]);
    const src = strip(read("packages/workflow-runtime/src/sealGuard.ts"));
    expect(src).toMatch(/readAtRest:\s*\{\s*refuse:/); // the guarded decorator does not forward it
    expect(src.match(/\.readAtRest\?\.\(\)/g)).toHaveLength(1);
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

  it("packages/app reads the RAW store only at the pinned, deliberate sites (compliance paths see their data with the keys)", () => {
    // `stores.eventStore` is the unguarded store. The runtime wraps it itself; the two compliance
    // paths (EraseCoordinator, exportSubject) read it raw ON PURPOSE and carry a comment saying why.
    // A NEW raw reader in packages/app fails here until someone decides it is deliberate, whatever
    // its spelling: `stores.eventStore`, `stores["eventStore"]`, or `const { eventStore } = stores`.
    const raw = sourceFiles("packages/app/src")
      .map((f) => ({ f, src: strip(read(f)) }))
      .filter(({ src }) => RAW_STORE_READ.test(src));
    expect(raw.map((r) => r.f)).toEqual(["packages/app/src/defineConfig.ts"]);
    const dc = strip(read("packages/app/src/defineConfig.ts"));
    // every raw read in defineConfig is the literal spelling the owner table below attributes
    expect(dc.match(RAW_STORE_READ_G)).toHaveLength(
      dc.match(/\bstores\.eventStore\b/g)?.length ?? 0
    );
    // each use is attributed to the NEAREST preceding constructor / call that takes it
    const owners: Array<[string, RegExp]> = [
      ["EraseCoordinator", /new EraseCoordinator\(/g],
      ["WorkflowRuntime", /new WorkflowRuntime\(/g],
      ["exportSubject", /exportSubjectData\(/g],
    ];
    const kinds = [...dc.matchAll(/\bstores\.eventStore\b(\.close\(\))?/g)].map((m) => {
      if (m[1] !== undefined) return "close";
      let best: [number, string] = [-1, `UNPINNED at ${m.index}`];
      for (const [name, re] of owners) {
        for (const o of dc.matchAll(re)) {
          if ((o.index ?? 0) < (m.index ?? 0) && (o.index ?? 0) > best[0])
            best = [o.index ?? 0, name];
        }
      }
      return best[1];
    });
    expect(kinds).toEqual(["EraseCoordinator", "WorkflowRuntime", "exportSubject", "close"]);
    const withComment = read("packages/app/src/defineConfig.ts");
    expect(withComment.match(/DELIBERATELY the raw store/g)).toHaveLength(2);
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
    for (const f of ["packages/workflow-runtime/src/TimerService.ts"]) {
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

/** The class method (2-space indented declaration) enclosing source offset `at`. */
function enclosingMethod(src: string, at: number): string {
  const decl = [
    ...src.slice(0, at).matchAll(/\n {2}(?:private |public |protected )?(?:async )?(\w+)\s*\(/g),
  ].at(-1);
  return decl?.[1] ?? "?";
}

/** `callee <- method` for every `this.callee(...)` whose arguments carry a quarantine verb. */
function verbPasses(src: string, callees: readonly string[]): string[] {
  const out = new Set<string>();
  const re = new RegExp(`this\\.(${callees.join("|")})\\(`, "g");
  for (const m of src.matchAll(re)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (depth > 0 && i < src.length) {
      const c = src[i++];
      if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    const args = src.slice(start, i - 1);
    if (/\bverb\b|\blogFoldFor\b|"quarantineInbox"|"releaseInbox"/.test(args)) {
      out.add(`${m[1]} <- ${enclosingMethod(src, m.index)}`);
    }
  }
  return [...out].sort();
}

// User ruling 2026-10-14 (read past sealed payloads): the quarantine verbs' log fold may step over a
// `MESSAGE_CONSUMED.payload` seal. The bypass read must be reachable from the quarantine verbs ONLY,
// and the state folded through it must be unable to reach a snapshot or a restore.
describe("the opaque quarantine read is reachable only from the quarantine verbs", () => {
  const RT = "packages/workflow-runtime/src/WorkflowRuntime.ts";
  const KERNEL = sourceFiles("packages/workflow-runtime/src");

  it("`quarantineReadView` / `quarantineReadsFor` are named in exactly the pinned places", () => {
    const hits = (re: RegExp): string[] => KERNEL.filter((f) => re.test(strip(read(f)))).sort();
    expect(hits(/\bquarantineReadView\b/)).toEqual([
      "packages/workflow-runtime/src/WorkflowRuntime.ts",
      "packages/workflow-runtime/src/sealGuard.ts",
    ]);
    expect(hits(/\bquarantineReadsFor\b/)).toEqual([RT]);
    expect(hits(/\bassertStreamReadableOpaque\b|\bOpaqueQuarantineEventStore\b/)).toEqual([
      "packages/workflow-runtime/src/sealGuard.ts",
    ]);
    const src = strip(read(RT));
    expect(src.match(/\.quarantineReadView\(\)/g)).toHaveLength(1); // inside quarantineReadsFor
    // nothing outside the kernel source reaches it, and the entries do not export it
    for (const f of ["index.ts", "operator.ts"]) {
      expect(strip(read(`packages/workflow-runtime/src/${f}`)), f).not.toMatch(
        /quarantineReadView|opaqueToQuarantineFold|OpaqueQuarantine|TransientFold/
      );
    }
    for (const dir of ["packages/app/src", "packages/agent/src", "plugins/crypto/src"]) {
      for (const f of sourceFiles(dir)) {
        expect(strip(read(f)), f).not.toMatch(/quarantineReadView|opaqueToQuarantineFold/);
      }
    }
  });

  it("every `quarantineReadsFor(` call sits in a pinned quarantine-verb read method", () => {
    const src = strip(read(RT));
    const allowed = new Set([
      "classifyTip",
      "locatePark",
      "findReleaseFact",
      "findReleaseFactBack",
      "foldFromCompleteLog",
      "foldState", // the no-snapshot and plaintext-snapshot tail reads (S5b round 3)
    ]);
    const callers: string[] = [];
    for (const m of src.matchAll(/this\.quarantineReadsFor\(/g)) {
      const head = src.slice(0, m.index);
      const decl = [
        ...head.matchAll(/\n {2}(?:private |public |protected )?(?:async )?(\w+)\s*\(/g),
      ].at(-1);
      callers.push(decl?.[1] ?? "?");
    }
    expect(callers.length).toBeGreaterThan(0);
    for (const c of callers) expect(allowed.has(c), c).toBe(true);
    expect(new Set(callers)).toEqual(allowed);
    // a second `foldState` argument (the verb) is passed only in the verbs' own paths
    const verbArgs = [...src.matchAll(/this\.foldState\(\s*[\w.!]+\s*,\s*([^)]+)\)/g)].map((m) =>
      (m[1] ?? "").trim()
    );
    expect(verbArgs.length).toBeGreaterThan(0);
    for (const a of verbArgs) {
      expect([
        "verb",
        "logFoldFor",
        "opts.logFoldFor",
        '"releaseInbox"',
        '"quarantineInbox"',
      ]).toContain(a);
    }
  });

  // P3-3: the callee NAMES above say where the bypass is read, not who may TURN IT ON. A verb value
  // is the switch, so every call that passes one (a `verb` / `logFoldFor` variable or a verb literal
  // in its arguments) is pinned to the method that is allowed to make it.
  it("only the pinned methods pass a quarantine verb to a verb-accepting method", () => {
    const src = strip(read(RT));
    const callees = [
      "operatorInboxHead",
      "openOwnerState",
      "afterHoldChange",
      "findReleaseFactBack",
      "findReleaseFact",
      "sendTarget",
      "classifyTip",
      "locatePark",
      "foldState",
      "foldFromCompleteLog",
    ];
    const passes = verbPasses(src, callees);
    expect(passes).toEqual([
      "afterHoldChange <- quarantineInboxCore",
      "afterHoldChange <- releaseInboxCore",
      "classifyTip <- sendTarget",
      "findReleaseFact <- releaseInboxCore",
      "findReleaseFactBack <- releaseInboxCore",
      "foldFromCompleteLog <- foldState",
      "foldState <- afterHoldChange",
      "foldState <- findReleaseFactBack",
      "foldState <- openOwnerState",
      "foldState <- releaseInboxCore",
      "foldState <- sendTarget",
      "locatePark <- quarantineInboxCore",
      "locatePark <- releaseInboxCore",
      "openOwnerState <- quarantineInboxCore",
      "openOwnerState <- releaseInboxCore",
      "operatorInboxHead <- quarantineInboxCore",
      "operatorInboxHead <- releaseInboxCore",
      "sendTarget <- operatorInboxHead",
    ]);
    // the verb cores are reached from their public verb only
    const callersOf = (name: string): string[] =>
      [...src.matchAll(new RegExp(`this\\.${name}\\(`, "g"))].map((m) =>
        enclosingMethod(src, m.index)
      );
    expect(callersOf("quarantineInboxCore")).toEqual(["quarantineInbox"]);
    expect(callersOf("releaseInboxCore")).toEqual(["releaseInbox"]);
  });

  it("the pin catches a new caller (a scratch method passing a verb is reported)", () => {
    const real = strip(read(RT));
    const planted = real.replace(
      /\n {2}private async classifyTip\(/,
      `\n  private async plantedProbe(id: string): Promise<void> {\n    await this.classifyTip(id, "quarantineInbox");\n  }\n\n  private async classifyTip(`
    );
    expect(planted).not.toBe(real);
    expect(verbPasses(planted, ["classifyTip"])).toContain("classifyTip <- plantedProbe");
    expect(verbPasses(real, ["classifyTip"])).not.toContain("classifyTip <- plantedProbe");
  });

  it("a state folded past sealed payloads is branded transient, minted in one place, and refused by snapshots and restore", () => {
    const src = strip(read(RT));
    expect(src.match(/markTransientFold\(/g)).toHaveLength(1);
    const mint = src.slice(src.indexOf("private transientQuarantineFold("));
    expect(mint.slice(0, mint.indexOf("\n  }\n"))).toMatch(/markTransientFold\(/);
    // its only callers: the verbs' fold paths (the whole-log fold and the two view-read folds)
    const minters = [...src.matchAll(/this\.transientQuarantineFold\(/g)].map((m) =>
      enclosingMethod(src, m.index)
    );
    expect(minters.sort()).toEqual(["foldFromCompleteLog", "foldState", "foldState"]);
    expect(src).toMatch(/assertNotTransientFold\(preloadedState, "restoreFromState"\)/);
    const sg = strip(read("packages/workflow-runtime/src/sealGuard.ts"));
    expect(sg).toMatch(
      /async save\(snapshot: Snapshot\)[^{]*\{\s*assertNotTransientFold\(snapshot\.state/
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
    expect(crypto).toMatch(/BRANDED_IV_SOURCES/);
    expect(crypto).toMatch(/process\.env\.VITEST/);
    // the brand minting function is not on the main entry; only testing.ts calls it
    expect(strip(read("plugins/crypto/src/testing.ts"))).toMatch(/brandIvSource\(/);
    expect(strip(read("plugins/crypto/src/index.ts"))).not.toMatch(/brandIvSource/);
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
