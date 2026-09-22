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

/** Every widget id in a blueprint, in pre-order. Duplicates are `validateBlueprint`'s job. */
export function blueprintNodeIds(blueprint: Blueprint): string[] {
  const ids: string[] = [];
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
      ids.push((node as Widget).id);
      continue;
    }
    const layout = node as Layout;
    if (!Array.isArray(layout.children)) continue;
    for (let i = layout.children.length - 1; i >= 0; i--) {
      stack.push(
        layout.type === "grid"
          ? asCell(layout.children[i] as GridCell).node
          : (layout.children[i] as Layout | Widget)
      );
    }
  }
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

/** `preservesNodes` over two blueprints — the common case, spelled once. */
export function preservesBlueprintNodes(before: Blueprint, after: Blueprint): IdentityReport {
  return preservesNodes(blueprintNodeIds(before), blueprintNodeIds(after));
}
