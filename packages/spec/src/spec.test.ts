import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPABILITIES } from "./capabilities";
import { checkCompatibility, kernelManifest } from "./manifest";

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
