// NgZone must be a VALUE import, not `type NgZone` — it is the constructor's DI
// token, and a type-only import is erased at runtime, so Angular's dev transform
// can't build the factory ("constructor was not compatible with Dependency
// Injection"). AOT hides this because ngtsc resolves the token statically.
import { Injectable, type NgZone, signal } from "@angular/core";
import { defineConfig } from "@loom/app";
import type { EventEnvelope } from "@loom/core";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { ConsoleTelemetryAdapter } from "@loom/telemetry";
import type { RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import {
  type IncidentInput,
  InvestigateIncidentFlow,
  type LogData,
  type MetricsData,
} from "./incident.flow";

// This composition root uses `defineConfig` from @loom/app. @loom/app lazy-loads
// the SQLite stores (behind an opaque require + the `/memory` subpath), so
// `storage.kind:"memory"` pulls NO better-sqlite3 / node:fs into this browser
// bundle — the same reason the React / Web-Components examples stay clean.

// ── Domain types ──────────────────────────────────────────────────────────────

export type Phase = "idle" | "running" | "suspended" | "completed" | "failed";

export interface IncidentState {
  incidentId: string;
  metrics: MetricsData | null;
  logs: LogData | null;
  pendingApproval: boolean;
  summary: string | null;
}

export interface LogEntry {
  // Unique per event (executionId-sequence) — used as the @for track key, since
  // time+label collides for same-type events within the same second.
  id: string;
  time: string;
  label: string;
  payload: unknown;
}

const initialState: IncidentState = {
  incidentId: "",
  metrics: null,
  logs: null,
  pendingApproval: false,
  summary: null,
};

// ── Projection ────────────────────────────────────────────────────────────────

const IncidentProjection = {
  id: "incident",
  initialState,
  handlers: {
    INCIDENT_STARTED: (state: IncidentState, e: EventEnvelope): IncidentState => ({
      ...state,
      incidentId: (e.payload as { incidentId: string }).incidentId,
    }),
    ANALYSIS_COMPLETE: (state: IncidentState, e: EventEnvelope): IncidentState => {
      const p = e.payload as { metrics: MetricsData; logs: LogData };
      return { ...state, metrics: p.metrics, logs: p.logs };
    },
    APPROVAL_REQUESTED: (state: IncidentState): IncidentState => ({
      ...state,
      pendingApproval: true,
    }),
    EXECUTION_RESUMED: (state: IncidentState): IncidentState => ({
      ...state,
      pendingApproval: false,
    }),
    INCIDENT_RESOLVED: (state: IncidentState, e: EventEnvelope): IncidentState => ({
      ...state,
      summary: (e.payload as { summary: string }).summary,
      pendingApproval: false,
    }),
  },
};

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable({ providedIn: "root" })
export class LoomService {
  // ── Runtimes (private — framework code never touches these) ───────────────
  private readonly projectionRuntime = new InMemoryProjectionRuntime();
  private readonly workflowRuntime: WorkflowRuntime;

  // ── Angular signals — reactive state exposed to the template ──────────────
  readonly phase = signal<Phase>("idle");
  readonly executionId = signal<string | null>(null);
  readonly incidentState = signal<IncidentState | null>(null);
  readonly eventLog = signal<LogEntry[]>([]);

  constructor(private readonly zone: NgZone) {
    this.projectionRuntime.register(IncidentProjection);

    // defineConfig assembles the stores (in-memory), EffectRuntime, projection
    // wiring (onEvent → handleEvent), telemetry, and the WorkflowRuntime, and
    // registers the flow. We keep the custom projection runtime + an extra
    // onEvent observer to push folded state into Angular signals inside the zone.
    const app = defineConfig({
      storage: { kind: "memory" },
      projectionRuntime: this.projectionRuntime,
      telemetry: [ConsoleTelemetryAdapter],
      flows: [InvestigateIncidentFlow as RegisteredFlow],
      onEvent: (e: EventEnvelope) => {
        // Run inside Angular zone so signal updates trigger change detection.
        this.zone.run(() => {
          const execId = this.executionId();
          if (execId) {
            const st = this.projectionRuntime.getState<IncidentState>("incident", execId);
            if (st) this.incidentState.set({ ...st });
          }

          this.eventLog.update((prev) => [
            ...prev,
            {
              id: e.id,
              time: new Date().toLocaleTimeString("en", { hour12: false }),
              label: e.eventType,
              payload: e.payload,
            },
          ]);
        });
      },
    });

    this.workflowRuntime = app.runtime;
  }

  async startInvestigation(incidentId: string): Promise<void> {
    this.phase.set("running");
    this.eventLog.set([]);
    this.incidentState.set(null);

    try {
      const handle = await this.workflowRuntime.start<IncidentInput>(InvestigateIncidentFlow, {
        incidentId,
      });

      this.zone.run(() => this.executionId.set(handle.executionId));

      handle.waitForSuspend().then(() => {
        this.zone.run(() => this.phase.set("suspended"));
      });

      handle.waitForCompletion().then((state) => {
        this.zone.run(() => {
          if (state.status === "completed") this.phase.set("completed");
        });
      });
    } catch (err) {
      this.zone.run(() => this.phase.set("failed"));
      console.error("[loom:angular] start failed", err);
    }
  }

  async approve(): Promise<void> {
    const execId = this.executionId();
    if (!execId) return;

    this.phase.set("running");

    try {
      const handle = await this.workflowRuntime.resume(execId, {
        eventType: "ApprovalGranted",
        payload: { approvedBy: "angular-operator", approvedAt: Date.now() },
      });

      handle.waitForCompletion().then((state) => {
        this.zone.run(() => {
          if (state.status === "completed") this.phase.set("completed");
        });
      });
    } catch (err) {
      this.zone.run(() => this.phase.set("failed"));
      console.error("[loom:angular] resume failed", err);
    }
  }

  reset(): void {
    this.phase.set("idle");
    this.executionId.set(null);
    this.incidentState.set(null);
    this.eventLog.set([]);
  }
}
