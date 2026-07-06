import { blueprint$, grid, stack } from "@loom/blueprint-runtime";
import { BranchControls, BranchDiff, BranchGraph } from "../widgets/customWidgets";

// ── Migration Board blueprint ─────────────────────────────────────────────────
//
// Declarative UI bound to the "branch" A2UI surface — the git-style branching
// experience. The graph and diff bind to slices the BranchOrchestrator drives in
// near-real-time as speculative forks resolve (including the live backfill
// progress bars); the controls dispatch EXPLORE / PROMOTE widget actions back to
// the server. All three are custom (BYOC) kinds.
export const MigrationBoardBlueprint = blueprint$({
  id: "migration-board",
  title: "Migration Board — Branch · Simulate · Promote",
  layout: stack({
    gap: 14,
    children: [
      BranchControls({ projectionId: "branch", path: "" }, "Migration Strategies (no merge)"),
      grid({
        columns: 2,
        gap: 14,
        children: [
          BranchGraph({ projectionId: "branch", path: "" }, "Strategy Branches"),
          BranchDiff({ projectionId: "branch", path: "branches" }, "Projected Outcomes"),
        ],
      }),
    ],
  }),
  projections: ["branch"],
});
