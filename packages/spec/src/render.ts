import {
  CAPABILITIES,
  type Capability,
  MATURITY_MEANINGS,
  type MaturityLevel,
} from "./capabilities";
import { type KernelManifest, kernelManifest } from "./manifest";

// Markdown renderers for the manifest views (compatibility matrix + maturity badges). The CLI
// and the committed docs both render from HERE, so the docs can't drift from the manifest.

const GENERATED_NOTE =
  "> Generated from `@loom/spec` (`loom kernel-manifest --emit-docs`). Do not edit by hand — it is\n> derived from the version constants + capability registry, which are the source of truth.";

/** The compatibility matrix — every kernel/SPI contract version + the current compatible set. */
export function renderCompatibilityMatrix(m: KernelManifest = kernelManifest()): string {
  const rows: Array<[string, string, string]> = [
    ["Kernel ABI (K1)", m.kernelAbi.version, "`KERNEL_ABI_VERSION` · `abi.test.ts`"],
    ["Event Schema (K5)", m.eventSchema.version, "`EVENT_SCHEMA_VERSION` · `eventSchema.test.ts`"],
    ["Wire ABI (T2)", m.wireAbi.version, "`WIRE_ABI_VERSION` · `wire-abi.test.ts`"],
    ["EventStore SPI", m.spis.eventStore, "`EVENT_STORE_SPI_VERSION` · conformance kit"],
    ["SnapshotStore SPI", m.spis.snapshotStore, "`SNAPSHOT_STORE_SPI_VERSION` · conformance kit"],
    [
      "BranchRegistry SPI",
      m.spis.branchRegistry,
      "`BRANCH_REGISTRY_SPI_VERSION` · conformance kit",
    ],
    ["LeaseStore SPI", m.spis.leaseStore, "`LEASE_STORE_SPI_VERSION` · conformance kit"],
    ["Dispatcher SPI", m.spis.dispatcher, "`DISPATCHER_SPI_VERSION` · conformance kit"],
    ["MemoryStore SPI", m.spis.memoryStore, "`MEMORY_STORE_SPI_VERSION` · conformance kit"],
    ["ContentStore SPI", m.spis.contentStore, "`CONTENT_STORE_SPI_VERSION` · conformance kit"],
    ["Compiler manifest", m.compilerManifest.version, "`COMPILER_MANIFEST_VERSION`"],
  ];
  const body = rows.map(([c, v, a]) => `| ${c} | \`${v}\` | ${a} |`).join("\n");
  return [
    "# Loom Kernel Compatibility Matrix",
    "",
    GENERATED_NOTE,
    "",
    "Every kernel/SPI contract version. **Compatibility rule:** two versions are compatible iff",
    "they share a **major** version (an additive MINOR never breaks a stored log or wire client).",
    "A major is compared per contract, never across contracts (MemoryStore SPI is `2.x` while",
    "most are `1.x`). Loom is a lockstep monorepo today — every contract below ships together and",
    "is mutually compatible, so the **current supported set is the single row below**; the",
    "mechanism (`checkCompatibility`) exists for the day a deployment's MAJOR diverges from it",
    "(e.g. an external adapter pinned to an older SPI).",
    "",
    "| Contract | Version | Source of truth |",
    "|---|---|---|",
    body,
    "",
    `Event types folded by K5: **${m.eventSchema.eventTypes.length}** · Kernel syscalls: **${m.kernelAbi.syscalls.length}**.`,
    "",
    "**Kernel ABI 1.3.0 reserves the Wave 2 syscalls (`continueAsNew`, `receive`, `select`); it does not",
    "contain them.** A syscall is callable iff it is in the kernel's syscall table, which the wire",
    "handshake advertises (`syscalls`) beside `kernelAbiVersion`. Feature-detect against that list;",
    "do not infer availability from `kernelAbiVersion >= 1.3.0` until the writers land.",
    "",
    "Validate a deployment: `loom compat --abi <v> --event-schema <v> [...]` (exit non-zero on a",
    "major mismatch), or `checkCompatibility(deploymentVersions)` from `@loom/spec`.",
    "",
  ].join("\n");
}

const LEVEL_ORDER: MaturityLevel[] = ["L5", "L4", "L3", "L2", "L1", "L0"];

function evidenceCell(c: Capability): string {
  const parts: string[] = [];
  if (c.evidence.versionConstant) parts.push(`\`${c.evidence.versionConstant}\``);
  if (c.evidence.conformanceTest) parts.push("test");
  if (c.evidence.bench) parts.push("bench");
  if (c.evidence.usedIn) parts.push(`used: ${c.evidence.usedIn}`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/** The capability maturity badge table (highest maturity first). */
export function renderMaturityTable(caps: readonly Capability[] = CAPABILITIES): string {
  const legend = LEVEL_ORDER.map((l) => `\`${l}\` ${MATURITY_MEANINGS[l]}`).join(" · ");
  const sorted = [...caps].sort(
    (a, b) =>
      LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.title.localeCompare(b.title)
  );
  const rows = sorted
    .map((c) => `| ${c.title} | \`${c.level}\` | ${c.package} | ${evidenceCell(c)} |`)
    .join("\n");
  const notes = sorted
    .filter((c) => c.note)
    .map((c) => `- **${c.title}** (\`${c.level}\`): ${c.note}`)
    .join("\n");
  return [
    "# Loom Capability Maturity",
    "",
    GENERATED_NOTE,
    "",
    `**Levels:** ${legend}`,
    "",
    "Levels are **evidence-derived, not self-assessed**: `L5` requires a versioned contract pinned",
    "by a conformance test; `L4` requires a committed bench; `L2`/`L3` require a passing test suite.",
    "`spec.test.ts` fails if a capability claims evidence it does not have — so a badge can't rot.",
    "",
    "| Capability | Level | Package | Evidence |",
    "|---|---|---|---|",
    rows,
    "",
    "## Notes",
    "",
    notes,
    "",
  ].join("\n");
}

/** Human-readable one-block manifest summary (for `loom kernel-manifest`). */
export function renderManifestText(m: KernelManifest = kernelManifest()): string {
  return [
    "Loom kernel manifest",
    `  kernel ABI      ${m.kernelAbi.version}   (${m.kernelAbi.syscalls.length} syscalls)`,
    `  event schema    ${m.eventSchema.version}  (${m.eventSchema.eventTypes.length} event types)`,
    `  wire ABI        ${m.wireAbi.version}`,
    `  event store SPI ${m.spis.eventStore}`,
    `  snapshot SPI    ${m.spis.snapshotStore}`,
    `  branch SPI      ${m.spis.branchRegistry}`,
    `  dispatcher SPI  ${m.spis.dispatcher}`,
    `  memory SPI      ${m.spis.memoryStore}`,
    `  compiler manif. ${m.compilerManifest.version}`,
    `  capabilities    ${CAPABILITIES.length} (see loom kernel-manifest --json)`,
  ].join("\n");
}
