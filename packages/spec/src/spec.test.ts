import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "./capabilities";
import { checkCompatibility, kernelManifest } from "./manifest";
import { renderCompatibilityMatrix, renderMaturityTable } from "./render";

// Repo root, from packages/spec/src → up three levels.
const REPO_ROOT = resolve(__dirname, "../../..");
const exists = (rel: string): boolean => existsSync(resolve(REPO_ROOT, rel));

describe("kernelManifest", () => {
  it("aggregates the real, semver-shaped version constants", () => {
    const m = kernelManifest();
    for (const v of [
      m.kernelAbi.version,
      m.eventSchema.version,
      m.wireAbi.version,
      m.spis.eventStore,
      m.spis.snapshotStore,
      m.spis.branchRegistry,
      m.spis.dispatcher,
    ]) {
      expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(m.compilerManifest.version).toBe("1");
    expect(m.kernelAbi.syscalls.length).toBeGreaterThan(0);
    expect(m.eventSchema.eventTypes.length).toBeGreaterThan(0);
  });
});

describe("capability maturity — evidence is real (badges can't rot)", () => {
  it("every capability declares a valid level", () => {
    for (const c of CAPABILITIES) {
      expect(["L0", "L1", "L2", "L3", "L4", "L5"]).toContain(c.level);
    }
  });

  it("every referenced conformance test / bench file actually exists", () => {
    for (const c of CAPABILITIES) {
      if (c.evidence.conformanceTest) {
        expect(exists(c.evidence.conformanceTest), `${c.id}: ${c.evidence.conformanceTest}`).toBe(
          true
        );
      }
      if (c.evidence.bench) {
        expect(exists(c.evidence.bench), `${c.id}: ${c.evidence.bench}`).toBe(true);
      }
    }
  });

  it("enforces the level bar: L5 needs a version constant + conformance test", () => {
    for (const c of CAPABILITIES.filter((x) => x.level === "L5")) {
      expect(c.evidence.versionConstant, `${c.id} claims L5`).toBeDefined();
      expect(c.evidence.conformanceTest, `${c.id} claims L5`).toBeDefined();
    }
  });

  it("enforces the level bar: L4 needs a committed bench", () => {
    for (const c of CAPABILITIES.filter((x) => x.level === "L4")) {
      expect(c.evidence.bench, `${c.id} claims L4 (verified & benchmarked)`).toBeDefined();
    }
  });

  it("enforces the level bar: L2/L3 need a test suite", () => {
    for (const c of CAPABILITIES.filter((x) => x.level === "L2" || x.level === "L3")) {
      expect(c.evidence.conformanceTest, `${c.id} claims ${c.level}`).toBeDefined();
    }
  });

  it("L5 version-constant names correspond to the manifest", () => {
    const known = new Set([
      "KERNEL_ABI_VERSION",
      "EVENT_SCHEMA_VERSION",
      "WIRE_ABI_VERSION",
      "EVENT_STORE_SPI_VERSION",
      "SNAPSHOT_STORE_SPI_VERSION",
      "BRANCH_REGISTRY_SPI_VERSION",
      "DISPATCHER_SPI_VERSION",
      "COMPILER_MANIFEST_VERSION",
    ]);
    for (const c of CAPABILITIES) {
      if (c.evidence.versionConstant) {
        expect(known.has(c.evidence.versionConstant), c.evidence.versionConstant).toBe(true);
      }
    }
  });
});

// ── The published docs must equal what the generator emits ───────────────────
//
// `docs/spec/maturity.md` and `compatibility-matrix.md` carry a "do not edit by hand" banner,
// but nothing asserted they were ever REgenerated. They drifted: the matrix advertised
// EventStore SPI 1.2.0 for a day after the constant moved to 1.3.0 — a normative version claim,
// wrong, in the document adapter authors are told to trust. Regenerating is one command; the
// failure mode was that no one had to run it.
describe("generated spec docs are current", () => {
  const committed = (name: string): string =>
    readFileSync(resolve(REPO_ROOT, "docs/spec", name), "utf8");

  it("maturity.md matches renderMaturityTable()", () => {
    expect(committed("maturity.md")).toBe(renderMaturityTable());
  });

  it("compatibility-matrix.md matches renderCompatibilityMatrix()", () => {
    expect(committed("compatibility-matrix.md")).toBe(renderCompatibilityMatrix());
  });
});

// ── The OTHER direction: shipped work can't skip declaring a badge ────────────
//
// The suite above proves `declared ⊆ proven` — a badge can't claim evidence it lacks. It says
// nothing about `shipped ⊆ declared`, and that asymmetry let the registry silently fall four
// ADRs behind (0074–0077 all landed on one day with no entry, so four shipped capabilities
// were absent from the generated maturity + compatibility docs).
//
// Every accepted ADR must therefore either appear in CAPABILITIES or be listed here as
// deliberately not-a-capability. Both are cheap; neither is silent. The allowlist is the point:
// it converts "we forgot" into "we decided", in a reviewable diff.
const NOT_A_CAPABILITY = new Set([
  // Process, placement and documentation decisions — no runtime subsystem to grade.
  "0001",
  "0002",
  "0003",
  "0004",
  "0005",
  "0006",
  "0007",
  "0008",
  "0009",
  "0010",
  "0011",
  "0012",
  "0013",
  "0014",
  "0015",
  "0016",
  "0017",
  "0018",
  "0019",
  "0020",
  "0021",
  "0022",
  "0023",
  "0024",
  "0025",
  "0026",
  "0027",
  "0028",
  "0029",
  "0030",
  "0031",
  "0032",
  "0033",
  "0034",
  "0035",
  "0036",
  "0037",
  "0038",
  "0039",
  "0040",
  "0041",
  "0042",
  "0043",
  "0044",
  "0045",
  "0046",
  "0047",
  "0048",
  "0049",
  "0050",
  "0051",
  "0052",
  "0053",
  "0054",
  "0055",
  "0056",
  "0057",
  "0058",
  "0059",
  "0060",
  "0061",
  "0062",
  "0063",
  "0064",
  "0065",
  "0066",
  "0067",
  "0068",
  "0069",
  "0070",
  "0071",
  "0072",
  "0073",
]);

describe("capability coverage — shipped work can't skip a badge", () => {
  const adrDir = resolve(REPO_ROOT, "docs/adr");
  const adrs = readdirSync(adrDir)
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .map((f) => ({ id: f.slice(0, 4), file: f }));

  it("finds ADRs to check (the sweep itself can't silently match nothing)", () => {
    expect(adrs.length).toBeGreaterThan(70);
  });

  it("every accepted ADR is either a declared capability or explicitly not one", () => {
    const declared = CAPABILITIES.map(
      (c) => `${c.id} ${c.title} ${c.summary} ${c.note ?? ""}`
    ).join("\n");
    const undeclared = adrs.filter(({ id, file }) => {
      if (NOT_A_CAPABILITY.has(id)) return false;
      // Superseded/withdrawn ADRs describe nothing shipped.
      const body = readFileSync(resolve(adrDir, file), "utf8");
      if (/^- Status: \*\*(Superseded|Withdrawn|Rejected|Proposed)/m.test(body)) return false;
      // Cited by number in any capability's summary/note.
      return !new RegExp(`ADR ${id}\\b`).test(declared);
    });
    expect(
      undeclared.map((a) => a.file),
      "ADRs with no capability entry — add one to CAPABILITIES, or to NOT_A_CAPABILITY if it grades nothing"
    ).toEqual([]);
  });
});

describe("checkCompatibility", () => {
  it("accepts the kernel's own current versions", () => {
    const m = kernelManifest();
    const report = checkCompatibility({
      kernelAbi: m.kernelAbi.version,
      eventSchema: m.eventSchema.version,
      dispatcherSpi: m.spis.dispatcher,
    });
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("accepts a same-major (MINOR-bumped) deployment", () => {
    expect(checkCompatibility({ eventSchema: "1.999.0" }).ok).toBe(true);
  });

  it("rejects a major-version mismatch and names the component", () => {
    const report = checkCompatibility({ kernelAbi: "2.0.0" });
    expect(report.ok).toBe(false);
    expect(report.issues[0]?.component).toBe("kernelAbi");
  });

  it("ignores components the deployment does not declare", () => {
    expect(checkCompatibility({}).ok).toBe(true);
  });
});
