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
      m.spis.memoryStore,
      m.spis.contentStore,
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
      "MEMORY_STORE_SPI_VERSION",
      "CONTENT_STORE_SPI_VERSION",
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
  // 0020 — K8 (cancellation/deadlines/bounded effects) is BADGED: see the
  // `cancellation-deadlines` capability. It was exempted here under "no runtime
  // subsystem to grade", which was never true of it. The same is true of its
  // neighbours 0019/0021-0024 (K7 isolation, K9 delivery, K10 lifecycle, K11
  // versioning, K12 identity) — all still exempted, all genuinely runtime
  // subsystems, each needing its own evidence and level judgment.
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
  // A routing-policy fix inside the advisory plane (exploration for the learned
  // router). Grades nothing the registry tracks, for the same reason ADR 0018 —
  // the learning seam it amends — is listed here.
  "0078",
  // 0079/0080 — the learning substrate. 0079 is two descriptive payload fields on
  // an existing event (graded by the event-schema contract, not a capability);
  // 0080 is a read-only 1P package plus a 3P policy, i.e. placement, not a runtime
  // subsystem. Same reasoning as 0018/0030 above.
  "0079",
  "0080",
  // 0081/0082 — placement verdicts on the Companion workload: a rejected promotion
  // and a deferral-behind-evidence. Neither ships a runtime subsystem to grade, the
  // same reason the other rejection/deferral ADRs are listed here.
  "0081",
  "0082",
  // 0083 — a review rule for 1P surface growth. No runtime subsystem to grade.
  "0083",
  // 0084 — effect classes ride the existing @loom/verify seam (ADR 0028's capability
  // is what the registry grades); this ADR adds a rule, not a subsystem.
  "0084",
  // 0092 — a placement verdict on the adaptive-operator-profile workload: the app builds
  // it, one 1P item is gated on a second consumer and one is deferred behind evidence.
  // No runtime subsystem to grade, the same reason 0081/0082/0083 are listed here.
  "0092",
  // 0093 — one optional method on the read-model store SPI (a plugin), the same tier as
  // ADR 0058 above: the registry grades runtime subsystems, and this grows an adapter seam.
  "0093",
  // 0096 — a declared version constant on the Blueprint IR plus an optional registry on the
  // terminal renderer. A contract and an adapter option; no runtime subsystem to grade.
  "0096",
  // 0097 — the same IR grown by one major version: wrapped grid cells, a loom-owned binding-
  // status channel, widget source, and a sensitivity field. A contract and two renderer
  // options, the same tier as 0096; no runtime subsystem to grade.
  "0097",
  // 0098 — the same IR grown by a minor version: optional grid-cell placement and layout
  // titles, drawn by both renderers. A contract and renderer behaviour, the tier of 0096/0097.
  "0098",
  // 0099 — the same IR, one more optional field: a `role` on every layout, the key a
  // container-renderer registry looks up. A contract; loom's renderers ignore it.
  "0099",
  // 0100 — the same IR, one more BindingState literal: `empty`, drawn as a "no data" row by
  // both renderers. A contract and renderer behaviour; triggers nothing at run time.
  "0100",
  // 0101 — the same IR, one more optional field: an `id` on every layout, one node-id namespace
  // with widget ids. A contract; the React renderer keys by it, the terminal ignores it.
  "0101",
  // 0102 — a kernel replay BUG FIX: flow-level emit/stream/ui append once per execution, as the
  // ABI table already said. No new subsystem; it restores the meaning of three existing syscalls
  // (graded under workflow-runtime/replay-vm; only EVENT_SCHEMA_VERSION bumps).
  "0102",
  // 0103 — a kernel BUG FIX: a caller-chosen-id start writes its bootstrap before the body runs,
  // so a duplicate is refused (ExecutionAlreadyExistsError) before any effect. No new subsystem;
  // it restores what a deterministic id was always for (graded under workflow-runtime).
  "0103",
  // 0104 — a correction to what the resume path records on a crash re-drive (no
  // EXECUTION_RESUMED unless a parked gate is answered). A kernel fix, like 0057; no new
  // subsystem to grade.
  "0104",
  // 0105 — a kernel fold BUG FIX: STEP_FAILED no longer moves the execution status (only
  // EXECUTION_FAILED does), so a caught step failure followed by a crash is recoverable. No new
  // subsystem (graded under replay-vm/workflow-runtime; EVENT_SCHEMA 1.21.0).
  "0105",
  // 0106 — a correction to compaction (checkpoint identity, re-compaction folding on the
  // earlier checkpoint, pinned kinds kept in place); one additive optional SPI method on an
  // existing capability. No new subsystem to grade.
  "0106",
  // 0107 — closes 0106's residuals: fork() of a compacted parent is exact or refused, and an
  // operator repair re-homes what the pre-0106 bug wrote to execution "". A correction plus one
  // audit event kind (EVENT_SCHEMA 1.22.0) on existing capabilities; no new subsystem to grade.
  "0107",
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

  it("checks a 3P content store's SPI major (ContentStore SPI 1.3.0 is in the manifest)", () => {
    expect(checkCompatibility({ contentStoreSpi: "1.2.0" }).ok).toBe(true);
    const report = checkCompatibility({ contentStoreSpi: "2.0.0" });
    expect(report.ok).toBe(false);
    expect(report.issues[0]?.component).toBe("contentStoreSpi");
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
