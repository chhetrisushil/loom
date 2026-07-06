import { a2uiSurfaceProjection } from "@loom/a2ui";
import type { WidgetAction } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { MigrationBoardBlueprint } from "../blueprints/MigrationBoardBlueprint";
import { MissionControlBlueprint } from "../blueprints/MissionControlBlueprint";
import { ObservabilityBlueprint } from "../blueprints/ObservabilityBlueprint";
import { type MountedBlueprint, mountBlueprint } from "../dom/BlueprintDom";
import { defineWidgetElements } from "../dom/elements";
import type { PendingApproval } from "../domain";
import { MISSION_ID } from "../wire";
import { approve, exploreBranches, openStream, promoteBranch, startMission } from "./api";

const EXAMPLE_GOALS = [
  "Add a NOT NULL region column to the 40M-row orders table.",
  "Add a nullable notes column to the orders table; apply automatically if low risk.",
];
const ACTIVE_PHASES = new Set([
  "planning",
  "dispatching",
  "awaiting-approval",
  "awaiting-branches",
  "exploring-branches",
  "branches-ready",
  "remediating",
]);
// Phases where the Migration Board tab is where the action is.
const BRANCH_PHASES = new Set(["awaiting-branches", "exploring-branches", "branches-ready"]);

type Tab = "mission" | "migrations" | "observability";

// ── Client-side projection runtime (fed entirely by the server stream) ────────
const projectionRuntime = new InMemoryProjectionRuntime();
projectionRuntime.register(a2uiSurfaceProjection("mission"));
projectionRuntime.register(a2uiSurfaceProjection("telemetry"));
projectionRuntime.register(a2uiSurfaceProjection("branch"));
defineWidgetElements();

let activeTab: Tab = "mission";
let mounted: MountedBlueprint | null = null;
let running = false;

const app = document.getElementById("app");
if (!app) throw new Error("No #app element found");

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Widget actions → POST to the server. Approvals from RiskApproval; branch
// explore/promote from the Migration Board's BranchControls.
function handleAction(action: WidgetAction): void {
  if (action.type === "APPROVE") void approve(true);
  if (action.type === "REJECT") void approve(false);
  if (action.type === "EXPLORE") void exploreBranches();
  if (action.type === "PROMOTE") {
    const strategy = (action.payload as { strategy?: string } | undefined)?.strategy;
    if (strategy) void promoteBranch(strategy);
  }
}

// ── Shell ─────────────────────────────────────────────────────────────────────
const header = el("div", "header");
const headLeft = el("div");
headLeft.appendChild(el("div", "title", "Schema Migration Planner"));
headLeft.appendChild(
  el(
    "div",
    "subtitle",
    "Branch · simulate on a shadow schema · promote — git-style branching on a durable Loom runtime (SQLite) over SSE"
  )
);
header.append(headLeft, el("div", "fiber-toggle", "branch-only · no merge"));

const input = el("input") as HTMLInputElement;
input.value = EXAMPLE_GOALS[0] ?? "";
input.placeholder = "State a migration — e.g. add a NOT NULL column to a large table";
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
  migrations: el("button", "tab", "Migration Board") as HTMLButtonElement,
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
runBtn.addEventListener("click", () => void run(input.value));

// ── Dynamic behavior ──────────────────────────────────────────────────────────
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
  const res = await startMission(goal);
  if (!res.ok) setRunning(false); // 409 busy or error — re-enable
  // Otherwise the phase patches drive running via syncRunning().
}

function renderTabs(): void {
  (Object.keys(tabButtons) as Tab[]).forEach((t) => {
    tabButtons[t].className = t === activeTab ? "tab active" : "tab";
  });
}

function mountActive(): void {
  mounted?.dispose();
  blueprintHost.replaceChildren();
  const blueprint =
    activeTab === "mission"
      ? MissionControlBlueprint
      : activeTab === "migrations"
        ? MigrationBoardBlueprint
        : ObservabilityBlueprint;
  mounted = mountBlueprint(blueprint, projectionRuntime, MISSION_ID, handleAction);
  blueprintHost.appendChild(mounted.element);
}

function missionState(): { phase?: string; pendingApproval?: PendingApproval | null } {
  return projectionRuntime.getState("mission", MISSION_ID);
}

function renderApprovalBar(): void {
  const pending = missionState().pendingApproval ?? null;
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

  const approveBtn = el("button", "btn green", "Approve");
  approveBtn.addEventListener("click", () => void approve(true));
  const rejectBtn = el("button", "btn grey", "Reject");
  rejectBtn.addEventListener("click", () => void approve(false));

  bar.append(info, approveBtn, rejectBtn);
  approvalHost.appendChild(bar);
}

function syncRunning(): void {
  const phase = missionState().phase;
  setRunning(phase !== undefined && ACTIVE_PHASES.has(phase));
}

// When the mission reaches the branching phase, bring the operator to the
// Migration Board automatically (once) — that's where the decision now lives.
let autoSwitched = false;
function maybeSwitchToBoard(): void {
  const phase = missionState().phase;
  if (phase && BRANCH_PHASES.has(phase) && !autoSwitched) {
    autoSwitched = true;
    activeTab = "migrations";
    renderTabs();
    mountActive();
  }
  if (phase === "planning") autoSwitched = false; // reset for the next run
}

// A patch changed the mission surface → refresh the app-level chrome.
projectionRuntime.subscribe("mission", MISSION_ID, () => {
  renderApprovalBar();
  syncRunning();
  maybeSwitchToBoard();
});

// ── Wire the SSE stream into the client projection runtime ────────────────────
openStream((frame) => {
  if (frame.kind === "snapshot") {
    const snap = JSON.parse(frame.snapshot) as {
      executionId: string;
      states: Record<string, unknown>;
    };
    for (const [surface, state] of Object.entries(snap.states)) {
      projectionRuntime.seedState(surface, snap.executionId, state);
    }
    // seedState doesn't notify subscribers → remount to read the seeded slices,
    // and refresh the chrome once.
    mountActive();
    renderApprovalBar();
    syncRunning();
    return;
  }
  // A single A2UI patch → fold it; subscribed widgets update granularly.
  projectionRuntime.handleEvent(frame.envelope);
});

renderTabs();
mountActive();
renderApprovalBar();
