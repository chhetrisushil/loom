import type { Blueprint, Layout } from "./types";

export interface BlueprintConfig {
  id: string;
  title: string;
  layout: Layout;
  projections: string[];
}

export function blueprint$(config: BlueprintConfig): Blueprint {
  return {
    _tag: "Blueprint",
    id: config.id,
    title: config.title,
    layout: config.layout,
    projections: config.projections,
  };
}
