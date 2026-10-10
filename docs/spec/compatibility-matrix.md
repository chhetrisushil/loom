# Loom Kernel Compatibility Matrix

> Generated from `@loom/spec` (`loom kernel-manifest --emit-docs`). Do not edit by hand — it is
> derived from the version constants + capability registry, which are the source of truth.

Every kernel/SPI contract version. **Compatibility rule:** two versions are compatible iff
they share a **major** version (an additive MINOR never breaks a stored log or wire client).
A major is compared per contract, never across contracts (MemoryStore SPI is `2.x` while
most are `1.x`). Loom is a lockstep monorepo today — every contract below ships together and
is mutually compatible, so the **current supported set is the single row below**; the
mechanism (`checkCompatibility`) exists for the day a deployment's MAJOR diverges from it
(e.g. an external adapter pinned to an older SPI).

| Contract | Version | Source of truth |
|---|---|---|
| Kernel ABI (K1) | `1.3.0` | `KERNEL_ABI_VERSION` · `abi.test.ts` |
| Event Schema (K5) | `1.24.0` | `EVENT_SCHEMA_VERSION` · `eventSchema.test.ts` |
| Wire ABI (T2) | `1.0.0` | `WIRE_ABI_VERSION` · `wire-abi.test.ts` |
| EventStore SPI | `2.3.0` | `EVENT_STORE_SPI_VERSION` · conformance kit |
| SnapshotStore SPI | `1.1.0` | `SNAPSHOT_STORE_SPI_VERSION` · conformance kit |
| BranchRegistry SPI | `2.0.0` | `BRANCH_REGISTRY_SPI_VERSION` · conformance kit |
| LeaseStore SPI | `2.1.0` | `LEASE_STORE_SPI_VERSION` · conformance kit |
| Dispatcher SPI | `1.2.0` | `DISPATCHER_SPI_VERSION` · conformance kit |
| MemoryStore SPI | `2.1.0` | `MEMORY_STORE_SPI_VERSION` · conformance kit |
| ContentStore SPI | `1.4.0` | `CONTENT_STORE_SPI_VERSION` · conformance kit |
| Compiler manifest | `1` | `COMPILER_MANIFEST_VERSION` |

Event types folded by K5: **32** · Kernel syscalls: **14**.

**Kernel ABI 1.3.0 reserves the Wave 2 syscalls (`continueAsNew`, `receive`, `select`); a reserved
syscall is not in the table until its writer lands (`receive` / `select` have, behind
`kernel.features.inbox`, and `continueAsNew`, behind `kernel.features.continueAsNew`).** A syscall is callable iff it is in the kernel's syscall table, which the
wire handshake advertises (`syscalls`) beside `kernelAbiVersion`. Feature-detect against that list;
do not infer availability from `kernelAbiVersion >= 1.3.0` until the writers land.

Validate a deployment: `loom compat --abi <v> --event-schema <v> [...]` (exit non-zero on a
major mismatch), or `checkCompatibility(deploymentVersions)` from `@loom/spec`.
