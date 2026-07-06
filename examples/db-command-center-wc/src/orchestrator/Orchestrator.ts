import { createA2UIEmitter } from "@loom/a2ui";
import type { A2UIEmitter } from "@loom/a2ui";
import type { InProcessA2ABus } from "@loom/app";
import type { ApprovalDecision } from "@loom/app";
import type { CapabilityCatalog } from "@loom/capability";
import type { EventEnvelope } from "@loom/core";
import { IntentRuntime } from "@loom/intent";
import { PlannerRuntime } from "@loom/planner";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import type { WorkflowRuntime } from "@loom/workflow-runtime";
import { AGENT_CARDS, CAPABILITY_AGENT, FLEET } from "../agents/definitions";
import type {
  AgentTask,
  Diagnosis,
  PendingApproval,
  PlanEntry,
  RemediationAssessment,
  RiskLevel,
  TaskStatus,
} from "../domain";
import { llm } from "../runtime/services";

export interface OrchestratorDeps {
  projectionRuntime: ProjectionRuntime;
  missionRuntime: WorkflowRuntime;
  catalog: CapabilityCatalog;
  bus: InProcessA2ABus;
  missionId: string;
}

interface MissionModel {
  goal: string;
  phase: string;
  plan: PlanEntry[];
  tasks: AgentTask[];
  pendingApproval: PendingApproval | null;
  summary: string;
}

// Mutating capabilities that reach a durable approval checkpoint.
const MUTATING = new Set(["apply-remediation", "scale-read-replicas"]);

// ── Orchestrator ──────────────────────────────────────────────────────────────
//
// The command center's conductor. It turns a natural-language goal into a
// dynamically-composed workflow (PlannerRuntime), dispatches each step to the
// owning domain agent over the A2A bus, tracks every agent task in near-real-time
// on the "mission" surface, streams telemetry to the "telemetry" surface, and
// enforces the human-in-the-loop policy encoded in the goal
// ("…fix it if low risk, else wait for my approval").
export class Orchestrator {
  private readonly planner: PlannerRuntime;
  private readonly intent: IntentRuntime;
  private readonly mission: A2UIEmitter;
  private readonly telemetry: A2UIEmitter;
  private seq = 0;
  // A per-run nonce so each mission run gets globally-unique flow execution ids.
  // The mission id is fixed (one active mission), so without this a re-run reuses
  // execution ids like "task-1-assess-remediation" and collides with the durable
  // event log — harmless in-memory, a UNIQUE-constraint error on SQLite.
  private runSeq = 0;
  private runId = "r0";

  private model: MissionModel = {
    goal: "",
    phase: "idle",
    plan: [],
    tasks: [],
    pendingApproval: null,
    summary: "",
  };

  // Resolver for the current human approval, if one is pending.
  private approvalResolver: ((decision: ApprovalDecision) => void) | null = null;

  constructor(private readonly deps: OrchestratorDeps) {
    this.planner = new PlannerRuntime({ catalog: deps.catalog, provider: llm });
    this.intent = new IntentRuntime({ catalog: deps.catalog, provider: llm });
    this.mission = createA2UIEmitter((t, p) => this.emit(t, p), "mission");
    this.telemetry = createA2UIEmitter((t, p) => this.emit(t, p), "telemetry");
  }

  // ── Public control surface (called by the React app) ────────────────────────

  isBusy(): boolean {
    return this.model.phase !== "idle" && !this.isTerminal();
  }

  resolveApproval(approved: boolean): void {
    const resolver = this.approvalResolver;
    if (!resolver) return;
    this.approvalResolver = null;
    this.model.pendingApproval = null;
    this.mission.set("pendingApproval", null);
    resolver({ approved, approvedBy: "operator" });
  }

  // Kick off a mission for a natural-language goal.
  async run(goal: string): Promise<void> {
    this.runId = `${Date.now().toString(36)}-${(this.runSeq++).toString(36)}`;
    this.resetSurfaces(goal);
    this.seedFleet();

    // Intent Over Routes — show the primary capability the goal routes to.
    const route = await this.intent.route(goal);
    this.log(
      `Intent routed "${goal}" → ${route?.capability.id ?? "(none)"} (${route?.rationale ?? "n/a"}).`
    );

    // Dynamic workflow: the Planner composes an ordered capability pipeline.
    this.setPhase("planning");
    const plan = await this.planner.plan(goal);
    this.log(`Planner composed a ${plan.steps.length}-step workflow from the goal.`);

    const domain = this.domainOf(goal);
    const target = "prod-postgres";

    this.model.plan = plan.steps.map(
      (s): PlanEntry => ({
        capabilityId: s.capabilityId,
        agentId: CAPABILITY_AGENT[s.capabilityId] ?? "unknown",
        title: this.titleOf(s.capabilityId),
        ...(s.rationale !== undefined && { rationale: s.rationale }),
        status: "queued",
      })
    );
    this.mission.set("plan", this.model.plan);

    this.setPhase("dispatching");

    // Carries results between steps (diagnosis → assessment → apply).
    let assessment: RemediationAssessment | null = null;

    for (let i = 0; i < this.model.plan.length; i++) {
      const entry = this.model.plan[i];
      if (!entry) continue;
      const stepArtifact = await this.runStep(entry, i, { target, domain, assessment, goal });
      if (entry.capabilityId === "assess-remediation") {
        assessment = stepArtifact as RemediationAssessment;
      }
      if (this.isTerminal()) return; // operator rejected → stop the pipeline
    }

    this.setPhase("resolved");
    this.mission.set("summary", this.model.summary || "Mission complete — incident resolved.");
    this.telemetry.merge("fleet", fleetIdle());
  }

  // ── Step execution over A2A ─────────────────────────────────────────────────

  private async runStep(
    entry: PlanEntry,
    index: number,
    ctx: {
      target: string;
      domain: "cpu" | "replica";
      assessment: RemediationAssessment | null;
      goal: string;
    }
  ): Promise<unknown> {
    const agentId = entry.agentId;
    const agentName = AGENT_CARDS[agentId]?.name ?? agentId;
    const taskId = `task-${this.runId}-${index}-${entry.capabilityId}`;

    const task: AgentTask = {
      id: taskId,
      agentId,
      agentName,
      capabilityId: entry.capabilityId,
      title: entry.title,
      status: "queued",
      detail: "Dispatched over A2A…",
      progress: [],
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.model.tasks = [...this.model.tasks, task];
    this.syncTasks();
    this.updatePlanStatus(entry.capabilityId, "working");
    this.telemetry.merge("fleet", {
      [agentId]: { status: "busy", handled: fleetHandled(agentId, this.model) },
    });

    const input = this.inputFor(entry.capabilityId, ctx);
    const prompt = `${entry.title} for ${ctx.target}`;

    const result = await this.deps.bus.dispatch(entry.capabilityId, input, prompt, {
      executionId: taskId,
      onProgress: (line) => this.onTaskProgress(taskId, line),
      onStatus: (status) => this.onTaskStatus(taskId, status),
      onApproval: MUTATING.has(entry.capabilityId)
        ? () => this.gate(taskId, entry, ctx)
        : undefined,
    });

    // Fold the artifact into the domain surfaces.
    this.absorbArtifact(entry.capabilityId, result.artifact);

    const applied = isApplyResult(result.artifact) ? result.artifact.applied : true;
    const finalStatus: TaskStatus =
      result.status === "failed" ? "failed" : applied ? "completed" : "cancelled";
    this.patchTask(taskId, { status: finalStatus, detail: summarize(result.artifact) });
    this.updatePlanStatus(entry.capabilityId, finalStatus);
    this.telemetry.merge("fleet", {
      [agentId]: { status: "idle", handled: fleetHandled(agentId, this.model) },
    });

    if (finalStatus === "cancelled") {
      this.setPhase("rejected");
      this.model.summary = "Operator rejected the remediation — no changes applied.";
      this.mission.set("summary", this.model.summary);
    }
    return result.artifact;
  }

  // The human-in-the-loop / risk gate. Encodes the goal's policy: auto-apply a
  // low-risk remediation; otherwise surface an approval card and wait for a
  // human. Returns the decision that resumes the durably-suspended flow.
  private gate(
    taskId: string,
    entry: PlanEntry,
    ctx: { assessment: RemediationAssessment | null; goal: string }
  ): Promise<ApprovalDecision> {
    const risk: RiskLevel = ctx.assessment?.riskLevel ?? "medium";
    const action = ctx.assessment?.action ?? entry.title;
    const rationale = ctx.assessment?.rationale ?? "";
    // The goal itself encodes the policy: "…fix it if remediation is low risk".
    const autoAllowed = /low risk|automatically|auto[- ]?fix|auto/i.test(ctx.goal);

    if (risk === "low" && autoAllowed) {
      this.log(`Risk is LOW — auto-applying "${action}" under the risk policy.`);
      return Promise.resolve({ approved: true, approvedBy: "risk-policy" });
    }

    // Manual approval required → surface it and wait for the operator.
    this.log(`Risk is ${risk.toUpperCase()} — pausing for operator approval.`);
    this.patchTask(taskId, { status: "awaiting-approval", detail: `Awaiting approval: ${action}` });
    this.setPhase("awaiting-approval");
    const pending: PendingApproval = {
      taskId,
      agentId: entry.agentId,
      title: entry.title,
      action,
      risk,
      rationale,
    };
    this.model.pendingApproval = pending;
    this.mission.set("pendingApproval", pending);

    return new Promise<ApprovalDecision>((resolve) => {
      this.approvalResolver = resolve;
    });
  }

  // ── Artifact → surface folding ──────────────────────────────────────────────

  private absorbArtifact(capabilityId: string, artifact: unknown): void {
    if (capabilityId.startsWith("diagnose")) {
      const d = artifact as Diagnosis;
      this.telemetry.merge("metrics", d.metrics);
      if (typeof d.metrics.cpuPct === "number")
        this.telemetry.append("history.cpu", d.metrics.cpuPct);
      if (typeof d.metrics.lagMs === "number")
        this.telemetry.append("history.lag", d.metrics.lagMs);
      this.model.summary = d.rootCause;
      this.mission.set("summary", d.rootCause);
    } else if (isApplyResult(artifact) && artifact.applied) {
      // Reflect the post-fix metric so the observability gauges recover.
      if (typeof artifact.newCpuPct === "number") {
        this.telemetry.merge("metrics", { cpuPct: artifact.newCpuPct });
        this.telemetry.append("history.cpu", artifact.newCpuPct);
      }
      if (typeof artifact.newLagMs === "number") {
        this.telemetry.merge("metrics", { lagMs: artifact.newLagMs });
        this.telemetry.append("history.lag", artifact.newLagMs);
      }
      this.model.summary = artifact.summary;
      this.mission.set("summary", artifact.summary);
    }
  }

  private inputFor(
    capabilityId: string,
    ctx: { target: string; domain: "cpu" | "replica" }
  ): unknown {
    switch (capabilityId) {
      case "assess-remediation":
        return { target: ctx.target, domain: ctx.domain };
      case "scale-read-replicas":
        return { target: ctx.target, addReplicas: 2 };
      default:
        return { target: ctx.target };
    }
  }

  // ── Near-real-time task/plan/telemetry updates ──────────────────────────────

  private onTaskProgress(taskId: string, line: string): void {
    const task = this.model.tasks.find((t) => t.id === taskId);
    if (!task) return;
    task.progress = [...task.progress, line];
    task.detail = line;
    task.updatedAt = Date.now();
    this.syncTasks();
    this.telemetry.append("log", `[${task.agentName}] ${line}`);
  }

  private onTaskStatus(taskId: string, status: string): void {
    const mapped: TaskStatus =
      status === "working"
        ? "working"
        : status === "completed"
          ? "completed"
          : status === "failed"
            ? "failed"
            : "queued";
    // Don't clobber the richer "awaiting-approval" state the gate set.
    const task = this.model.tasks.find((t) => t.id === taskId);
    if (task && task.status === "awaiting-approval" && status === "working") return;
    this.patchTask(taskId, { status: mapped });
  }

  private patchTask(taskId: string, patch: Partial<AgentTask>): void {
    this.model.tasks = this.model.tasks.map((t) =>
      t.id === taskId ? { ...t, ...patch, updatedAt: Date.now() } : t
    );
    this.syncTasks();
  }

  private updatePlanStatus(capabilityId: string, status: TaskStatus): void {
    this.model.plan = this.model.plan.map((p) =>
      p.capabilityId === capabilityId ? { ...p, status } : p
    );
    this.mission.set("plan", this.model.plan);
  }

  private syncTasks(): void {
    this.mission.set("tasks", this.model.tasks);
  }

  // ── Surface + telemetry bootstrap ───────────────────────────────────────────

  private resetSurfaces(goal: string): void {
    this.model = {
      goal,
      phase: "planning",
      plan: [],
      tasks: [],
      pendingApproval: null,
      summary: "",
    };
    this.approvalResolver = null;
    this.mission.set("", {
      goal,
      phase: "planning",
      plan: [],
      tasks: [],
      pendingApproval: null,
      summary: "",
    });
    this.telemetry.set("", {
      metrics: { cpuPct: 91, memPct: 68, lagMs: this.domainOf(goal) === "replica" ? 4200 : 0 },
      history: { cpu: [88, 90, 91], lag: [3800, 4000, 4200] },
      fleet: {},
      log: [],
    });
  }

  private seedFleet(): void {
    const fleet: Record<string, { status: string; handled: number }> = {};
    for (const agent of FLEET) fleet[agent.id] = { status: "idle", handled: 0 };
    this.telemetry.set("fleet", fleet);
  }

  private setPhase(phase: string): void {
    this.model.phase = phase;
    this.mission.set("phase", phase);
  }

  private log(line: string): void {
    this.telemetry.append("log", `[orchestrator] ${line}`);
  }

  private isTerminal(): boolean {
    return this.model.phase === "resolved" || this.model.phase === "rejected";
  }

  private domainOf(goal: string): "cpu" | "replica" {
    return /replica|lag|replication/i.test(goal) ? "replica" : "cpu";
  }

  private titleOf(capabilityId: string): string {
    const cap = this.deps.catalog.get(capabilityId);
    return cap?.name ?? capabilityId;
  }

  // Emit an A2UI patch event straight into the projection runtime under the
  // mission's execution id (the surfaces are orchestrator-owned view state).
  private emit(eventType: string, payload: unknown): void {
    const envelope: EventEnvelope = {
      id: `${this.deps.missionId}-${this.seq}`,
      workflowId: this.deps.missionId,
      executionId: this.deps.missionId,
      eventType,
      sequence: this.seq++,
      timestamp: Date.now(),
      payload,
    };
    this.deps.projectionRuntime.handleEvent(envelope);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

interface ApplyResult {
  applied: boolean;
  summary: string;
  newCpuPct?: number;
  newLagMs?: number;
}

function isApplyResult(v: unknown): v is ApplyResult {
  return typeof v === "object" && v !== null && "applied" in v;
}

function summarize(artifact: unknown): string {
  if (isApplyResult(artifact)) return artifact.summary;
  if (artifact && typeof artifact === "object" && "rootCause" in artifact) {
    return String((artifact as Diagnosis).rootCause);
  }
  if (artifact && typeof artifact === "object" && "action" in artifact) {
    const a = artifact as RemediationAssessment;
    return `${a.action} — risk ${a.riskLevel}`;
  }
  return "done";
}

function fleetHandled(agentId: string, model: MissionModel): number {
  return model.tasks.filter((t) => t.agentId === agentId).length;
}

function fleetIdle(): Record<string, { status: string }> {
  return {
    "diagnostics-agent": { status: "idle" },
    "remediation-agent": { status: "idle" },
    "capacity-agent": { status: "idle" },
  };
}
