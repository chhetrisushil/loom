import { CapabilityCatalog, capability$ } from "@loom/capability";
import { z } from "zod";
import {
  ApplyRemediationFlow,
  AssessRemediationFlow,
  DiagnoseCpuFlow,
  DiagnoseReplicaFlow,
  ScaleReplicasFlow,
} from "./flows";

// ── Capability catalog ────────────────────────────────────────────────────────
//
// The intent-addressable vocabulary the Planner and Intent runtimes compose over
// ("Capabilities over APIs"). Each capability wraps one of the durable flows and
// carries the natural-language `intent` + `tags` used for offline routing and,
// with a provider, LLM planning.

export const DiagnoseCpuCapability = capability$({
  id: "diagnose-cpu",
  name: "Diagnose CPU",
  intent: "Find why CPU utilization is high on a database and identify the root cause",
  tags: ["cpu", "utilization", "diagnose", "performance", "database", "postgres"],
  inputSchema: z.object({ target: z.string() }),
  flow: DiagnoseCpuFlow,
});

export const DiagnoseReplicaCapability = capability$({
  id: "diagnose-replica-lag",
  name: "Diagnose Replica Lag",
  intent: "Investigate read-replica replication lag and locate the bottleneck",
  tags: ["replica", "replication", "lag", "read-replica", "diagnose", "database"],
  inputSchema: z.object({ target: z.string() }),
  flow: DiagnoseReplicaFlow,
});

export const AssessRemediationCapability = capability$({
  id: "assess-remediation",
  name: "Assess Remediation",
  intent: "Weigh the risk of a proposed remediation before it is applied",
  tags: ["remediation", "risk", "assess", "safety"],
  inputSchema: z.object({ target: z.string(), domain: z.string() }),
  flow: AssessRemediationFlow,
});

export const ApplyRemediationCapability = capability$({
  id: "apply-remediation",
  name: "Apply Remediation",
  intent: "Apply a low-risk remediation to fix high CPU, with human approval when required",
  tags: ["remediation", "fix", "apply", "cpu", "pool", "restart"],
  inputSchema: z.object({ target: z.string() }),
  flow: ApplyRemediationFlow,
});

export const ScaleReplicasCapability = capability$({
  id: "scale-read-replicas",
  name: "Scale Read Replicas",
  intent: "Add read-replica capacity to reduce replication lag, with human approval when required",
  tags: ["scale", "replica", "capacity", "lag", "fix", "apply"],
  inputSchema: z.object({ target: z.string(), addReplicas: z.number() }),
  flow: ScaleReplicasFlow,
});

export function buildCatalog(): CapabilityCatalog {
  return new CapabilityCatalog()
    .register(DiagnoseCpuCapability)
    .register(DiagnoseReplicaCapability)
    .register(AssessRemediationCapability)
    .register(ApplyRemediationCapability)
    .register(ScaleReplicasCapability);
}
