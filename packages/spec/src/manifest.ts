import { COMPILER_MANIFEST_VERSION } from "@loom/compiler";
import { DISPATCHER_SPI_VERSION } from "@loom/dispatcher";
import {
  ARCHIVE_STORE_SPI_VERSION,
  BRANCH_REGISTRY_SPI_VERSION,
  EVENT_STORE_SPI_VERSION,
  LEASE_STORE_SPI_VERSION,
} from "@loom/event-runtime";
import { MEMORY_STORE_SPI_VERSION } from "@loom/memory";
import { CONTENT_STORE_SPI_VERSION } from "@loom/plugin-content";
import { EVENT_SCHEMA_VERSION, knownEventTypes } from "@loom/replay-vm";
import { SNAPSHOT_STORE_SPI_VERSION } from "@loom/snapshot-runtime";
import { WIRE_ABI_VERSION } from "@loom/wire-abi";
import { KERNEL_ABI_VERSION, KERNEL_SYSCALLS } from "@loom/workflow-runtime";

// ── The Loom Kernel Manifest ─────────────────────────────────────────────────
//
// A single machine-readable aggregate of every kernel/SPI version contract, built by
// IMPORTING the real exported constants from their home packages — never hand-copied — so
// the manifest, the compatibility matrix, and the maturity badges can NEVER drift from the
// code. Read-only; nothing here touches execution semantics.

export interface KernelManifest {
  /** K1 — the kernel syscall ABI. */
  kernelAbi: { version: string; syscalls: readonly string[] };
  /** K5 — the on-disk event-schema ABI. */
  eventSchema: { version: string; eventTypes: readonly string[] };
  /** T2 — the wire protocol projection of the K1 syscalls. */
  wireAbi: { version: string };
  /** The pluggable storage/compute SPI contract versions (ADR 0033). */
  spis: {
    eventStore: string;
    snapshotStore: string;
    branchRegistry: string;
    leaseStore: string;
    dispatcher: string;
    memoryStore: string;
    /** `@loom/plugin-content` — the blob seam 3P backends implement (ADR 0046/0062/0055). */
    contentStore: string;
    /** `@loom/event-runtime` — where `LogLifecycle.compact` MOVES the events it removes (ADR 0138). */
    archiveStore: string;
  };
  /** The compiler manifest schema version. */
  compilerManifest: { version: string };
}

/** Build the kernel manifest from the live, exported version constants. */
export function kernelManifest(): KernelManifest {
  return {
    kernelAbi: {
      version: KERNEL_ABI_VERSION,
      syscalls: KERNEL_SYSCALLS.map((s) => s.name).sort(),
    },
    eventSchema: {
      version: EVENT_SCHEMA_VERSION,
      eventTypes: knownEventTypes(),
    },
    wireAbi: { version: WIRE_ABI_VERSION },
    spis: {
      eventStore: EVENT_STORE_SPI_VERSION,
      snapshotStore: SNAPSHOT_STORE_SPI_VERSION,
      branchRegistry: BRANCH_REGISTRY_SPI_VERSION,
      leaseStore: LEASE_STORE_SPI_VERSION,
      dispatcher: DISPATCHER_SPI_VERSION,
      memoryStore: MEMORY_STORE_SPI_VERSION,
      contentStore: CONTENT_STORE_SPI_VERSION,
      archiveStore: ARCHIVE_STORE_SPI_VERSION,
    },
    compilerManifest: { version: COMPILER_MANIFEST_VERSION },
  };
}

/** Two versions are compatible iff they share a major version (`"1.x" ↔ "1.y"`, `"2" ↔ "2"`). */
export function majorCompatible(a: string, b: string): boolean {
  return (a.split(".")[0] ?? a) === (b.split(".")[0] ?? b);
}

/** The versions a deployment/adapter claims to speak. Any omitted field is not checked. */
export interface DeploymentVersions {
  kernelAbi?: string;
  eventSchema?: string;
  wireAbi?: string;
  eventStoreSpi?: string;
  snapshotStoreSpi?: string;
  branchRegistrySpi?: string;
  dispatcherSpi?: string;
  memoryStoreSpi?: string;
  contentStoreSpi?: string;
  archiveStoreSpi?: string;
  leaseStoreSpi?: string;
  compilerManifest?: string;
}

export interface CompatIssue {
  component: string;
  expected: string;
  actual: string;
  reason: string;
}

export interface CompatReport {
  ok: boolean;
  issues: CompatIssue[];
}

/**
 * Validate a deployment's declared versions against this kernel's manifest. Same-major is
 * compatible (an additive MINOR bump never breaks a stored log or a wire client). Today Loom
 * is a lockstep monorepo — every contract ships together and is mutually compatible (majors
 * are per contract: MemoryStore SPI is 2.x) — so a real incompatibility only appears once a
 * deployment's MAJOR diverges from this manifest's; the mechanism is here for that day.
 */
export function checkCompatibility(actual: DeploymentVersions): CompatReport {
  const m = kernelManifest();
  const checks: Array<[string, string | undefined, string]> = [
    ["kernelAbi", actual.kernelAbi, m.kernelAbi.version],
    ["eventSchema", actual.eventSchema, m.eventSchema.version],
    ["wireAbi", actual.wireAbi, m.wireAbi.version],
    ["eventStoreSpi", actual.eventStoreSpi, m.spis.eventStore],
    ["snapshotStoreSpi", actual.snapshotStoreSpi, m.spis.snapshotStore],
    ["branchRegistrySpi", actual.branchRegistrySpi, m.spis.branchRegistry],
    ["dispatcherSpi", actual.dispatcherSpi, m.spis.dispatcher],
    ["memoryStoreSpi", actual.memoryStoreSpi, m.spis.memoryStore],
    ["contentStoreSpi", actual.contentStoreSpi, m.spis.contentStore],
    ["archiveStoreSpi", actual.archiveStoreSpi, m.spis.archiveStore],
    ["leaseStoreSpi", actual.leaseStoreSpi, m.spis.leaseStore],
    ["compilerManifest", actual.compilerManifest, m.compilerManifest.version],
  ];
  const issues: CompatIssue[] = [];
  for (const [component, a, expected] of checks) {
    if (a === undefined) continue;
    if (!majorCompatible(a, expected)) {
      issues.push({
        component,
        expected,
        actual: a,
        reason: `major-version mismatch (deployment ${a} vs kernel ${expected})`,
      });
    }
  }
  return { ok: issues.length === 0, issues };
}
