import type { Blueprint, RendererRegistry } from "@loom/blueprint-runtime";
import { traverseBlueprint } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import type React from "react";
import { useContext } from "react";
import { LoomContext } from "./LoomProvider";
import type { WidgetAction, WidgetRenderer } from "./RendererRegistry";
import { defaultRegistry } from "./RendererRegistry";
import { WidgetFrame, type WidgetValueCheck } from "./WidgetFrame";
import { FiberBlueprintRenderer } from "./fiber/FiberBlueprintRenderer";
import { type FiberConfig, isFiberMode, resolveFiberConfig } from "./fiber/types";
import { useBlueprintProjectionValues } from "./hooks/useBlueprint";
import { renderReactContainer } from "./renderContainer";

interface BlueprintRendererProps {
  blueprint: Blueprint;
  projectionRuntime: ProjectionRuntime;
  executionId: string;
  registry?: RendererRegistry<WidgetRenderer>;
  onAction?: (action: WidgetAction) => void;
  /**
   * Value-contract check, run between `error` and `stale` in the canonical binding-status
   * matrix and only for a widget whose binding declares a status channel (design §5). loom
   * validates nothing about a bound value itself; a framework's own kind contract plugs in
   * here. Applies on both render paths.
   */
  check?: WidgetValueCheck;
  // Opt-in render-side fiber capabilities. Defaults off (falls back to an
  // optional LoomProvider default). See ./fiber/types.
  fiber?: FiberConfig;
}

// Dispatcher: chooses the fiber or eager render path once per mount. useContext
// is called unconditionally; only the returned component differs, so there are
// no conditional hooks.
export function BlueprintRenderer({ fiber, ...rest }: BlueprintRendererProps) {
  const ctx = useContext(LoomContext); // non-throwing; may be null (no provider)
  const cfg = resolveFiberConfig(fiber ?? ctx?.fiber);

  if (isFiberMode(cfg)) {
    return <FiberBlueprintRenderer {...rest} config={cfg} />;
  }
  return <EagerBlueprintRenderer {...rest} />;
}

type EagerProps = Omit<BlueprintRendererProps, "fiber">;

// The original whole-tree render path, unchanged in behavior: subscribes to all
// of the blueprint's projections and re-traverses on any change. Container JSX is
// shared with the fiber path via renderReactContainer.
function EagerBlueprintRenderer({
  blueprint,
  projectionRuntime,
  executionId,
  registry,
  onAction,
  check,
}: EagerProps) {
  const stateMap = useBlueprintProjectionValues(blueprint, projectionRuntime, executionId);
  const reg = registry ?? defaultRegistry;

  const root = traverseBlueprint<React.ReactNode>(blueprint.layout, stateMap, {
    renderWidget({ widget, value, status, onAction: act }) {
      const Renderer = reg.get(widget.kind);
      const body = !Renderer ? (
        <div data-widget-id={widget.id} data-widget-kind={widget.kind}>
          {`[No renderer for ${widget.kind}]`}
        </div>
      ) : (
        <Renderer
          widget={widget}
          value={value}
          {...(status !== undefined && { status })}
          {...(act !== undefined && { onAction: act })}
        />
      );
      return (
        <WidgetFrame
          key={widget.id}
          widget={widget}
          value={value}
          {...(status !== undefined && { status })}
          {...(check !== undefined && { check })}
        >
          {body}
        </WidgetFrame>
      );
    },
    renderContainer({ layout, children, cells }) {
      return renderReactContainer(layout, children, cells);
    },
    ...(onAction !== undefined && { onAction }),
  });

  return (
    <div data-blueprint-id={blueprint.id}>
      <h1>{blueprint.title}</h1>
      {root}
    </div>
  );
}
