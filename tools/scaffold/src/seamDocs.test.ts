import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SEAM_KEYS, SEAM_SPI, SEAM_WIRING } from "./plugin";

// ── Fitness function: a seam cannot ship undocumented ─────────────────────────
//
// Adding a seam touches five code sites that are easy to find (the registry, the
// scaffold, the conformance kit, SPI_PACKAGES, an example) and several doc sites
// that are not, because none of them sit next to the code. Both `policy` and
// `llm` shipped scaffoldable and conformance-kitted while absent from the
// canonical SPI map — the one document an implementer opens to find out what
// seams exist. `llm` had been missing for far longer than `policy`.
//
// This is the same shape as the ADR-coverage guard in `@loom/spec`: convert "we
// forgot" into a failing test, in a reviewable diff. It only covers what is
// mechanically checkable **inside this repo** — the sibling `loom-plugins`
// README and the multi-checkout setup diagrams are deliberately left to review,
// because a check that appeared to cover them and could not would be worse than
// knowing they are manual.

const REPO_ROOT = resolve(__dirname, "../../..");
const doc = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

const SPI_MAP = "docs/loom-2.0/12-extension-seams.md";
const PLUGIN_GUIDE = "docs/plugins.md";
// The CLI guide enumerates the seams too, and was NOT covered: `lease` landed in the plugin
// guide (this test made sure) and stayed missing here. Two enumerations, one guard.
const CLI_GUIDE = "docs/usage-cli.md";

/**
 * Seams with no ROW naming their SPI in the map. Structural on purpose: matching
 * the interface name anywhere in the file would pass on a passing mention in
 * prose — including the "policy is the exception" paragraph in the plugin guide —
 * which is exactly the vacuous check this is meant not to be.
 */
function seamsMissingFromSpiMap(mapText: string): string[] {
  const rows = mapText.split("\n").filter((l) => l.startsWith("|"));
  return SEAM_KEYS.filter((key) => {
    const spi = SEAM_SPI[key] as string;
    return !rows.some((r) => r.includes(`\`${spi}`));
  });
}

/** Seams absent from the plugin guide's `Seams:` enumeration. */
function seamsMissingFromGuide(guideText: string): string[] {
  const start = guideText.indexOf("Seams: ");
  if (start === -1) return [...SEAM_KEYS];
  // The enumeration wraps across lines and ends at the sentence's period.
  const list = guideText.slice(start, guideText.indexOf(".", start));
  return SEAM_KEYS.filter((key) => !list.includes(`\`${key}\``));
}

/** Every `run*Conformance` @loom/conformance exports. Read as text — no dependency on it. */
function exportedKits(): string[] {
  const source = readFileSync(resolve(REPO_ROOT, "packages/conformance/src/index.ts"), "utf8");
  return [...source.matchAll(/export function (run\w*Conformance)/g)].map((m) => m[1] as string);
}

/**
 * The OTHER direction, which nothing checked.
 *
 * Every guard here ran scaffold → docs: a seam you can scaffold must be documented. Nothing
 * ran docs → scaffold, so an SPI could be published in the map, ship a conformance kit, and
 * have no `loom plugin new` template — advertised as pluggable and not scaffoldable. That is
 * how `LeaseStore` sat there: interface, kit, map row, composition wiring, no seam.
 *
 * A one-directional fitness function is the same failure it exists to prevent, pointed the
 * other way.
 */
describe("scaffold coverage for published SPIs (fitness)", () => {
  /**
   * SPIs a third party can implement but not scaffold, each with the reason. Being on this
   * list is a DECISION; being absent from both lists is the accident this test exists for.
   */
  const NO_SEAM_YET: Record<string, string> = {
    Scheduler: "no conformance kit — not advertised as a third-party seam",
    Warmer: "no conformance kit — not advertised as a third-party seam",
    KillSwitchRegistry:
      "no conformance kit yet — a 3-line contract (`check(ctx)` → verdict | none; a throw fails closed)",
    PrincipalResolver:
      "no conformance kit — an app-owned binding from a recorded principal to its identity (R3k, ADR 0111), not a distributable plugin",
    PrincipalCodec:
      "no conformance kit — an app-owned map from an opaque ref to a principal (R3k, ADR 0111), not a distributable plugin",
    // Covered by an existing seam rather than needing their own:
    SnapshotStore: "scaffolded by the `store` seam, alongside EventStore",
    BranchRegistry: "scaffolded by the `store` seam, behind its `branching` option",
    ArchiveStore:
      "not emitted by the `store` template yet (ADR 0138): a store plugin that wants `compact` implements it and runs `runArchiveStoreConformance`",
  };

  /** SPI interface names the map publishes, read from its rows. */
  function publishedSpis(mapText: string): string[] {
    const names = new Set<string>();
    for (const row of mapText.split("\n").filter((l) => l.startsWith("|"))) {
      const m = /`([A-Z]\w+)`\s*\(`@loom\/[\w-]+`\)/.exec(row);
      if (m?.[1] !== undefined) names.add(m[1]);
    }
    return [...names];
  }

  it("reads the map (the sweep itself cannot silently match nothing)", () => {
    expect(publishedSpis(doc(SPI_MAP)).length).toBeGreaterThan(10);
  });

  it("the CLI guide's seam enumeration names every seam", () => {
    const text = doc(CLI_GUIDE);
    const start = text.indexOf("The current seams are");
    expect(start, `${CLI_GUIDE} no longer enumerates the seams`).toBeGreaterThan(-1);
    const sentence = text.slice(start, text.indexOf(".", start));
    const missing = SEAM_KEYS.filter((k) => !sentence.includes(`\`${k}\``));
    expect(missing, `${CLI_GUIDE} omits: ${missing.join(", ")}`).toEqual([]);
  });

  it("every published SPI is scaffoldable, or exempted with a reason", () => {
    const scaffoldable = new Set(Object.values(SEAM_SPI));
    const orphans = publishedSpis(doc(SPI_MAP)).filter(
      (spi) => !scaffoldable.has(spi) && NO_SEAM_YET[spi] === undefined
    );
    expect(
      orphans,
      `these SPIs are published in the map and a third party cannot scaffold them:\n${orphans.join("\n")}`
    ).toEqual([]);
  });

  it("the exemption list names no SPI that is now scaffoldable — a stale excuse is a hole", () => {
    const scaffoldable = new Set(Object.values(SEAM_SPI));
    const stale = Object.keys(NO_SEAM_YET).filter(
      (spi) => scaffoldable.has(spi) && !NO_SEAM_YET[spi]?.startsWith("scaffolded by")
    );
    expect(stale).toEqual([]);
  });

  it("a seam wired through defineConfig names a REAL config key", () => {
    // `durable-state` shipped a wiring line reading `durableState: { store }` — a config key
    // that does not exist, invented by analogy with `timers: { store }`. The line is the
    // first thing an author copies, so a fabricated one sends them to a compile error with
    // loom's name on it. Seams wired in CODE (a constructor, a helper call) are skipped:
    // there is no config key to check.
    const config = readFileSync(resolve(REPO_ROOT, "packages/app/src/defineConfig.ts"), "utf8");
    const declared = new Set([...config.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]));
    const bad: string[] = [];
    for (const key of SEAM_KEYS) {
      const wiring = SEAM_WIRING[key] as string;
      const m = /^(\w+)\s*:/.exec(wiring);
      if (m?.[1] === undefined) continue; // wired in code, not in defineConfig
      if (!declared.has(m[1])) bad.push(`${key} → \`${m[1]}\` is not a defineConfig option`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("every defineConfig option typed as an INTERFACE appears in the SPI map", () => {
    // The blind spot the other two guards share: both start from a conformance kit, so a
    // seam with no kit is invisible to them. `ExecutionAuthorizer` and `TimerDispatcher` were
    // both `defineConfig` options an application implements — replaceable by construction,
    // which is what the map says it enumerates — with no row, no kit and no scaffold.
    //
    // This starts from the config instead: if an app can pass its own implementation of X,
    // X is a seam, whether or not anyone wrote a kit for it.
    const config = readFileSync(resolve(REPO_ROOT, "packages/app/src/defineConfig.ts"), "utf8");
    const map = doc(SPI_MAP);

    // Interface-typed options, one or two levels in (`authorizer?: CapabilityAuthorizer`,
    // `dispatcher?: TimerDispatcher`). Concrete classes, primitives, unions and callbacks are
    // not seams — you cannot supply your own `boolean`.
    // Types an app passes that are NOT replaceable behaviour. Each needs a reason, because
    // "it is just a shape" is also what someone would say about a seam they did not want to
    // document — the three below are data or a holder, with no policy to implement.
    const NOT_A_SEAM: Record<string, string> = {
      GrantTable: "a concrete 1P implementation, reachable through CapabilityAuthorizer",
      PlacementDispatcher: "a concrete 1P implementation of ExecutionDispatcher",
      ProjectionRuntime: "documented in its own right",
      ArchiveStores: "a HOLDER of two documented seams ({ eventStore, snapshotStore }), not one",
      ManifestView: "compiler-manifest DATA — there is no behaviour to supply",
      CatalogLike: "an adapter shape for an existing catalog object, not a pluggable backend",
      ResolvedEnvelope: "an OUTPUT on LoomApp (the resolved bounds), not something an app supplies",
      HeartbeatConfig:
        "heartbeat-lease SETTINGS (ttl, cadence, enabled); the pluggable part is its `store`, a LeaseStore (ADR 0130 D11)",
    };
    const options = [...config.matchAll(/^\s{2,4}(\w+)\?:\s*([A-Z]\w+);/gm)];
    const missing: string[] = [];
    for (const [, option, type] of options) {
      if (type === undefined || option === undefined) continue;
      if (NOT_A_SEAM[type] !== undefined) continue;
      // `security`, `observability`, `durability`… are option GROUPS — a namespace of
      // settings, not a behaviour anyone implements. The naming convention is load-bearing
      // here, so a group added later is excluded without an edit.
      if (type.endsWith("Options")) continue;
      // Only types declared as an `interface` somewhere in the repo — a type alias for a
      // union or a function is a config shape, not an implementable seam.
      const declared = execSync(
        `grep -rl "export interface ${type} " packages plugins --include="*.ts" || true`,
        { cwd: REPO_ROOT, encoding: "utf8" }
      ).trim();
      if (declared === "") continue;
      if (!map.includes(`\`${type}`)) missing.push(`${option}: ${type}`);
    }
    expect(
      missing,
      `these defineConfig options let an app supply its own implementation, and the SPI map never names them:\n${missing.join("\n")}`
    ).toEqual([]);
  });

  it("every SPI with a conformance kit is scaffoldable", () => {
    // The strongest form of this rule, and the one that generalises past today's list:
    // publishing a conformance kit IS loom saying "third parties implement this". An SPI it
    // says that about, and then gives no way to start from, is advertising with no door.
    const COVERED_ELSEWHERE = new Set(["SnapshotStore", "BranchRegistry", "ArchiveStore"]); // the `store` seam (ArchiveStore: its optional compaction companion, ADR 0138; the template does not emit it yet)
    const scaffoldable = new Set(Object.values(SEAM_SPI));
    const kitted = exportedKits().map((k) => k.replace(/^run/, "").replace(/Conformance$/, ""));
    const doorless = kitted.filter((spi) => !scaffoldable.has(spi) && !COVERED_ELSEWHERE.has(spi));
    expect(
      doorless,
      `these SPIs publish a conformance kit and cannot be scaffolded:\n${doorless.join("\n")}`
    ).toEqual([]);
  });

  it("`lease` is scaffoldable, kitted and documented — the case that prompted this", () => {
    expect(SEAM_SPI.lease).toBe("LeaseStore");
    expect(doc(SPI_MAP)).toContain("runLeaseStoreConformance");
    expect(doc(PLUGIN_GUIDE)).toContain("`lease`");
  });
});

describe("conformance-kit/doc coverage (fitness)", () => {
  it("finds the kits (the sweep itself can't silently match nothing)", () => {
    expect(exportedKits().length).toBeGreaterThan(10);
  });

  it("every conformance kit is named in the SPI map", () => {
    // This started with an allowlist of six kits whose seams had no row at all. They
    // have rows now, so the allowlist is gone rather than kept empty: an exemption
    // list with nothing in it is a check that cannot fail, dressed as one that can.
    const mapText = doc(SPI_MAP);
    const undocumented = exportedKits().filter((kit) => !mapText.includes(kit));
    expect(
      undocumented,
      `these kits exist and the map does not mention them, so a backend author cannot find them:\n${undocumented.join("\n")}`
    ).toEqual([]);
  });

  it("the map names no kit that does not exist", () => {
    const kits = new Set(exportedKits());
    const named = [...doc(SPI_MAP).matchAll(/`(run\w*Conformance)`/g)].map((m) => m[1] as string);
    expect(named.length).toBeGreaterThan(3);
    expect(named.filter((kit) => !kits.has(kit))).toEqual([]);
  });
});

describe("seam/doc coverage (fitness)", () => {
  it("every seam has a row naming its SPI in the extension-seams map", () => {
    expect(seamsMissingFromSpiMap(doc(SPI_MAP))).toEqual([]);
  });

  it("every seam appears in the plugin guide's seam list", () => {
    expect(seamsMissingFromGuide(doc(PLUGIN_GUIDE))).toEqual([]);
  });

  // ── The checks must be able to FAIL ────────────────────────────────────────
  // A guard nobody has watched fail is indistinguishable from a comment.

  it("fails when a seam's row is removed from the map", () => {
    const withoutPolicy = doc(SPI_MAP)
      .split("\n")
      .filter((l) => !(l.startsWith("|") && l.includes("`Policy<A>`")))
      .join("\n");
    expect(seamsMissingFromSpiMap(withoutPolicy)).toEqual(["policy"]);
  });

  it("is not satisfied by a passing mention outside the table", () => {
    // The failure mode a `toContain` check would have: the word is in the file,
    // the row is not.
    const prose = `${doc(SPI_MAP)
      .split("\n")
      .filter((l) => !(l.startsWith("|") && l.includes("`LlmProvider`")))
      .join("\n")}\n\nSee \`LlmProvider\` for the model backend.\n`;
    expect(seamsMissingFromSpiMap(prose)).toEqual(["llm"]);
  });

  it("fails when a seam is dropped from the guide's list", () => {
    expect(seamsMissingFromGuide(doc(PLUGIN_GUIDE).replace("`policy`", "`polciy`"))).toEqual([
      "policy",
    ]);
  });

  it("reports every seam when the guide has no seam list at all", () => {
    expect(seamsMissingFromGuide("no enumeration here")).toEqual([...SEAM_KEYS]);
  });
});
