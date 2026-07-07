import { BlueprintRenderer } from "@loom/renderer-react";
import type { RendererRegistry, WidgetRenderer } from "@loom/renderer-react";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardResult } from "../composer";
import {
  type ConnectionsState,
  type CpuState,
  nextConnectionsSample,
  nextCpuSample,
  sampleEvent,
} from "../telemetry";
import type { ObservabilityCore } from "../wiring";
import { colors } from "./theme";

const DEFAULT_Q = "Why is the CPU utilization high?";
const PRESETS = [
  DEFAULT_Q,
  "What is the connection saturation level?",
  "Is replica lag a problem right now?",
  "Which slow queries are hurting us?",
];

export function App({
  core,
  registry,
}: {
  core: ObservabilityCore;
  registry: RendererRegistry<WidgetRenderer>;
}) {
  const { composer, projectionRuntime, executionId } = core;
  const [question, setQuestion] = useState(DEFAULT_Q);
  const [result, setResult] = useState<DashboardResult | null>(null);
  const [askId, setAskId] = useState(0);
  const [live, setLive] = useState(false);
  const tick = useRef(0);

  const ask = useCallback(
    async (q: string) => {
      const r = await composer.answer(q);
      setResult(r);
      setQuestion(q);
      setAskId((n) => n + 1); // remount the renderer so it reads the fresh answer/telemetry
    },
    [composer]
  );

  // Ask an opening question so the dashboard isn't empty on load.
  useEffect(() => {
    void ask(DEFAULT_Q);
  }, [ask]);

  // "Live" telemetry: push deterministic samples so the gauge/area animate. handleEvent
  // fires the projection subscribers, which re-render the bound widgets in place.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      tick.current += 1;
      const cpu = projectionRuntime.getState<CpuState>("cpu", executionId);
      projectionRuntime.handleEvent(
        sampleEvent("cpu", executionId, nextCpuSample(cpu, tick.current))
      );
      const conn = projectionRuntime.getState<ConnectionsState>("connections", executionId);
      projectionRuntime.handleEvent(
        sampleEvent("connections", executionId, nextConnectionsSample(conn, tick.current))
      );
    }, 1500);
    return () => clearInterval(id);
  }, [live, projectionRuntime, executionId]);

  return (
    <div>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800 }}>DB Observability</h1>
        <p style={{ color: colors.dim, marginTop: 4, fontSize: 14 }}>
          Ask a question — an agent categorises it and generates a dashboard: the{" "}
          <span style={{ color: colors.good }}>WHAT</span> (direct answer) and the{" "}
          <span style={{ color: colors.accent }}>WHY</span> (the causal metrics), each drawn as a
          visualisation.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
        style={{ display: "flex", gap: 8, marginBottom: 12 }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about CPU, connections, replication, queries…"
          style={input}
        />
        <button type="submit" style={askBtn}>
          Ask
        </button>
      </form>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          marginBottom: 20,
        }}
      >
        {PRESETS.map((p) => (
          <button key={p} type="button" onClick={() => void ask(p)} style={chip}>
            {p}
          </button>
        ))}
        <label style={{ ...chip, cursor: "pointer", marginLeft: "auto" }}>
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live
        </label>
        {result && (
          <span style={{ ...chip, borderColor: colors.accent, color: colors.accent }}>
            topic: {result.classification.topic} · kind: {result.classification.kind}
          </span>
        )}
      </div>

      {result && (
        <BlueprintRenderer
          key={askId}
          blueprint={result.blueprint}
          projectionRuntime={projectionRuntime}
          executionId={executionId}
          registry={registry}
        />
      )}
    </div>
  );
}

const input: CSSProperties = {
  flex: 1,
  padding: "10px 12px",
  background: colors.card,
  border: `1px solid ${colors.cardBorder}`,
  borderRadius: 8,
  color: colors.text,
  fontSize: 14,
};
const askBtn: CSSProperties = {
  padding: "10px 18px",
  background: colors.accent,
  border: "none",
  borderRadius: 8,
  color: "#08111d",
  fontWeight: 700,
  cursor: "pointer",
};
const chip: CSSProperties = {
  padding: "6px 10px",
  background: colors.card,
  border: `1px solid ${colors.cardBorder}`,
  borderRadius: 999,
  color: colors.text,
  fontSize: 12.5,
  cursor: "pointer",
};
