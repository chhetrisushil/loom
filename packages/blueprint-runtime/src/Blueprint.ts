import type { Blueprint, Layout } from "./types";

export interface BlueprintConfig {
  id: string;
  title: string;
  layout: Layout;
  projections: string[];
  /**
   * ADR 0095 — the declared versions of the projections this view binds to, at composition.
   * `projectionRuntime.pins()` is where they come from. See {@link Blueprint.projectionVersions}.
   */
  projectionVersions?: Readonly<Record<string, string>>;
}

export function blueprint$(config: BlueprintConfig): Blueprint {
  return {
    _tag: "Blueprint",
    id: config.id,
    title: config.title,
    layout: config.layout,
    projections: config.projections,
    ...(config.projectionVersions !== undefined && {
      projectionVersions: config.projectionVersions,
    }),
  };
}
