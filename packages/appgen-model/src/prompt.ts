import type { AppModel } from "@loom/appgen";

// The planner prompt. The model's whole job is: read the intent + a COMPACT summary of
// the existing app, and emit a ChangeSpec (create/extend/modify). It never sees raw file
// contents — only the scanned summary — which keeps context (and the KV-cache memory
// footprint) small and keeps the model honest about what already exists.

/** A compact, model-facing summary of the scanned app. Never includes file contents. */
export function summarizeAppModel(appModel: AppModel): string {
  if (appModel.flows.length === 0) {
    return 'EXISTING APP: none (net-new project — everything is `op: "create"`).';
  }
  const lines = ["EXISTING APP (plan a delta against this — do not recreate what exists):"];
  for (const f of appModel.flows) {
    const steps = f.steps.map((s) => `${s.id}[${s.handlerState}]`).join(", ") || "(none)";
    const gates =
      [f.hasApproval ? "approval" : "", f.hasUi ? "ui" : ""].filter(Boolean).join("+") || "none";
    lines.push(`- flow "${f.id}": steps=${steps}; gates=${gates}`);
  }
  return lines.join("\n");
}

export function buildSystem(appModel: AppModel): string {
  return [
    "You are the planner for `loom appgen`. Convert the user's intent into a ChangeSpec:",
    "a JSON delta describing what to create or change in a Loom app. Emit ONLY the JSON —",
    "no prose, no code, no file contents.",
    "",
    "ChangeSpec shape:",
    '  { "name": string,',
    '    "capabilities": [ {',
    '        "id": kebab-case string, "name": string, "intent": string,',
    '        "op": "create" | "extend" | "modify",   // create=new flow, extend=add to an existing flow',
    '        "steps": [ { "id": kebab-case string, "op": "create" | "modify" } ],',
    '        "addApproval"?: boolean,   // add a durable human-approval suspend gate',
    '        "addUi"?: boolean          // add a durable UI surface update',
    "    } ],",
    '    "compute"?: { "target"?: string } }',
    "",
    "Rules:",
    '- If a flow with the same id already exists, use op "extend" (or "modify"); otherwise "create".',
    "- Only set addApproval/addUi when the intent asks for it AND the flow lacks that gate already.",
    '- Steps that already exist are op "modify"; genuinely new steps are op "create".',
    "- Never invent handler code or file paths — you emit intent, the toolchain emits code.",
    "",
    'Example — existing flow "triage" with steps classify[stub]; gates=none.',
    'Intent: "Add a route step to triage and pause for approval."',
    "Output:",
    '{"name":"triage","capabilities":[{"id":"triage","name":"Triage","intent":"Add a route step and pause for approval.","op":"extend","steps":[{"id":"route","op":"create"}],"addApproval":true}]}',
    "",
    summarizeAppModel(appModel),
  ].join("\n");
}

export function buildUser(intent: string): string {
  return `Intent: ${intent.trim()}`;
}

/** A repair instruction listing what was wrong with the previous ChangeSpec. */
export function buildRepairPrompt(issues: string[]): string {
  return [
    "Your previous ChangeSpec had these problems:",
    ...issues.map((i) => `- ${i}`),
    "",
    "Output a corrected ChangeSpec JSON that fixes them. JSON only.",
  ].join("\n");
}
