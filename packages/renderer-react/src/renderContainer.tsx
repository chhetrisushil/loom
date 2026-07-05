import type { Layout } from "@loom/blueprint-runtime";
import type React from "react";

// Shared container rendering used by BOTH the eager and fiber render paths, so
// their layout output stays byte-identical. Extracted verbatim from the original
// BlueprintRenderer container branch.
export function renderReactContainer(
  layout: Layout,
  children: React.ReactNode[]
): React.ReactElement {
  if (layout.type === "grid") {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${layout.columns}, 1fr)`,
          ...(layout.gap !== undefined && { gap: `${layout.gap}px` }),
        }}
      >
        {children}
      </div>
    );
  }
  if (layout.type === "flex") {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: layout.direction,
          ...(layout.gap !== undefined && { gap: `${layout.gap}px` }),
        }}
      >
        {children}
      </div>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        ...(layout.gap !== undefined && { gap: `${layout.gap}px` }),
      }}
    >
      {children}
    </div>
  );
}
