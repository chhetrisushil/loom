import {
  ApprovalCard,
  MetricCard,
  Timeline,
  blueprint$,
  grid,
  stack,
} from "@loom/blueprint-runtime";

export const TaskBlueprint = blueprint$({
  id: "task-dashboard",
  title: "Task Analysis Dashboard",
  layout: stack({
    gap: 24,
    children: [
      grid({
        columns: 3,
        gap: 16,
        children: [
          MetricCard({
            title: "Items Found",
            binding: { projectionId: "task", path: "items" },
            unit: "items",
          }),
          MetricCard({
            title: "Processed",
            binding: { projectionId: "task", path: "processed" },
            unit: "items",
          }),
          MetricCard({
            title: "Score",
            binding: { projectionId: "task", path: "score" },
          }),
        ],
      }),
      grid({
        columns: 2,
        gap: 16,
        children: [
          Timeline({
            title: "Event Timeline",
            binding: { projectionId: "task", path: "timeline" },
            maxItems: 20,
          }),
          ApprovalCard({
            title: "Approve Task Result",
            binding: { projectionId: "task", path: "pendingApproval" },
            approveLabel: "Approve & Apply",
            rejectLabel: "Reject",
          }),
        ],
      }),
    ],
  }),
  projections: ["task"],
});
