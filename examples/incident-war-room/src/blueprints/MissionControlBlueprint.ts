import { blueprint$, grid, stack } from "@loom/blueprint-runtime";
import {
  AgentTaskList,
  ConsoleLog,
  PhaseBanner,
  PlanFlow,
  RiskApproval,
} from "../widgets/customWidgets";

// ── Mission Control blueprint ─────────────────────────────────────────────────
//
// Declarative UI bound to the "mission" A2UI surface. Every binding is a slice
// the Orchestrator drives in near-real-time; with the fiber renderer's granular
// updates, only the widget whose slice changed re-renders (e.g. one task row),
// not the whole tree. All five widgets are custom (BYOC) kinds.
export const MissionControlBlueprint = blueprint$({
  id: "mission-control",
  title: "Mission Control",
  layout: stack({
    gap: 14,
    children: [
      PhaseBanner({ projectionId: "mission", path: "phase" }, "Mission Phase"),
      PlanFlow({ projectionId: "mission", path: "plan" }, "Dynamically Composed Workflow"),
      grid({
        columns: 2,
        gap: 14,
        children: [
          AgentTaskList({ projectionId: "mission", path: "tasks" }, "Agent Tasks (live)"),
          stack({
            gap: 14,
            children: [
              RiskApproval(
                { projectionId: "mission", path: "pendingApproval" },
                "Human-in-the-Loop"
              ),
              ConsoleLog({ projectionId: "telemetry", path: "log" }, "Live Agent Console"),
            ],
          }),
        ],
      }),
    ],
  }),
  projections: ["mission", "telemetry"],
});
