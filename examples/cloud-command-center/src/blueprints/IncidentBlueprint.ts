import {
  ApprovalCard,
  MetricCard,
  Timeline,
  blueprint$,
  grid,
} from "@loom/blueprint-runtime";

export const IncidentBlueprint = blueprint$({
  id: "incident-investigation",
  title: "Incident Investigation",
  layout: grid({
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
  projections: ["metrics", "incident"],
});
