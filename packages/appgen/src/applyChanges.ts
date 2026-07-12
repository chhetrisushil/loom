import * as fs from "node:fs";
import * as path from "node:path";
import type { AppModel } from "./appModel";
import { FlowEditor } from "./astEdit";
import type { CapabilityChange, ChangeSpec } from "./changeSpec";
import { generateFlows, generateProject } from "./generate";
import type { AppSpec, CapabilitySpec } from "./types";

// ── applyChanges: ChangeSpec + AppModel → a concrete FilePlan ─────────────────
//
// Stage 3, fully deterministic. Turns the planned delta into files to create and
// surgical edits to existing files — no model involved. A net-new project is a full
// `generateProject`; brownfield changes reuse `generateFlows` for new flows and the
// `FlowEditor` (formatting-preserving splices) for extensions. The resulting plan is
// what `--dry-run` renders and `--apply` writes; loom.gen.ts is re-wired from disk by
// the caller after writing (the existing `loom gen` step), signalled by
// `regenRegistration`.

export interface PlanCreate {
  /** Path relative to the project root, e.g. `app/flows/planner/flow.ts`. */
  path: string;
  contents: string;
}

export interface PlanEdit {
  path: string;
  before: string;
  after: string;
  notes: string[];
}

export interface PlanSkip {
  path: string;
  reason: string;
}

export interface FilePlan {
  root: string;
  isNewProject: boolean;
  creates: PlanCreate[];
  edits: PlanEdit[];
  skips: PlanSkip[];
  /** After writing, re-run `loom gen` to re-wire `app/loom.gen.ts` from disk. */
  regenRegistration: boolean;
}

function capToCapabilitySpec(cap: CapabilityChange): CapabilitySpec {
  return {
    id: cap.id,
    name: cap.name,
    intent: cap.intent,
    steps: cap.steps.map((s) => s.id),
    ...(cap.reasoning !== undefined && { reasoning: cap.reasoning }),
    ...(cap.addApproval === true && { approval: true }),
    ...(cap.addUi === true && { ui: true }),
  };
}

export function applyChanges(changeSpec: ChangeSpec, appModel: AppModel): FilePlan {
  // Net-new: a full runnable project from the whole spec.
  if (!appModel.isExisting) {
    const appSpec: AppSpec = {
      name: changeSpec.name,
      capabilities: changeSpec.capabilities.map(capToCapabilitySpec),
      ...(changeSpec.compute !== undefined && { compute: changeSpec.compute }),
    };
    return {
      root: appModel.root,
      isNewProject: true,
      creates: generateProject(appSpec).map((f) => ({ path: f.path, contents: f.contents })),
      edits: [],
      skips: [],
      regenRegistration: false, // generateProject already emits loom.gen.ts
    };
  }

  // Brownfield: create new flows, edit existing ones in place.
  const creates: PlanCreate[] = [];
  const edits: PlanEdit[] = [];
  const skips: PlanSkip[] = [];
  let created = 0;

  for (const cap of changeSpec.capabilities) {
    if (cap.op === "create") {
      const spec: AppSpec = { name: changeSpec.name, capabilities: [capToCapabilitySpec(cap)] };
      for (const f of generateFlows(spec)) creates.push({ path: f.path, contents: f.contents });
      created++;
      continue;
    }

    // extend / modify: edit the existing flow file in place.
    const flow = appModel.flows.find((f) => f.id === cap.id);
    if (flow === undefined) {
      skips.push({ path: cap.id, reason: "extend target flow not found on disk" });
      continue;
    }
    const abs = path.join(appModel.root, flow.file);
    const before = fs.readFileSync(abs, "utf8");
    const editor = new FlowEditor(before, flow.file);
    for (const step of cap.steps) {
      if (step.op === "create") editor.addStep(step.id);
    }
    if (cap.addApproval === true) editor.ensureApprovalGate();
    if (cap.addUi === true) editor.ensureUi();

    if (editor.changed()) {
      edits.push({ path: flow.file, before, after: editor.toString(), notes: editor.notes });
    } else {
      skips.push({ path: flow.file, reason: editor.notes.join("; ") || "no changes needed" });
    }
  }

  return {
    root: appModel.root,
    isNewProject: false,
    creates,
    edits,
    skips,
    regenRegistration: created > 0,
  };
}
