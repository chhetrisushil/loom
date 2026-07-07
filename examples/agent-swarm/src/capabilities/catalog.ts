import { CapabilityCatalog, capability$ } from "@loom/capability";
import { z } from "zod";
import {
  DepsAuditFlow,
  PerfAuditFlow,
  RecordPlanFlow,
  ScopeAuditFlow,
  SecurityAuditFlow,
  SignoffReleaseFlow,
} from "./flows";

// The intent-addressable vocabulary the Planner + Intent runtimes compose over.
// Registering every flow here is what makes it resolvable by BOTH the A2A bus
// (registerCapability) AND executeGraph (runtime.getFlow(flowId)).

const svcRel = z.object({ service: z.string(), release: z.string() });
const withScope = svcRel.extend({ scope: z.record(z.unknown()) });

export const RecordPlanCapability = capability$({
  id: "record-plan",
  name: "Record Plan",
  intent: "Durably record the composed audit plan into the event log",
  tags: ["plan", "record", "audit-trail"],
  inputSchema: z.object({
    goal: z.string(),
    service: z.string(),
    release: z.string(),
    steps: z.array(z.unknown()),
  }),
  flow: RecordPlanFlow,
});
export const ScopeAuditCapability = capability$({
  id: "scope-audit",
  name: "Scope Audit",
  intent: "Establish what changed in a release and which surfaces are at risk",
  tags: ["scope", "audit", "release", "changes"],
  inputSchema: svcRel,
  flow: ScopeAuditFlow,
});
export const SecurityAuditCapability = capability$({
  id: "security-audit",
  name: "Security Audit",
  intent: "Scan a release for vulnerabilities and misconfigurations",
  tags: ["security", "vulnerability", "scan", "audit"],
  inputSchema: withScope,
  flow: SecurityAuditFlow,
});
export const PerfAuditCapability = capability$({
  id: "perf-audit",
  name: "Performance Audit",
  intent: "Check a release for performance regressions against budget",
  tags: ["performance", "regression", "budget", "audit"],
  inputSchema: withScope,
  flow: PerfAuditFlow,
});
export const DepsAuditCapability = capability$({
  id: "deps-audit",
  name: "Dependencies Audit",
  intent: "Audit dependency freshness and security advisories for a release",
  tags: ["dependencies", "deps", "advisories", "audit"],
  inputSchema: withScope,
  flow: DepsAuditFlow,
});
export const SignoffReleaseCapability = capability$({
  id: "signoff-release",
  name: "Sign off Release",
  intent: "Gate a release on combined risk, with human approval when required",
  tags: ["signoff", "release", "gate", "approve", "risk"],
  inputSchema: z.object({
    service: z.string(),
    release: z.string(),
    risk: z.string(),
    rationale: z.string(),
  }),
  flow: SignoffReleaseFlow,
});

export const CAPABILITIES = [
  RecordPlanCapability,
  ScopeAuditCapability,
  SecurityAuditCapability,
  PerfAuditCapability,
  DepsAuditCapability,
  SignoffReleaseCapability,
];

export function buildCatalog(): CapabilityCatalog {
  const catalog = new CapabilityCatalog();
  for (const cap of CAPABILITIES) catalog.register(cap);
  return catalog;
}
