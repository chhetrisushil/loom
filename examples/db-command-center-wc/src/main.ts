import type { AgentCard } from "@loom/a2a";
import { defineConfig } from "@loom/app";
import type { WidgetAction } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { AGENT_CARDS, CAPABILITY_AGENT, FLEET } from "./agents/definitions";
import { MissionControlBlueprint } from "./blueprints/MissionControlBlueprint";
import { ObservabilityBlueprint } from "./blueprints/ObservabilityBlueprint";
import { buildCatalog } from "./capabilities/catalog";
import { type MountedBlueprint, mountBlueprint } from "./dom/BlueprintDom";
import { defineWidgetElements } from "./dom/elements";
import type { PendingApproval } from "./domain";
import { Orchestrator } from "./orchestrator/Orchestrator";

const MISSION_ID = "mission-1";
const EXAMPLE_GOALS = [
  "Why is CPU utilization high? Fix it if remediation is low risk.",
  "Investigate the read-replica lag issue and fix it if remediation is low risk, else wait for my approval.",
];

// ── Wiring (identical agentic backend to the React example) ───────────────────
// The composition root — stores, the WorkflowRuntime, the effect runtime, and the
// A2A bus with its agent/capability routes — is assembled by `defineConfig`. We
// bring our own coalescing projection runtime (defineConfig registers the A2UI
// surfaces on it and wires onEvent → handleEvent).
const projectionRuntime = new InMemoryProjectionRuntime({ coalesceNotifications: true });
const catalog = buildCatalog();

const loomApp = defineConfig({
  storage: { kind: "memory" },
  projectionRuntime,
  surfaces: ["mission", "telemetry"],
  catalog,
  agents: FLEET.map((a) => AGENT_CARDS[a.id]).filter((c): c is AgentCard => c !== undefined),
  capabilityAgents: CAPABILITY_AGENT,
});

const orchestrator = new Orchestrator({
  projectionRuntime,
  missionRuntime: loomApp.runtime,
  catalog,
  bus: loomApp.bus,
  missionId: MISSION_ID,
});

// ── Web Components render layer ───────────────────────────────────────────────
defineWidgetElements();

type Tab = "mission" | "observability";
let activeTab: Tab = "mission";
let running = false;
let mounted: MountedBlueprint | null = null;

const app = document.getElementById("app");
if (!app) throw new Error("No #app element found");

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function handleAction(action: WidgetAction): void {
  if (action.type === "APPROVE") orchestrator.resolveApproval(true);
  if (action.type === "REJECT") orchestrator.resolveApproval(false);
}

// ── Static shell ──────────────────────────────────────────────────────────────
const header = el("div", "header");
const headLeft = el("div");
headLeft.appendChild(el("div", "title", "DB Command Center"));
headLeft.appendChild(
  el(
    "div",
    "subtitle",
    `Web Components · granular per-widget updates · ${loomApp.bus.agentCards().length} agents over A2A`
  )
);
header.append(headLeft, el("div", "fiber-toggle", "no framework — native custom elements"));

const input = el("input") as HTMLInputElement;
input.value = EXAMPLE_GOALS[0] ?? "";
input.placeholder = "State a goal — e.g. why is CPU high? fix it if low risk";
const runBtn = el("button", "btn", "Run Intent") as HTMLButtonElement;
const intentBar = el("div", "intent-bar");
intentBar.append(input, runBtn);

const examples = el("div", "examples");
examples.appendChild(el("span", "lbl", "Try:"));
const chipButtons: HTMLButtonElement[] = [];
for (const g of EXAMPLE_GOALS) {
  const chip = el("button", "chip", g) as HTMLButtonElement;
  chip.addEventListener("click", () => {
    input.value = g;
    void run(g);
  });
  chipButtons.push(chip);
  examples.appendChild(chip);
}

const approvalHost = el("div");

const tabsNav = el("div", "tabs");
const tabButtons: Record<Tab, HTMLButtonElement> = {
  mission: el("button", "tab", "Mission Control") as HTMLButtonElement,
  observability: el("button", "tab", "Observability") as HTMLButtonElement,
};
(Object.keys(tabButtons) as Tab[]).forEach((t) => {
  tabButtons[t].addEventListener("click", () => {
    activeTab = t;
    renderTabs();
    mountActive();
  });
  tabsNav.appendChild(tabButtons[t]);
});

const blueprintHost = el("div");

app.append(header, intentBar, examples, approvalHost, tabsNav, blueprintHost);

// ── Dynamic bits ──────────────────────────────────────────────────────────────
runBtn.addEventListener("click", () => void run(input.value));

function setRunning(next: boolean): void {
  running = next;
  runBtn.disabled = next;
  input.disabled = next;
  runBtn.textContent = next ? "Running…" : "Run Intent";
  for (const c of chipButtons) c.disabled = next;
}

async function run(goal: string): Promise<void> {
  if (running) return;
  setRunning(true);
  try {
    await orchestrator.run(goal);
  } finally {
    setRunning(false);
  }
}

function renderTabs(): void {
  (Object.keys(tabButtons) as Tab[]).forEach((t) => {
    tabButtons[t].className = t === activeTab ? "tab active" : "tab";
  });
}

function mountActive(): void {
  mounted?.dispose();
  blueprintHost.replaceChildren();
  const blueprint = activeTab === "mission" ? MissionControlBlueprint : ObservabilityBlueprint;
  mounted = mountBlueprint(blueprint, projectionRuntime, MISSION_ID, handleAction);
  blueprintHost.appendChild(mounted.element);
}

// A prominent, tab-independent approval prompt driven by the mission surface —
// so a human can approve/reject no matter which tab they're viewing.
function renderApprovalBar(): void {
  const state = projectionRuntime.getState<{ pendingApproval?: PendingApproval | null }>(
    "mission",
    MISSION_ID
  );
  const pending = state.pendingApproval ?? null;
  approvalHost.replaceChildren();
  if (!pending) return;

  const bar = el("div", "approval-bar");
  bar.dataset.testid = "approval-bar";
  const info = el("div");
  info.style.flex = "1";
  const title = el("div", "title");
  title.append(
    document.createTextNode("Approval required — "),
    el("strong", undefined, pending.action)
  );
  const risk = el("span", "pill", `${pending.risk} risk`);
  risk.style.background =
    pending.risk === "high" ? "#9b2c2c" : pending.risk === "medium" ? "#b7791f" : "#276749";
  title.appendChild(risk);
  info.append(title, el("div", "rationale", pending.rationale));

  const approve = el("button", "btn green", "Approve");
  approve.addEventListener("click", () => orchestrator.resolveApproval(true));
  const reject = el("button", "btn grey", "Reject");
  reject.addEventListener("click", () => orchestrator.resolveApproval(false));

  bar.append(info, approve, reject);
  approvalHost.appendChild(bar);
}

projectionRuntime.subscribe("mission", MISSION_ID, () => renderApprovalBar());

renderTabs();
mountActive();
renderApprovalBar();
