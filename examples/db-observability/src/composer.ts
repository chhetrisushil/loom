import { StatusBadge, blueprint$, stack } from "@loom/blueprint-runtime";
import type { Blueprint, Widget } from "@loom/blueprint-runtime";
import type { LlmProvider } from "@loom/llm";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { type Classification, classifyIntent } from "./agent";
import { catalogueEntry } from "./catalogue";
import { readTelemetry } from "./telemetry";
import { TOPIC_MODELS } from "./topics";

export interface DashboardResult {
  question: string;
  classification: Classification;
  what: string; // the direct answer
  why: string; // the supporting explanation
  whatWidget: string; // catalogue id of the primary widget
  whyWidgets: string[]; // catalogue ids of the supporting widgets
  blueprint: Blueprint;
}

// Every projection a composed dashboard may bind to (the renderer reads these).
const ALL_PROJECTIONS = ["answer", "cpu", "connections", "replication", "queries"];

/**
 * Turns a natural-language question into a DYNAMICALLY-assembled dashboard:
 *   1. the agent categorises the question → topic + kind
 *   2. it reasons over live telemetry → a WHAT (direct answer) + WHY (explanation)
 *   3. it publishes the answer to a projection so widgets can bind to it
 *   4. it selects widgets from the catalogue and assembles a Blueprint at runtime
 * No dashboard is hand-authored — the UI is generated from intent + catalogue.
 */
export class DashboardComposer {
  constructor(
    private readonly pr: ProjectionRuntime,
    private readonly provider: LlmProvider,
    private readonly executionId: string
  ) {}

  async answer(question: string): Promise<DashboardResult> {
    const classification = await classifyIntent(this.provider, question);
    const model = TOPIC_MODELS[classification.topic];

    const telemetry = readTelemetry(this.pr, this.executionId);
    const what = model.answer(telemetry);
    const why = model.explanation(telemetry);

    // Publish the agent's answer so the header/why widgets can bind to it.
    this.pr.seedState("answer", this.executionId, {
      question,
      topic: classification.topic,
      what,
      why,
    });

    const blueprint = this.buildBlueprint(classification, model.primaryWidget, model.whyWidgets);
    return {
      question,
      classification,
      what,
      why,
      whatWidget: model.primaryWidget,
      whyWidgets: model.whyWidgets,
      blueprint,
    };
  }

  /** Assemble the blueprint from the catalogue — a WHAT section then a WHY section. */
  private buildBlueprint(
    classification: Classification,
    primaryWidget: string,
    whyWidgets: string[]
  ): Blueprint {
    const children: Widget[] = [
      StatusBadge({ title: "You asked", binding: { projectionId: "answer", path: "question" } }),
      // WHAT — the direct answer + the primary metric widget.
      StatusBadge({ title: "▶ WHAT", binding: { projectionId: "answer", path: "what" } }),
      catalogueEntry(primaryWidget).build(),
      // WHY — the supporting explanation + the causal widgets.
      StatusBadge({ title: "▶ WHY", binding: { projectionId: "answer", path: "why" } }),
      ...whyWidgets.map((id) => catalogueEntry(id).build()),
    ];

    return blueprint$({
      id: `observability-${classification.topic}`,
      title: `DB Observability — ${TOPIC_MODELS[classification.topic].label}`,
      layout: stack({ gap: 1, children }),
      projections: ALL_PROJECTIONS,
    });
  }
}
