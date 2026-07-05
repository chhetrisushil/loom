import { customWidget$ } from "@loom/blueprint-runtime";
import type { DataBinding, Widget } from "@loom/blueprint-runtime";

// ── BYOC: custom widget kinds ─────────────────────────────────────────────────
//
// These widget *kinds* live outside Loom's built-in WidgetKind union. Each is
// declared with customWidget$ and paired (in widgets/registry.tsx) with a React
// renderer registered under the same kind string — the Bring-Your-Own-Component
// contract. Blueprints compose them exactly like the built-ins.

export function AgentTaskList(binding: DataBinding, title: string): Widget {
  return customWidget$({ kind: "AgentTaskList", title, binding });
}

export function PlanFlow(binding: DataBinding, title: string): Widget {
  return customWidget$({ kind: "PlanFlow", title, binding });
}

export function RiskApproval(binding: DataBinding, title: string): Widget {
  return customWidget$({ kind: "RiskApproval", title, binding });
}

export function PhaseBanner(binding: DataBinding, title: string): Widget {
  return customWidget$({ kind: "PhaseBanner", title, binding });
}

export function Gauge(
  binding: DataBinding,
  title: string,
  props: { unit?: string; max?: number; goodBelow?: number } = {}
): Widget {
  return customWidget$({ kind: "Gauge", title, binding, props });
}

export function Sparkline(
  binding: DataBinding,
  title: string,
  props: { unit?: string } = {}
): Widget {
  return customWidget$({ kind: "Sparkline", title, binding, props });
}

export function AgentFleet(binding: DataBinding, title: string): Widget {
  return customWidget$({ kind: "AgentFleet", title, binding });
}

// A high-frequency streaming widget — flagged with props.defer so the fiber
// renderer feeds it through startTransition (deferStreaming) instead of blocking
// urgent work.
export function ConsoleLog(binding: DataBinding, title: string): Widget {
  return customWidget$({ kind: "ConsoleLog", title, binding, props: { defer: true } });
}

// An async BYOC component that lazily code-splits its chart implementation. With
// the fiber `suspense` capability on, it can suspend behind its own boundary
// without blanking sibling widgets.
export function LatencyChart(binding: DataBinding, title: string): Widget {
  return customWidget$({
    kind: "LatencyChart",
    title,
    binding,
    props: { placeholder: "Loading chart…" },
  });
}
