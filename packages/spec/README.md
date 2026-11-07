# @loom/spec — the kernel manifest and the repo's fitness guards

Two things live here. The library is a read-only manifest of the kernel and SPI version constants, a
compatibility validator, a maturity registry (`CAPABILITIES`) and a layering checker. It builds the
manifest by importing the real exported constants from their home packages, so it cannot be hand-edited
out of sync with them. Second, `src/*.test.ts` is the repository's governance suite: the guards that fail
the build when docs, READMEs, exports, test conventions or package layering drift from the code. Nothing
here touches execution semantics, and it is not something an app imports. You read it to see what a
version means, and you run it (`pnpm --filter @loom/spec test`) to find out which convention you broke.

```ts
import { CAPABILITIES, checkCompatibility, kernelManifest, renderCompatibilityMatrix } from "@loom/spec";

const manifest = kernelManifest(); // built by importing the real version constants
console.log(manifest.eventSchema.version, manifest.spis.memoryStore); // "1.26.0" "2.1.0"

// Same major is compatible, a different major is not; only fields you pass are checked.
const report = checkCompatibility({ eventSchema: "1.0.0", memoryStoreSpi: "1.0.0" });
console.log(report.ok, report.issues.map((i) => `${i.component}: ${i.reason}`));
// false ["memoryStoreSpi: major-version mismatch (deployment 1.0.0 vs kernel 2.1.0)"]

console.log(CAPABILITIES.filter((c) => c.level === "L5").map((c) => c.id));
console.log(renderCompatibilityMatrix().split("\n")[0]); // "# Loom Kernel Compatibility Matrix"
```

## Surface

- **Manifest.** `kernelManifest()` returns the kernel ABI and syscalls, the event-schema version and event
  types, the wire ABI, the SPI versions (event store, snapshot store, branch registry, lease store,
  dispatcher, memory store, content store, archive store, sandbox backend) and the compiler manifest.
- **Compatibility.** `checkCompatibility(deployment)` returns `{ ok, issues }`; `majorCompatible(a, b)`.
- **Maturity.** `CAPABILITIES` (levels L0 to L5), `MATURITY_MEANINGS`, `renderMaturityTable`,
  `renderCompatibilityMatrix`, `renderManifestText`. Each capability names the evidence behind its level
  (a version constant, a conformance test, a bench), and a test checks the evidence exists.
- **Layering.** `KERNEL_PACKAGES`, `SPI_PACKAGES`, `PURE_PACKAGES`, `readWorkspaceGraph(root?)`,
  `findLayeringViolations(root?)` (a kernel or SPI package reaching a `plugins/*` package) and
  `findKernelClosureViolations(root?)` (a kernel package depending outside the kernel set).
- **CLI.** `loom kernel-manifest [--json] [--emit-docs <dir>]` prints the manifest and writes the files
  under `docs/spec/`.

## Behaviour that surprises people

- **Compatibility is per contract, by major version only.** A minor bump never fails the check, and
  majors differ across contracts (the memory store SPI is 2.x while the dispatcher is 1.x), so there is no
  single "Loom version" to compare against.
- **Omitted fields are not checked.** A report with `ok: true` covers only what you passed.
- **The layering functions read the checkout from disk.** `root` defaults to this repo, resolved from the
  package's own location, so they are meaningful only inside a source checkout.
- **Adding a package has costs here.** The guards require a README titled with the package name, an
  `api-reference.org` section for packages that ship typings, a `tsconfig.test.json` where there are
  tests, and so on. The README guard's failure message, for one, says which command to run.
- **This package depends on many others.** The manifest imports each home package for its version
  constant, so `spec` sits above most of the workspace in the dependency graph.

## Install

Unpublished for now: inside this repo use `workspace:*`; from a sibling checkout use a `link:` override (see [AGENTS.md](../../AGENTS.md)).

## See also

- API reference: section "`@loom/spec` — the kernel manifest, badges and layering" in [docs/api-reference.org](../../docs/api-reference.org). It types `readWorkspaceGraph` as returning a `WorkspaceGraph` and `findLayeringViolations` as taking one; in the source they return a `Map` and take a `root` path.
- Generated: [compatibility matrix](../../docs/spec/compatibility-matrix.md), [maturity](../../docs/spec/maturity.md), [fitness functions](../../docs/spec/fitness-functions.md), [kernel specification](../../docs/spec/loom-kernel-specification.md).
- ADRs: [0033 SPI conformance contracts](../../docs/adr/0033-spi-conformance-contracts.md), [0043 plugin packaging and 1P/3P separation](../../docs/adr/0043-plugin-packaging-and-1p-3p-separation.md), [0114 `ctx.ui` leaves the kernel](../../docs/adr/0114-ctx-ui-leaves-the-kernel.md) (the closed kernel set).
- Source: `packages/spec/src`.
