import { CapabilityCatalog, capability$ } from "@loom/capability";
import { z } from "zod";
import {
  ApplyMigrationFlow,
  AssessMigrationFlow,
  DiagnoseSchemaFlow,
  PlanMigrationFlow,
} from "./flows";

// ── Capability catalog ────────────────────────────────────────────────────────
//
// The intent-addressable vocabulary the Planner and Intent runtimes compose over
// ("Capabilities over APIs"). Each capability wraps one of the durable flows and
// carries the natural-language `intent` + `tags` used for offline routing and,
// with a provider, LLM planning.

export const DiagnoseSchemaCapability = capability$({
  id: "diagnose-schema",
  name: "Diagnose Schema",
  intent: "Analyze a target table's size, indexes, constraints and write load before a migration",
  tags: ["schema", "table", "inspect", "diagnose", "migration", "database"],
  inputSchema: z.object({ target: z.string() }),
  flow: DiagnoseSchemaFlow,
});

export const AssessMigrationCapability = capability$({
  id: "assess-migration",
  name: "Assess Migration",
  intent: "Weigh the risk of a proposed schema migration before it is applied",
  tags: ["migration", "risk", "assess", "safety", "schema"],
  inputSchema: z.object({ target: z.string(), complex: z.boolean() }),
  flow: AssessMigrationFlow,
});

export const ApplyMigrationCapability = capability$({
  id: "apply-migration",
  name: "Apply Migration",
  intent: "Apply a low-risk, metadata-only schema change, with human approval when required",
  tags: ["migration", "apply", "column", "metadata", "schema"],
  inputSchema: z.object({ target: z.string() }),
  flow: ApplyMigrationFlow,
});

export const PlanMigrationCapability = capability$({
  id: "plan-migration",
  name: "Plan Migration",
  intent:
    "Plan a large-table migration by comparing mutually-exclusive strategies before committing",
  tags: ["migration", "plan", "strategy", "backfill", "large-table", "schema"],
  inputSchema: z.object({ target: z.string() }),
  flow: PlanMigrationFlow,
});

export function buildCatalog(): CapabilityCatalog {
  return new CapabilityCatalog()
    .register(DiagnoseSchemaCapability)
    .register(AssessMigrationCapability)
    .register(ApplyMigrationCapability)
    .register(PlanMigrationCapability);
}
