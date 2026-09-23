import { hasLayoutId } from "./layout";
import { asCell } from "./normalize";
import type { Blueprint, GridCell, Layout, Widget } from "./types";

// ── Node identity across a structural change ─────────────────────────────────
//
// `validateBlueprint` checks one tree against a catalogue, including the ids WITHIN it
// (`duplicate-node-id`). Nothing checked one tree against ANOTHER, and that is where node
// identity is actually lost.
//
// It is lost silently, because ids are derived by default: `stableId` hashes kind + props,
// so a node keeps its identity only while its props stay byte-identical. Two situations
// depend on that and neither gets a warning today:
//
//   • REVISION — a composer re-emits a view with one prop edited. The edited node is a new
//     node as far as every consumer is concerned: it remounts, and any pin, annotation or
//     agent reference keyed on the old id dangles. (`docs/composed-surfaces.md` says supply
//     an explicit id; this is how you find out you didn't.)
//   • VARIANTS — two trees generated separately are meant to share a set of nodes: the
//     "floor" every variant must contain, a panel a runbook step names. Vary a title
//     between variants and the two trees quietly stop agreeing about what the node IS.
//
// Both reduce to one question — which ids did this change drop? — so this is one function
// over id sets rather than a blueprint-shaped API: the second consumer is A2UI's
// `recompose`, whose components are a flat list, not a Blueprint.
//
// It reports rather than throws, and for the same reason `validateBlueprint` does: dropping
// a node is legitimate (a subtree replacement, a variant that genuinely drops a panel) and
// illegitimate (a re-identification nobody intended), and only the caller knows which.

/** Why a node id went missing. Shares `validateBlueprint`'s vocabulary deliberately. */
export interface IdentityFinding {
  readonly code: "dropped-node-id";
  readonly severity: "error";
  readonly nodeId: string;
  readonly message: string;
}

export interface IdentityReport {
  /** True iff no id present before is missing after. */
  readonly ok: boolean;
  readonly findings: readonly IdentityFinding[];
  /**
   * Ids the change introduced. Not a defect — adding is how a variant sits above a floor,
   * and how a recompose adds a panel — but a `dropped` finding beside an `added` id of the
   * same component is what a RE-IDENTIFICATION looks like, and telling those apart is the
   * caller's job.
   */
  readonly added: readonly string[];
  /**
   * Ids compared (the size of `before`). The denominator: `ok: true` over an empty `before`
   * is not evidence that identity was preserved, and this is how a caller tells.
   */
  readonly compared: number;
}

/**
 * The one total, iterative, pre-order walk behind every id list below. `onWidget` sees each
 * widget id; `onLayout` each WELL-FORMED layout id (IR 2.4.0, ADR 0101) — an absent or malformed
 * one is skipped, exactly as a renderer treats it as absent.
 */
function walkNodeIds(
  blueprint: Blueprint,
  onWidget: ((id: string) => void) | undefined,
  onLayout: ((id: string) => void) | undefined
): void {
  // Iterative, matching `eachNode` in catalog.ts: a deep composed tree must not be able
  // to blow the call stack.
  //
  // Length-driven, not `pop() !== undefined`: a blueprint is data an agent or a composer
  // may have authored, so a layout child CAN legitimately be `undefined` (a malformed
  // `cell(6, undefined)`, a hole from a revision) — and `stack.pop()` returns `undefined`
  // both for "the stack is empty" and for "the next element IS `undefined`". A sentinel
  // loop conflates the two and stops early, silently dropping every id not yet visited.
  // Rejecting the hole is `validateBlueprint`'s job (`malformed-node`); this walk stays
  // total and skips only the one non-object child.
  const stack: unknown[] = [blueprint.layout];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node !== "object" || node === null) continue;
    if ("_tag" in node && (node as Widget)._tag === "Widget") {
      onWidget?.((node as Widget).id);
      continue;
    }
    const layout = node as Layout;
    if (!Array.isArray(layout.children)) continue;
    if (onLayout !== undefined && hasLayoutId(layout)) onLayout(layout.id);
    for (let i = layout.children.length - 1; i >= 0; i--) {
      stack.push(
        layout.type === "grid"
          ? asCell(layout.children[i] as GridCell).node
          : (layout.children[i] as Layout | Widget)
      );
    }
  }
}

/**
 * Every WIDGET id in a blueprint, in pre-order. Duplicates are `validateBlueprint`'s job.
 *
 * Widget-only by contract, also after IR 2.4.0: callers read its output as widget ids (a
 * renderer's remount report, the a2ui bridge's `identityDiff`). Layout ids are
 * `blueprintLayoutIds`; `preservesBlueprintNodes` compares both.
 */
export function blueprintNodeIds(blueprint: Blueprint): string[] {
  const ids: string[] = [];
  walkNodeIds(blueprint, (id) => ids.push(id), undefined);
  return ids;
}

/**
 * Every well-formed LAYOUT id in a blueprint (IR 2.4.0, ADR 0101), in pre-order, the root
 * included. Absent and malformed ids are skipped. Duplicates are `validateBlueprint`'s job.
 */
export function blueprintLayoutIds(blueprint: Blueprint): string[] {
  const ids: string[] = [];
  walkNodeIds(blueprint, undefined, (id) => ids.push(id));
  return ids;
}

/**
 * Which of `before`'s node ids survive into `after`.
 *
 * Two readings, one function:
 * - *"did this revision keep the nodes it kept?"* — `before` is the previous tree;
 * - *"does this variant contain the floor?"* — `before` is the floor's ids, and any finding
 *   is a floor violation. Nodes above the floor land in `added`, which is exactly right:
 *   a variant may add, never subtract.
 *
 * One pass over each side, `Set`-backed: O(|before| + |after|).
 */
export function preservesNodes(before: Iterable<string>, after: Iterable<string>): IdentityReport {
  const afterIds = new Set(after);
  const findings: IdentityFinding[] = [];
  const seen = new Set<string>();

  for (const id of before) {
    // A repeated id in `before` is one node's worth of identity, so report it once —
    // otherwise a duplicated id inflates the finding count for a single lost node.
    if (seen.has(id)) continue;
    seen.add(id);
    if (!afterIds.has(id)) {
      findings.push({
        code: "dropped-node-id",
        severity: "error",
        nodeId: id,
        message: `node "${id}" is present before the change and absent after — either it was removed, or a prop edit re-identified it (ids are derived from kind + props unless supplied explicitly)`,
      });
    }
  }

  const added: string[] = [];
  for (const id of afterIds) {
    if (!seen.has(id)) added.push(id);
  }

  return { ok: findings.length === 0, findings, added, compared: seen.size };
}

/** Widget ids and layout ids together, in one pre-order (document) walk. */
function allNodeIds(blueprint: Blueprint): string[] {
  const ids: string[] = [];
  const push = (id: string) => {
    ids.push(id);
  };
  walkNodeIds(blueprint, push, push);
  return ids;
}

/**
 * `preservesNodes` over two blueprints — the common case, spelled once. Compares widget ids AND
 * layout ids (IR 2.4.0, ADR 0101): they are one identity axis, so a re-identified container is a
 * `dropped-node-id` finding rather than a silent loss of the state under it. A `before` with no
 * layout ids (any pre-2.4.0 artifact) contributes none, so upgrading only adds to `added`.
 */
export function preservesBlueprintNodes(before: Blueprint, after: Blueprint): IdentityReport {
  return preservesNodes(allNodeIds(before), allNodeIds(after));
}
