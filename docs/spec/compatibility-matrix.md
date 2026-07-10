# Loom Kernel Compatibility Matrix

> Generated from `@loom/spec` (`loom kernel-manifest --emit-docs`). Do not edit by hand — it is
> derived from the version constants + capability registry, which are the source of truth.

Every kernel/SPI contract version. **Compatibility rule:** two versions are compatible iff
they share a **major** version (an additive MINOR never breaks a stored log or wire client).
Loom is a lockstep monorepo today — every contract is `1.x` and mutually compatible, so the
**current supported set is the single row below**; the mechanism (`checkCompatibility`) exists
for the day a MAJOR diverges (e.g. an external adapter pinned to an older SPI).

| Contract | Version | Source of truth |
|---|---|---|
| Kernel ABI (K1) | `1.1.0` | `KERNEL_ABI_VERSION` · `abi.test.ts` |
| Event Schema (K5) | `1.11.0` | `EVENT_SCHEMA_VERSION` · `eventSchema.test.ts` |
| Wire ABI (T2) | `1.0.0` | `WIRE_ABI_VERSION` · `wire-abi.test.ts` |
| EventStore SPI | `1.0.0` | `EVENT_STORE_SPI_VERSION` · conformance kit |
| SnapshotStore SPI | `1.0.0` | `SNAPSHOT_STORE_SPI_VERSION` · conformance kit |
| BranchRegistry SPI | `1.0.0` | `BRANCH_REGISTRY_SPI_VERSION` · conformance kit |
| Dispatcher SPI | `1.0.0` | `DISPATCHER_SPI_VERSION` · conformance kit |
| Compiler manifest | `1` | `COMPILER_MANIFEST_VERSION` |

Event types folded by K5: **25** · Kernel syscalls: **10**.

Validate a deployment: `loom compat --abi <v> --event-schema <v> [...]` (exit non-zero on a
major mismatch), or `checkCompatibility(deploymentVersions)` from `@loom/spec`.
