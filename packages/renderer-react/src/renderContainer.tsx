import type { Layout } from "@loom/blueprint-runtime";
import { Children, type ReactElement, type ReactNode } from "react";

// Shared container rendering used by BOTH the eager and fiber render paths, so
// their layout output stays byte-identical. Extracted verbatim from the original
// BlueprintRenderer container branch.
export function renderReactContainer(layout: Layout, children: ReactNode[]): ReactElement {
  // Key the child array so React does not warn about missing keys. The eager path
  // keys widget leaves by widget.id, but the fiber path's leaves and nested
  // containers (both paths) are unkeyed; Children.toArray assigns stable keys to
  // all of them (preserving any existing key) without changing the rendered DOM.
  const items = Children.toArray(children);

  if (layout.type === "grid") {
    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${layout.columns}, 1fr)`,
          ...(layout.gap !== undefined && { gap: `${layout.gap}px` }),
        }}
      >
        {items}
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
        {items}
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
      {items}
    </div>
  );
}
