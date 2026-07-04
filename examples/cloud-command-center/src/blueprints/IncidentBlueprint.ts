import {
  ApprovalCard,
  MetricCard,
  StatusBadge,
  StreamingText,
  Timeline,
  blueprint$,
  grid,
  stack,
} from "@loom/blueprint-runtime";

export const IncidentBlueprint = blueprint$({
  id: "incident-investigation",
  title: "Incident Investigation",
  layout: stack({
    gap: 16,
    children: [
      // A2UI: the flow drives this badge with ctx.ui.set("phase", …) patches.
      StatusBadge({
        title: "Workflow Phase",
        binding: { projectionId: "ui", path: "phase" },
      }),
      grid({
        columns: 2,
        gap: 16,
        children: [
          MetricCard({
            title: "CPU Usage %",
            binding: { projectionId: "metrics", path: "cpu.current" },
            unit: "%",
          }),
          MetricCard({
            title: "Memory Used (MB)",
            binding: { projectionId: "metrics", path: "memory.usedMb" },
            unit: "MB",
          }),
          Timeline({
            title: "Event Timeline",
            binding: { projectionId: "incident", path: "timeline" },
          }),
          ApprovalCard({
            title: "Approve Remediation",
            binding: { projectionId: "incident", path: "pendingApproval" },
            approveLabel: "Apply Fix",
            rejectLabel: "Cancel",
          }),
        ],
      }),
      // A2UI: the LLM effect streams its root-cause analysis into the "ui"
      // surface via patches; this widget re-renders live as tokens arrive.
      StreamingText({
        title: "AI Root-Cause Analysis",
        binding: { projectionId: "ui", path: "aiAnalysis" },
        placeholder: "Awaiting AI triage…",
      }),
    ],
  }),
  projections: ["metrics", "incident", "ui"],
});
