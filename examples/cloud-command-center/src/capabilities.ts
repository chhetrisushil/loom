import { z } from "zod";
import { capability$, CapabilityCatalog } from "@loom/capability";
import { InvestigateIncidentFlow } from "./flows/InvestigateIncident";

// "Capabilities Over APIs": the investigate flow is registered as an
// intent-addressable capability so it can be reached by intent rather than by a
// hard-coded button/route.
export const InvestigateCapability = capability$({
  id: "investigate-incident",
  name: "Investigate Incident",
  intent: "Investigate a production database incident (high CPU, memory, connections) and remediate it after approval",
  tags: ["incident", "investigate", "cpu", "database", "postgres", "remediate"],
  inputSchema: z.object({ incidentId: z.string() }),
  flow: InvestigateIncidentFlow,
});

export const incidentCatalog = new CapabilityCatalog().register(InvestigateCapability);
