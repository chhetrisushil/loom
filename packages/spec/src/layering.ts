import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

// Repo root, from packages/spec/src → up three levels (mirrors spec.test.ts).
const REPO_ROOT = resolve(__dirname, "../../..");

// The workspace tiers that hold real packages. `plugins/*` is the adapter tier
// introduced by ADR 0043; the layering guard below forbids the minimal kernel
// from ever depending on it.
const WORKSPACE_TIERS = ["packages", "plugins", "apps", "tools", "examples"] as const;

/**
 * The minimal kernel: durable mechanism + ABI + determinism core. These carry
 * mechanism, not policy, and MUST NOT depend on any concrete adapter (a `plugins/*`
 * package). See ADR 0043.
 */
export const KERNEL_PACKAGES: readonly string[] = [
  "@loom/core",
  "@loom/event-runtime",
  "@loom/snapshot-runtime",
  "@loom/replay-vm",
  "@loom/effect-runtime",
  "@loom/workflow-runtime",
  "@loom/scheduler",
  "@loom/wire-abi",
  // A zero-workspace-dependency vocabulary leaf (data-class paths, `zod` only) that `effect-runtime`
  // has always imported. Naming it here is what makes the closed-set rule below true without
  // pretending the edge is something else (ADR 0114 D4).
  "@loom/classify",
];

/**
 * SPI-contract packages: they define a seam that adapters implement, plus (at most)
 * an in-memory reference implementation. Like the kernel, they must not reach into a
 * concrete adapter. (`@loom/dispatcher` keeps its interface + the `LocalDispatcher`
 * reference; the placement/supervising policies are advisory, not adapters.)
 */
export const SPI_PACKAGES: readonly string[] = [
  "@loom/worker-runtime",
  "@loom/projection-runtime",
  "@loom/llm",
  "@loom/blueprint-runtime",
  "@loom/registry",
  "@loom/telemetry",
  "@loom/dispatcher",
  // Defines the `Policy` SPI (ADR 0080). Listed so `loom plugin check` holds a
  // policy plugin to the same peer-dependency rule as every other seam — without
  // it the check passes vacuously for the one seam consumed from flow code.
  "@loom/learning",
  // Defines the `MemoryStore` SPI (ADR 0090/0091) plus the in-memory reference. It was
  // missing here for as long as the seam has existed, so `loom plugin check` reported a
  // green "SPI packages are peer dependencies" to every memory backend while being unable
  // to see the one package that matters to it. A bundled copy is not a duplicate kernel
  // here, it is a duplicate CONTRACT: `searchableText`, `tokenize` and `clampSearchLimit`
  // decide what a backend indexes and what counts as a term, so a plugin carrying its own
  // copy can answer a different question than the app asked and still pass conformance.
  "@loom/memory",
  // Defines the `SandboxBackend` SPI (ADR 0144) plus the effect that owns every guarantee around
  // it. Listed so `loom plugin check` holds a sandbox backend to the peer-dependency rule: a
  // bundled copy is a duplicate CONTRACT (the limits, channels and replay form), not just a
  // duplicate type.
  "@loom/sandbox",
];

/** Packages that must stay free of any `plugins/*` dependency (kernel ∪ SPI). */
export const PURE_PACKAGES: readonly string[] = [...KERNEL_PACKAGES, ...SPI_PACKAGES];

interface PackageNode {
  name: string;
  /** Tier-relative location, e.g. "packages/core" or "plugins/postgres". */
  location: string;
  tier: string;
  /** Workspace dependencies (deps whose version is `workspace:*`). */
  workspaceDeps: string[];
}

/** Read every workspace package's name, location, and workspace-dependency edges. */
export function readWorkspaceGraph(root: string = REPO_ROOT): Map<string, PackageNode> {
  const graph = new Map<string, PackageNode>();
  for (const tier of WORKSPACE_TIERS) {
    const tierDir = resolve(root, tier);
    if (!existsSync(tierDir)) continue;
    for (const entry of readdirSync(tierDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = resolve(tierDir, entry.name, "package.json");
      if (!existsSync(pkgPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        name?: string;
        dependencies?: Record<string, string>;
      };
      if (typeof pkg.name !== "string") continue;
      const workspaceDeps = Object.entries(pkg.dependencies ?? {})
        .filter(([, version]) => version.startsWith("workspace:"))
        .map(([dep]) => dep);
      graph.set(pkg.name, {
        name: pkg.name,
        location: `${tier}/${entry.name}`,
        tier,
        workspaceDeps,
      });
    }
  }
  return graph;
}

export interface LayeringViolation {
  /** A pure (kernel/SPI) package… */
  from: string;
  /** …that transitively depends on this `plugins/*` adapter… */
  plugin: string;
  /** …via this dependency path (names, `from` first). */
  path: string[];
}

/**
 * Find every case where a kernel/SPI package reaches a `plugins/*` adapter through
 * its transitive workspace dependencies. Empty result ⇒ the minimal-kernel invariant
 * (ADR 0043) holds.
 */
export function findLayeringViolations(root: string = REPO_ROOT): LayeringViolation[] {
  const graph = readWorkspaceGraph(root);
  const isPlugin = (name: string): boolean => graph.get(name)?.tier === "plugins";
  const violations: LayeringViolation[] = [];

  for (const pureName of PURE_PACKAGES) {
    const start = graph.get(pureName);
    if (start === undefined) continue; // not present yet — nothing to check
    const seen = new Set<string>([pureName]);
    // BFS carrying the path so a violation reports how the edge was reached.
    const queue: string[][] = start.workspaceDeps.map((dep) => [pureName, dep]);
    while (queue.length > 0) {
      const path = queue.shift() as string[];
      const current = path[path.length - 1] as string;
      if (isPlugin(current)) {
        violations.push({ from: pureName, plugin: current, path });
        continue; // record the first hit on this branch; don't walk into the plugin
      }
      if (seen.has(current)) continue;
      seen.add(current);
      const node = graph.get(current);
      if (node === undefined) continue;
      for (const dep of node.workspaceDeps) queue.push([...path, dep]);
    }
  }
  return violations;
}

export interface KernelClosureViolation {
  /** A kernel package… */
  from: string;
  /** …that declares a workspace dependency on a package outside `KERNEL_PACKAGES`. */
  dependsOn: string;
}

/**
 * ADR 0114 D4 — the inverse rule: **a kernel package depends only on kernel packages** (a closed
 * set). The ADR 0043 rule forbids kernel → `plugins/*`; it cannot see kernel → application
 * vocabulary (a UI package, a projection runtime). A kernel package that needs an external type
 * takes it structurally (or by declaration merging owned by the other package) instead.
 *
 * Reads declared `dependencies` only: a `devDependency` is test scaffolding, not a build edge.
 */
export function findKernelClosureViolations(root: string = REPO_ROOT): KernelClosureViolation[] {
  const graph = readWorkspaceGraph(root);
  const kernel = new Set(KERNEL_PACKAGES);
  const violations: KernelClosureViolation[] = [];
  for (const name of KERNEL_PACKAGES) {
    const node = graph.get(name);
    if (node === undefined) continue;
    for (const dep of node.workspaceDeps) {
      if (!kernel.has(dep)) violations.push({ from: name, dependsOn: dep });
    }
  }
  return violations;
}
