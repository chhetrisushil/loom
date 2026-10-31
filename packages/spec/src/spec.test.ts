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
      m.spis.archiveStore,
    ]) {
      expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(m.compilerManifest.version).toBe("1");
    expect(m.kernelAbi.syscalls.length).toBeGreaterThan(0);
    expect(m.eventSchema.eventTypes.length).toBeGreaterThan(0);
  });

  it("ADR 0130 residuals S1 reserves EVENT_SCHEMA 1.25.0 / EventStore SPI 2.5.0 and changes NOTHING in the kernel ABI", () => {
    const m = kernelManifest();
    expect(m.eventSchema.version).toBe("1.26.0");
    expect(m.spis.eventStore).toBe("2.5.0");
    // KERNEL_ABI is the syscall surface: the new facts are folded kinds, not syscalls, and the new
    // ops are type-only. Both the version and the table must be exactly what they were.
    expect(m.kernelAbi.version).toBe("1.3.0");
    expect(m.kernelAbi.syscalls).toHaveLength(14);
    expect(m.spis.snapshotStore).toBe("1.2.0");
    expect(m.wireAbi.version).toBe("1.0.0");
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
      "LEASE_STORE_SPI_VERSION",
      "DISPATCHER_SPI_VERSION",
      "MEMORY_STORE_SPI_VERSION",
      "CONTENT_STORE_SPI_VERSION",
      "ARCHIVE_STORE_SPI_VERSION",
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
  // 0132 — folded-state read models: five optional methods on the same read-model store SPI and
  // a plugin-side engine, the same tier as ADR 0058/0093 — an adapter seam, not a runtime subsystem.
  "0132",
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
  // 0108 — a correction to an existing capability's contract: execution ids page in code point
  // order with id cursors (EventStore SPI 2.0.0), Postgres pages via a COLLATE "C" column, and
  // a policy for boot migrations that take an exclusive lock. No new subsystem to grade.
  "0108",
  // 0117 — approvals bound to what the approver saw (a digest in the existing suspend condition),
  // a reference ResumeAuthenticator, and no bus auto-approve: hardening of existing capabilities
  // (resume gate, K12.2 authenticator, A2A bus). No new subsystem to grade.
  "0117",
  // 0116 — R11: one runtime method (`recordOutcome`) that appends the existing OUTCOME_RECORDED to a
  // finished execution under a new authorizer op, plus a retention-clock fix. It extends the
  // learning substrate (ADR 0078-0080) and execution authz (C.1). No new subsystem to grade.
  "0116",
  // 0129 - a semantic tightening of the EventStore SPI (2.3.0: the appendIfUnchanged anchor names an
  // incarnation) across the three reference stores. No new subsystem to grade.
  "0129",
  // 0115 — R15: three closed vocabularies (effect/task kinds, metering dimensions) become open
  // names with a pattern; the metering fold shape was frozen at W2-0. It widens existing
  // capabilities (K3 metering and quotas, ADR 0032 dimensions, ADR 0030 decisions). No new
  // subsystem to grade.
  "0115",
  // 0114 — R14: `ctx.ui` leaves the kernel (a dependency edge removed, an ABI entry deprecated and
  // `negotiateBudget` added to the table, a layering rule). No runtime subsystem to grade.
  "0114",
  // 0111 — R3k: the execution's principal is recorded on EXECUTION_STARTED and rehydrated on every
  // path (EVENT_SCHEMA 1.23.0 payload fields only; no ABI or dispatcher change). Closes the
  // identity half of existing capabilities (K12.1 principal, K2 ring, R3 execution authz); the
  // kernel records and rehydrates, every decision stays in 1P. No new subsystem to grade.
  "0111",
  // 0118 — R8k: an optional EventStore method (the conditional fence), a runtime option, a
  // retryable error and a timer-store field. It completes existing capabilities (K9.4 fencing,
  // the R8 supervisor, T1 timers, the K10.6 pin seam); the SPI version is already in the
  // compatibility matrix. No new subsystem to grade.
  "0118",
  // 0128 — one additive field (`seq`) on the folded `_decisions` entry so decision order survives a
  // checkpoint (EVENT_SCHEMA 1.24.0), read by `@loom/learning`. Completes existing capabilities (ADR
  // 0106 compaction, ADR 0116 evidence from the fold). No new subsystem to grade.
  "0128",
  // 0112 — R6: `ctx.parallel` becomes a cancellation scope (fail-fast aborts siblings, the outcome
  // is journaled as `PARALLEL_COMPLETED`), a park drains in-flight steps before it commits, and a
  // 1P cancel cascade in `@loom/orchestration`. It completes existing capabilities (K8
  // cancellation, the parallel combinator, the R8 supervisor); the event shapes were frozen at W2-0.
  // No new subsystem to grade.
  "0112",
  // 0109 — R1b: `ctx.continueAsNew` (one ABI entry), `EXECUTION_CONTINUED` and the `continued` status, a
  // deterministic successor started first, behind `kernel.features.continueAsNew`; 1P chain lineage
  // (`@loom/analytics`), supervisor follow-through and the `continueEvery` helper. It completes existing
  // capabilities (the durable log and recovery, R8 supervision, the K10 retention clock); the event
  // shapes were frozen at W2-0. No new subsystem to grade.
  "0109",
  // 0110 — R2: `ctx.receive` / `ctx.select` (two ABI entries), `MESSAGE_CONSUMED` and the multi-wait park,
  // an authorized `runtime.send`, behind `kernel.features.inbox`; the 1P `@loom/inbox` package is a
  // separate item. It completes existing capabilities (the resume gate, K12 authz, the T1 timers, R8k
  // fencing); the event shapes were frozen at W2-0. No new subsystem to grade.
  "0110",
  // 0113 — R7: SHA-256 for the structural flow hash (K11.1), an opt-in `codeFingerprint` recorded in the
  // reserved `codeHash`, a runtime-only replay-divergence detector and step families for `replay-check`.
  // It completes an existing capability (K11 flow-code versioning); the event shapes were frozen at
  // W2-0. No new subsystem to grade.
  "0113",
  // 0119 — a per-call live delta sink on the decide scope (EffectContext.onDelta). An additive 1P
  // extension of ctx.decide's scope / invokeTransient (ADR 0066, L30); no kernel change. No new
  // subsystem to grade.
  "0119",
  // 0130 — the sealed-payload delivery guard: a fail-closed refusal in the existing inbox delivery
  // path (ADR 0110), no new events, SPI or subsystem. Completes the inbox capability; nothing new
  // to grade.
  "0130",
  // 0131 — loom's own evals: a repo-internal, unpublished workspace (`evals/`) of regression gates over the
  // first-party agentic layer. A development gate like the DST runs and the fitness tests; it ships no
  // runtime subsystem, event, SPI or exported vocabulary, so there is nothing to grade.
  "0131",
  // 0135 - `waitForSuspend()` rejects with ExecutionTerminatedError on a terminal run (issue #710): a
  // settlement fix on the public handle of the workflow runtime. No event, SPI, ABI or subsystem change;
  // nothing to grade.
  "0135",
  // 0136 - opt-in lz4 TOAST compression for `snapshots.state` in the Postgres plugin (issue #707): a
  // storage-column option with a fail-soft fallback. No event, SPI, ABI or subsystem change; nothing to grade.
  "0136",
  // 0137 - agent state growth (issue #721): a report-only warning and a built-in summarizer effect in
  // `@loom/agent`, compaction still opt-in. No event, SPI, ABI or subsystem change; nothing to grade.
  "0137",
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

  it("refuses a 1.x LeaseStore (SPI 2.0.0, L28: expired() must default to the stamping clock)", () => {
    // A 1.x store may require `now`; handed `undefined` it matches nothing, so recovery would
    // silently never recover — the reason the bump is MAJOR.
    expect(kernelManifest().spis.leaseStore).toBe("2.2.0");
    expect(checkCompatibility({ leaseStoreSpi: "2.0.0" }).ok).toBe(true);
    const report = checkCompatibility({ leaseStoreSpi: "1.1.0" });
    expect(report.ok).toBe(false);
    expect(report.issues[0]?.component).toBe("leaseStoreSpi");
  });

  it("refuses a 1.x EventStore (SPI 2.x, ADR 0108: pinned id order + id cursors)", () => {
    // A 1.5.0 store may page in any order with an opaque cursor, which ShardedEventStore and
    // TenantScopedEventStore can no longer tolerate — the reason the bump is MAJOR. 2.1.0,
    // 2.2.0, 2.3.0, 2.4.0 and 2.5.0 are MINORs (acquireFenceIf; appendIfUnchanged; the incarnation anchor
    // MUST; storeNow; sealingCapability): a 2.0.0 store still conforms.
    expect(kernelManifest().spis.eventStore).toBe("2.5.0");
    const report = checkCompatibility({ eventStoreSpi: "1.5.0" });
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual([
      expect.objectContaining({ component: "eventStoreSpi", expected: "2.5.0", actual: "1.5.0" }),
    ]);
    expect(checkCompatibility({ eventStoreSpi: "2.0.0" }).ok).toBe(true);
    expect(checkCompatibility({ eventStoreSpi: "2.1.0" }).ok).toBe(true);
    expect(checkCompatibility({ eventStoreSpi: "2.2.0" }).ok).toBe(true);
    expect(checkCompatibility({ eventStoreSpi: "2.3.0" }).ok).toBe(true);
    expect(checkCompatibility({ eventStoreSpi: "2.4.0" }).ok).toBe(true);
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

// ── The cheatsheet's version banner can't quietly go stale ────────────────────
//
// `docs/cheatsheet-features.md` opens with a banner stating every SPI/ABI version by hand
// (it is prose around a table, not a generated file, so it cannot go through the
// `renderCompatibilityMatrix()` check above). It already drifted once: BranchRegistry SPI
// stayed "1.2.0" in the banner for a full review round after the constant moved to 2.0.0
// (review round 1 of loom PR #469). Only the names the manifest actually tracks are
// checked, so a banner name with no BANNER_TO_MANIFEST entry is invisible to this test: add one
// whenever the manifest gains an SPI (LeaseStore was exempt until L28 review round 1).
describe("cheatsheet-features.md's version banner matches the manifest", () => {
  const BANNER_TO_MANIFEST: Record<string, () => string> = {
    "KERNEL ABI": () => kernelManifest().kernelAbi.version,
    "EVENT SCHEMA": () => kernelManifest().eventSchema.version,
    "EventStore SPI": () => kernelManifest().spis.eventStore,
    "BranchRegistry SPI": () => kernelManifest().spis.branchRegistry,
    "LeaseStore SPI": () => kernelManifest().spis.leaseStore,
    "MemoryStore SPI": () => kernelManifest().spis.memoryStore,
  };

  const doc = readFileSync(resolve(REPO_ROOT, "docs/cheatsheet-features.md"), "utf8");
  // The banner is the blockquote right after the title — read line by line, not with a
  // multiline regex, so a version stated ANYWHERE later in the doc cannot masquerade as
  // the banner's own claim.
  const banner = doc
    .split("\n")
    .filter((line) => line.startsWith(">"))
    .join(" ");
  const stated = new Map(
    [...banner.matchAll(/([A-Z][A-Za-z ]*?) \*\*(\d+\.\d+\.\d+)\*\*/g)].map((m) => [
      m[1] as string,
      m[2] as string,
    ])
  );

  it("finds the banner and at least the names this test knows how to check", () => {
    expect(banner.length).toBeGreaterThan(20);
    const known = [...stated.keys()].filter((name) => name in BANNER_TO_MANIFEST);
    expect(known.length).toBe(Object.keys(BANNER_TO_MANIFEST).length);
  });

  it("every version this test can check matches the live manifest", () => {
    const mismatches: string[] = [];
    for (const [name, expected] of Object.entries(BANNER_TO_MANIFEST)) {
      const inBanner = stated.get(name);
      if (inBanner !== undefined && inBanner !== expected()) {
        mismatches.push(`${name}: banner says ${inBanner}, manifest says ${expected()}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
