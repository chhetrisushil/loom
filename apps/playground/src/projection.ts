import type { EventEnvelope } from "@loom/core";

export interface TaskState {
  taskId: string;
  label: string;
  status: "idle" | "fetching" | "processing" | "awaiting_approval" | "applying" | "done";
  items: number | null;
  processed: number | null;
  score: number | null;
  summary: string | null;
  pendingApproval: boolean;
  timeline: { message: string; timestamp: number; level: "info" | "warning" | "success" }[];
}

const initial: TaskState = {
  taskId: "",
  label: "",
  status: "idle",
  items: null,
  processed: null,
  score: null,
  summary: null,
  pendingApproval: false,
  timeline: [],
};

function addEntry(
  state: TaskState,
  message: string,
  level: TaskState["timeline"][number]["level"],
  timestamp: number
): TaskState {
  return {
    ...state,
    timeline: [...state.timeline, { message, timestamp, level }],
  };
}

export const TaskProjection = {
  id: "task",
  initialState: initial,
  handlers: {
    EXECUTION_STARTED: (state: TaskState, e: EventEnvelope): TaskState =>
      addEntry({ ...state, status: "fetching" }, "Execution started", "info", e.timestamp),

    TASK_STARTED: (state: TaskState, e: EventEnvelope): TaskState => {
      const p = e.payload as { taskId: string; label: string };
      return addEntry(
        { ...state, taskId: p.taskId, label: p.label, status: "fetching" },
        `Task "${p.label}" started`,
        "info",
        e.timestamp
      );
    },

    DATA_FETCHED: (state: TaskState, e: EventEnvelope): TaskState => {
      const p = e.payload as { items: number; source: string };
      return addEntry(
        { ...state, items: p.items, status: "processing" },
        `Fetched ${p.items} items from ${p.source}`,
        "info",
        e.timestamp
      );
    },

    DATA_PROCESSED: (state: TaskState, e: EventEnvelope): TaskState => {
      const p = e.payload as { processed: number; score: number };
      return addEntry(
        { ...state, processed: p.processed, score: p.score },
        `Processed ${p.processed} items — score ${p.score}`,
        "info",
        e.timestamp
      );
    },

    APPROVAL_REQUESTED: (state: TaskState, e: EventEnvelope): TaskState =>
      addEntry(
        { ...state, status: "awaiting_approval", pendingApproval: true },
        "Approval requested",
        "warning",
        e.timestamp
      ),

    EXECUTION_RESUMED: (state: TaskState, e: EventEnvelope): TaskState =>
      addEntry(
        { ...state, status: "applying", pendingApproval: false },
        "Approval granted — applying result",
        "info",
        e.timestamp
      ),

    TASK_COMPLETED: (state: TaskState, e: EventEnvelope): TaskState => {
      const p = e.payload as { summary: string };
      return addEntry(
        { ...state, status: "done", summary: p.summary },
        `Done: ${p.summary}`,
        "success",
        e.timestamp
      );
    },
  },
};
