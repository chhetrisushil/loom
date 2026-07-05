import type { DataBinding, Widget } from "./types";

function stableId(kind: string, props: object): string {
  const str = kind + JSON.stringify(props, Object.keys(props as Record<string, unknown>).sort());
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
  }
  return `${kind}-${(hash >>> 0).toString(16)}`;
}

export interface CustomWidgetConfig {
  kind: string;
  title?: string;
  binding?: DataBinding;
  props?: Record<string, unknown>;
  id?: string;
}

// Builder for user-defined widget kinds that live outside the WidgetKind union.
// Register a matching renderer in your RendererRegistry under the same `kind` string.
//
//   const HeatmapWidget = customWidget$({
//     kind: "Heatmap",
//     title: "CPU Heatmap",
//     binding: { projectionId: "metrics", path: "cpu.history" },
//     props: { buckets: 20 },
//   });
//   registry.register("Heatmap", HeatmapComponent);
export function customWidget$(config: CustomWidgetConfig): Widget {
  const propsRecord = config.props ?? {};
  return {
    _tag: "Widget",
    id:
      config.id ??
      stableId(config.kind, { title: config.title, binding: config.binding, ...propsRecord }),
    kind: config.kind,
    ...(config.title !== undefined && { title: config.title }),
    props: propsRecord,
    ...(config.binding !== undefined && { binding: config.binding }),
  };
}
