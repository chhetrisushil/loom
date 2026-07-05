import { throwIfAborted, yieldControl } from "@loom/scheduler";
import { resolveWidgetValue } from "./traverseBlueprint";
import type { Layout, Widget, WidgetAction, WidgetRendererProps } from "./types";

// ── traverseBlueprintAsync ────────────────────────────────────────────────────
//
// An interruptible, incremental-commit counterpart to the synchronous
// traverseBlueprint. The synchronous walker is a PULL model (assemble the whole
// TNode bottom-up, then hand it back) — fine for renderers that need the complete
// tree (React, string/SSR). This async walker is a PUSH model for scheduler-less
// renderers that mutate a target as the tree resolves (direct DOM, canvas, native):
// it creates each node top-down, appends children as they resolve, and cooperatively
// yields against a budget so the host stays responsive on large trees or expensive
// BYOC widgets. It is opt-in and has no effect on the synchronous fast path.
//
// No production renderer ships against this yet (all current renderers are pull);
// it is the validated BYOR extension point. See traverseBlueprintAsync.test.ts for
// a reference IncrementalRenderer.

export interface IncrementalRenderer<TNode> {
  createContainer(layout: Layout): TNode;
  createWidget(ctx: WidgetRendererProps): TNode;
  appendChild(parent: TNode, child: TNode): void;
}

export interface AsyncTraversalOptions<TNode> {
  renderer: IncrementalRenderer<TNode>;
  onAction?: (action: WidgetAction) => void;
  /** Abort a stale/interrupted render; checked at every node. */
  signal?: AbortSignal;
  /** Whether to yield before processing the next node. Default: every 64 nodes. */
  shouldYield?: (nodesSinceYield: number) => boolean;
  /** How to yield. Default: @loom/scheduler yieldControl (macrotask). */
  yieldTo?: () => Promise<void>;
}

const DEFAULT_YIELD_EVERY = 64;

export async function traverseBlueprintAsync<TNode>(
  node: Layout | Widget,
  stateMap: Map<string, unknown>,
  options: AsyncTraversalOptions<TNode>
): Promise<TNode> {
  const { renderer, onAction, signal } = options;
  const yieldTo = options.yieldTo ?? yieldControl;
  const shouldYield = options.shouldYield ?? ((n) => n >= DEFAULT_YIELD_EVERY);

  // Counter-based budget (no clock) so behavior is deterministic and testable.
  let nodesSinceYield = 0;
  const tick = async (): Promise<void> => {
    throwIfAborted(signal);
    nodesSinceYield++;
    if (shouldYield(nodesSinceYield)) {
      nodesSinceYield = 0;
      await yieldTo();
      throwIfAborted(signal);
    }
  };

  const walk = async (current: Layout | Widget): Promise<TNode> => {
    await tick();

    if ("_tag" in current && current._tag === "Widget") {
      const widget = current as Widget;
      return renderer.createWidget({
        widget,
        value: resolveWidgetValue(widget, stateMap),
        ...(onAction !== undefined && { onAction }),
      });
    }

    const layout = current as Layout;
    // Create the container FIRST so children can be committed into it as they
    // resolve (incremental commit / progressive paint between yields).
    const container = renderer.createContainer(layout);
    for (const child of layout.children) {
      const childNode = await walk(child as Layout | Widget);
      renderer.appendChild(container, childNode);
    }
    return container;
  };

  return walk(node);
}
