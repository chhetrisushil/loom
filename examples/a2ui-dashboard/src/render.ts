import type { A2UISurfaceState } from "@loom/a2ui";

// A tiny HEADLESS renderer: turns a folded A2UI surface into a terminal panel. A
// real client (React BlueprintRenderer, Web Components, …) binds the same surface
// state by `{ projectionId: surfaceId, path }`; here we just pretty-print it so the
// example runs with no browser. The surface is plain JSON — this reads it directly.

function gauge(value: number, alert: boolean): string {
  const filled = Math.round(value / 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return `${bar} ${value}%${alert ? "  ⚠" : ""}`;
}

export function renderPanel(agentId: string, surface: A2UISurfaceState): string {
  const title = String(surface.title ?? agentId);
  const host = String(surface.host ?? "—");
  const value = typeof surface.value === "number" ? surface.value : 0;
  const status = String(surface.status ?? "—");
  const log = Array.isArray(surface.log) ? (surface.log as string[]) : [];

  const head = `┌─ ${title}  ·  ${host}  ·  surface:${agentId}`;
  const body = `│  ${gauge(value, status === "alert")}   [${status.toUpperCase()}]`;
  const tail = log.map((l) => `│    · ${l}`).join("\n");
  return [head, body, tail, "└─"].join("\n");
}
