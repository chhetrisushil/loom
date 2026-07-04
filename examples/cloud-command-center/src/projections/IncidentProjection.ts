import type { EventEnvelope } from "@loom/core";

export interface TimelineEntry {
  timestamp: number;
  message: string;
  level: "info" | "warning" | "error";
}

export interface IncidentState {
  incidentId: string;
  status: "investigating" | "awaiting_approval" | "remediating" | "resolved" | "unknown";
  pendingApproval: boolean;
  timeline: TimelineEntry[];
  summary?: string;
}

const initialState: IncidentState = {
  incidentId: "",
  status: "unknown",
  pendingApproval: false,
  timeline: [],
};

export const IncidentProjection = {
  id: "incident",
  initialState,
  handlers: {
    EXECUTION_STARTED: (state: IncidentState, event: EventEnvelope): IncidentState => {
      const payload = event.payload as { input?: { incidentId?: string } };
      return {
        ...state,
        incidentId: payload.input?.incidentId ?? "",
        status: "investigating",
        timeline: [
          ...state.timeline,
          { timestamp: event.timestamp, message: "Investigation started", level: "info" },
        ],
      };
    },
    INCIDENT_ANALYSIS_COMPLETE: (state: IncidentState, event: EventEnvelope): IncidentState => ({
      ...state,
      timeline: [
        ...state.timeline,
        { timestamp: event.timestamp, message: "Analysis complete — awaiting approval", level: "info" },
      ],
    }),
    APPROVAL_REQUESTED: (state: IncidentState, event: EventEnvelope): IncidentState => ({
      ...state,
      status: "awaiting_approval",
      pendingApproval: true,
      timeline: [
        ...state.timeline,
        { timestamp: event.timestamp, message: "Approval requested", level: "warning" },
      ],
    }),
    EXECUTION_RESUMED: (state: IncidentState, event: EventEnvelope): IncidentState => ({
      ...state,
      status: "remediating",
      pendingApproval: false,
      timeline: [
        ...state.timeline,
        { timestamp: event.timestamp, message: "Approval granted — applying remediation", level: "info" },
      ],
    }),
    INCIDENT_RESOLVED: (state: IncidentState, event: EventEnvelope): IncidentState => {
      const payload = event.payload as { summary?: string };
      return {
        ...state,
        status: "resolved",
        timeline: [
          ...state.timeline,
          {
            timestamp: event.timestamp,
            message: `Resolved: ${payload.summary ?? ""}`,
            level: "info",
          },
        ],
        ...(payload.summary !== undefined && { summary: payload.summary }),
      };
    },
  },
};
