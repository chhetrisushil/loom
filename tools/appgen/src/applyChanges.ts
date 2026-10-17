import * as fs from "node:fs";
import * as path from "node:path";
import type { AppModel } from "./appModel";
import { FlowEditor } from "./astEdit";
import type { CapabilityChange, ChangeSpec } from "./changeSpec";
import { wireGrantsIntoConfig } from "./configEditor";
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
  /** Step ids this edit REMOVES from the flow file (destructive; listed in the confirm prompt). */
  deletedSteps?: string[];
}

export interface PlanSkip {
  path: string;
  reason: string;
}

export interface PlanDelete {
  path: string;
}

export interface FilePlan {
  root: string;
  isNewProject: boolean;
  creates: PlanCreate[];
  edits: PlanEdit[];
  deletes: PlanDelete[];
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
  // Net-new: a full runnable project from the whole spec (delete ops are meaningless
  // against an app that doesn't exist yet, so drop them).
  if (!appModel.isExisting) {
    const appSpec: AppSpec = {
      name: changeSpec.name,
      capabilities: changeSpec.capabilities
        .filter((c) => c.op !== "delete")
        .map(capToCapabilitySpec),
      ...(changeSpec.compute !== undefined && { compute: changeSpec.compute }),
    };
    return {
      root: appModel.root,
      isNewProject: true,
      creates: generateProject(appSpec).map((f) => ({ path: f.path, contents: f.contents })),
      edits: [],
      deletes: [],
      skips: [],
      regenRegistration: false, // generateProject already emits loom.gen.ts
    };
  }

  // Brownfield: create new flows, edit / delete existing ones in place.
  const creates: PlanCreate[] = [];
  const edits: PlanEdit[] = [];
  const deletes: PlanDelete[] = [];
  const skips: PlanSkip[] = [];
  const grants: Record<string, string[]> = {};
  let structural = 0; // creates or deletes → re-wire loom.gen.ts

  for (const cap of changeSpec.capabilities) {
    if (cap.wireGrants !== undefined && cap.wireGrants.length > 0 && cap.op !== "delete") {
      grants[cap.id] = [...(grants[cap.id] ?? []), ...cap.wireGrants];
    }

    if (cap.op === "create") {
      const spec: AppSpec = { name: changeSpec.name, capabilities: [capToCapabilitySpec(cap)] };
      for (const f of generateFlows(spec)) creates.push({ path: f.path, contents: f.contents });
      structural++;
      continue;
    }

    const flow = appModel.flows.find((f) => f.id === cap.id);
    if (flow === undefined) {
      skips.push({ path: cap.id, reason: `${cap.op} target flow not found on disk` });
      continue;
    }

    if (cap.op === "delete") {
      // Never delete a flow that carries hand-written code.
      const handEdited = flow.steps.some((s) => s.handlerState === "edited");
      if (!flow.isGenerated || handEdited) {
        skips.push({
          path: flow.file,
          reason: "not deleted — flow has hand-written code (remove it manually)",
        });
      } else {
        deletes.push({ path: flow.file });
        structural++;
      }
      continue;
    }

    // extend / modify: edit the existing flow file in place.
    const abs = path.join(appModel.root, flow.file);
    const before = fs.readFileSync(abs, "utf8");
    const editor = new FlowEditor(before, flow.file);
    const deletedSteps: string[] = [];
    for (const step of cap.steps) {
      if (step.op === "create") editor.addStep(step.id);
      else if (step.op === "delete") {
        if (editor.removeStep(step.id)) deletedSteps.push(step.id);
      } else if (step.op === "modify") {
        editor.notes.push(
          `step "${step.id}" marked modify — appgen doesn't rewrite handler bodies; edit ${flow.file} yourself`
        );
      }
    }
    if (cap.addApproval === true) editor.ensureApprovalGate();
    if (cap.addUi === true) editor.ensureUi();

    if (editor.changed()) {
      edits.push({
        path: flow.file,
        before,
        after: editor.toString(),
        notes: editor.notes,
        ...(deletedSteps.length > 0 && { deletedSteps }),
      });
    } else {
      skips.push({ path: flow.file, reason: editor.notes.join("; ") || "no changes needed" });
    }
  }

  // Grants → app/config.ts (one edit, merging every capability's grants).
  if (Object.keys(grants).length > 0) {
    const configRel = path.join("app", "config.ts");
    const configAbs = path.join(appModel.root, configRel);
    if (fs.existsSync(configAbs)) {
      const before = fs.readFileSync(configAbs, "utf8");
      const res = wireGrantsIntoConfig(before, grants, configRel);
      if (res.changed) edits.push({ path: configRel, before, after: res.after, notes: res.notes });
      else skips.push({ path: configRel, reason: res.notes.join("; ") || "no grant changes" });
    } else {
      skips.push({ path: configRel, reason: "no app/config.ts to wire grants into" });
    }
  }

  return {
    root: appModel.root,
    isNewProject: false,
    creates,
    edits,
    deletes,
    skips,
    regenRegistration: structural > 0,
  };
}
