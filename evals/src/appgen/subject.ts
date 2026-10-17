import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type AppModel,
  type ChangeSpec,
  type FilePlan,
  applyChanges,
  generateFlows,
  planChangesDeterministic,
  scanApp,
} from "@loom/appgen";
import { planChangesModel, tryParseChangeSpec, validateChangeSpec } from "@loom/appgen-model";
import { CassetteMissError } from "@loom/eval";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import type { ExpectedShape, FixtureKind } from "./cases";
import { type Typechecker, formatDiagnostic } from "./typecheck";

// ── Running one appgen case ───────────────────────────────────────────────────
//
// intent + fixture app → a ChangeSpec (the model arm: the REAL `planChangesModel` with its reasoning ladder and
// self-repair loop over a cassette; the reference arm: the REAL `planChangesDeterministic`) → the REAL
// `applyChanges` → the FilePlan written into a throwaway fixture directory → `tsc --noEmit` over the flow files
// → `scanApp` of the result, to read the shape back.
//
// A plan is VALID only when ALL of these hold; otherwise `reasons` carries the underlying error:
//   1. the model's own answer was accepted. `planChangesModel` swallows a bad answer and silently returns the
//      deterministic plan instead, which would score as if the model had planned it; the arm is told apart by
//      `ChangeSpec.planner`, and the rejected answer is re-validated here to name WHY it was rejected;
//   2. `applyChanges` produced a FilePlan and every path in it stays inside the fixture directory;
//   3. the written flow files typecheck.

export type Arm = "model" | "deterministic";

export interface CaseOutcome {
  readonly arm: Arm;
  readonly valid: boolean;
  /** Why the plan is invalid (empty when valid). */
  readonly reasons: readonly string[];
  /** Items observed in the applied app (see {@link observe}). */
  readonly observed: readonly string[];
  /** The ChangeSpec that was applied, when planning produced one. */
  readonly spec?: ChangeSpec;
  /** The model's raw replies, in order (model arm). */
  readonly replies: readonly string[];
}

/** Support-desk fixture: three GENERATED flows, so the brownfield editor and the delete gate behave as in real use. */
const SUPPORT_DESK = [
  { id: "triage", name: "Triage", intent: "Classify incoming tickets.", steps: ["classify"] },
  {
    id: "refunds",
    name: "Refunds",
    intent: "Refund an order.",
    steps: ["lookup-order", "issue"],
    approval: true,
  },
  { id: "digest", name: "Digest", intent: "Summarise the day.", steps: ["collect"] },
] as const;

export function buildFixture(kind: FixtureKind): string {
  const root = mkdtempSync(join(tmpdir(), "loom-evals-appgen-"));
  if (kind === "support-desk") {
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "support-desk" })}\n`);
    const files = generateFlows({
      name: "support-desk",
      capabilities: SUPPORT_DESK.map((c) => ({ ...c, steps: [...c.steps] })),
    });
    for (const f of files) {
      mkdirSync(dirname(join(root, f.path)), { recursive: true });
      writeFileSync(join(root, f.path), f.contents);
    }
  }
  return root;
}

/** `dest` inside `root` or an error (the fixture is the only place a case may write). */
export function resolveInsideRoot(root: string, rel: string): string {
  const abs = resolve(root, rel);
  const r = relative(root, abs);
  if (r === "" || r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r)) {
    throw new Error(`plan path "${rel}" resolves outside the fixture directory`);
  }
  return abs;
}

/** A path the harness is about to write that is a symlink would carry the write out of the fixture. */
function notALink(p: string): string {
  try {
    if (lstatSync(p).isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${p}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return p;
}

/**
 * Write a FilePlan into `root`. A path that escapes `root` (lexically) or is a symlink throws before anything
 * outside is touched. The eval harness must never write outside its own fixture, whatever a plan says.
 */
export function writePlan(root: string, plan: FilePlan): void {
  // Validate everything first, so a bad path late in the plan cannot leave a half-applied fixture behind.
  const creates = plan.creates.map((c) => [notALink(resolveInsideRoot(root, c.path)), c] as const);
  const edits = plan.edits.map((e) => [notALink(resolveInsideRoot(root, e.path)), e] as const);
  const deletes = plan.deletes.map((d) => notALink(resolveInsideRoot(root, d.path)));
  for (const [p, c] of creates) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c.contents);
  }
  for (const [p, e] of edits) writeFileSync(p, e.after);
  for (const p of deletes) rmSync(p, { force: true });
}

/** Every `app/flows/<id>/flow.ts(x)` under `root` (the tight file set that is typechecked). */
export function flowFiles(root: string): string[] {
  const dir = join(root, "app", "flows");
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .flatMap((e) =>
        readdirSync(join(dir, e.name))
          .filter((f) => /^flow\.tsx?$/.test(f))
          .map((f) => join("app", "flows", e.name, f))
      );
  } catch {
    return [];
  }
}

/** The shape of the app on disk, as items: flow, step, approval, ui (sorted). */
export function observe(model: AppModel): string[] {
  const items: string[] = [];
  for (const f of model.flows) {
    items.push(`flow:${f.id}`);
    for (const s of f.steps) items.push(`step:${f.id}/${s.id}`);
    if (f.hasApproval) items.push(`approval:${f.id}`);
    if (f.hasUi) items.push(`ui:${f.id}`);
  }
  return items.sort();
}

/**
 * Coverage of an intent: the fraction of expected items present (and expected-absent items absent). Recall over
 * the case's expected items, so a case with nothing expected scores 1 (none exist in the dataset: asserted).
 */
export function coverage(expected: ExpectedShape, observed: readonly string[]): number {
  const have = new Set(observed);
  const total = expected.present.length + expected.absent.length;
  if (total === 0) return 1;
  const hit =
    expected.present.filter((i) => have.has(i)).length +
    expected.absent.filter((i) => !have.has(i)).length;
  return hit / total;
}

/** Wrap a provider: remember every reply, in order. */
function recording(inner: LlmProvider): { provider: LlmProvider; replies: string[] } {
  const replies: string[] = [];
  return {
    replies,
    provider: {
      async complete(req: LlmRequest): Promise<LlmResponse> {
        const res = await inner.complete(req);
        replies.push(res.content);
        return res;
      },
    },
  };
}

/** Why the model's last answer was not accepted, from the same checks `planChangesModel` applies. */
export function whyRejected(
  replies: readonly string[],
  appModel: AppModel,
  intent?: string
): string {
  const last = replies[replies.length - 1];
  if (last === undefined || last.trim() === "") return "the model returned an empty answer";
  const parsed = tryParseChangeSpec(last);
  if (parsed === undefined)
    return "the model's answer is not a usable ChangeSpec (no capabilities)";
  const issues = validateChangeSpec(parsed, appModel, intent);
  return issues.length > 0 ? issues.join("; ") : "rejected for an unknown reason";
}

export interface RunOptions {
  readonly intent: string;
  readonly fixture: FixtureKind;
  readonly arm: Arm;
  /** The model arm's provider (a cassette on replay). */
  readonly provider?: LlmProvider & { readonly misses?: readonly string[] };
  readonly typechecker: Typechecker;
  /**
   * Test seam: runs on the fixture directory AFTER the plan is written and BEFORE the typecheck, so a
   * test can corrupt a generated file and prove the compiler-error reporting path still names the file.
   */
  readonly tamper?: (root: string) => void;
}

/** Run one case end to end. A cassette MISS is rethrown (it is a harness failure, never a quality score). */
export async function runCase(o: RunOptions): Promise<CaseOutcome> {
  const root = buildFixture(o.fixture);
  const reasons: string[] = [];
  let replies: string[] = [];
  let spec: ChangeSpec | undefined;
  try {
    const before = scanApp(root);
    if (o.arm === "model") {
      if (o.provider === undefined) throw new Error("runCase: the model arm needs a provider");
      const rec = recording(o.provider);
      spec = await planChangesModel(o.intent, before, {
        routes: [{ id: "cassette-planner", tier: 0, tags: ["planning"], provider: rec.provider }],
      });
      replies = rec.replies;
      const miss = o.provider.misses?.[0];
      if (miss !== undefined) throw new CassetteMissError(miss);
      if (spec.planner !== "model") {
        reasons.push(
          `model plan rejected (fell back to the deterministic planner): ${whyRejected(replies, before, o.intent)}`
        );
      }
    } else {
      spec = planChangesDeterministic(o.intent, before);
    }

    if (reasons.length === 0) {
      try {
        const plan = applyChanges(spec, before);
        writePlan(root, plan);
        o.tamper?.(root);
        const diags = o.typechecker.check(root, flowFiles(root));
        for (const d of diags.slice(0, 5)) reasons.push(`typecheck: ${formatDiagnostic(d)}`);
      } catch (e) {
        reasons.push(`apply: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      }
    }
    const observed = observe(scanApp(root));
    return {
      arm: o.arm,
      valid: reasons.length === 0,
      reasons,
      observed,
      ...(spec !== undefined && { spec }),
      replies,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
