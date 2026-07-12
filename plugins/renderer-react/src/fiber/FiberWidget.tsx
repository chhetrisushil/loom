import type { RendererRegistry, Widget } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import React from "react";
import type { WidgetAction, WidgetRenderer } from "../RendererRegistry";
import { useDeferredWidgetValue } from "../hooks/useDeferredWidgetValue";
import { useWidgetValue } from "../hooks/useWidgetValue";
import type { ResolvedFiberConfig } from "./types";

export interface FiberWidgetProps {
  widget: Widget;
  runtime: ProjectionRuntime;
  executionId: string;
  registry: RendererRegistry<WidgetRenderer>;
  onAction?: (action: WidgetAction) => void;
}

// Shared body: registry lookup + the same "No renderer" fallback as the eager
// path. Kept separate so the Eager/Deferred wrappers only differ in which value
// hook they call (each calls exactly one — no conditional hooks).
const WidgetBody: React.FC<{
  widget: Widget;
  value: unknown;
  registry: RendererRegistry<WidgetRenderer>;
  onAction?: (a: WidgetAction) => void;
}> = ({ widget, value, registry, onAction }) => {
  const Renderer = registry.get(widget.kind);
  if (!Renderer) {
    return (
      <div data-widget-id={widget.id} data-widget-kind={widget.kind}>
        {`[No renderer for ${widget.kind}]`}
      </div>
    );
  }
  return <Renderer widget={widget} value={value} {...(onAction !== undefined && { onAction })} />;
};

const EagerFiberWidgetInner: React.FC<FiberWidgetProps> = ({
  widget,
  runtime,
  executionId,
  registry,
  onAction,
}) => {
  const value = useWidgetValue(runtime, widget, executionId);
  return (
    <WidgetBody
      widget={widget}
      value={value}
      registry={registry}
      {...(onAction !== undefined && { onAction })}
    />
  );
};

// Memoized so a container re-render (rare in fiber mode) doesn't cascade; a
// widget only re-renders when its own subscribed slice changes.
export const EagerFiberWidget = React.memo(EagerFiberWidgetInner);

// Same as EagerFiberWidget but streams updates via startTransition — for
// high-frequency, low-urgency widgets.
const DeferredFiberWidgetInner: React.FC<FiberWidgetProps> = ({
  widget,
  runtime,
  executionId,
  registry,
  onAction,
}) => {
  const value = useDeferredWidgetValue(runtime, widget, executionId);
  return (
    <WidgetBody
      widget={widget}
      value={value}
      registry={registry}
      {...(onAction !== undefined && { onAction })}
    />
  );
};
export const DeferredFiberWidget = React.memo(DeferredFiberWidgetInner);

const DefaultSkeleton: React.FC = () => <div data-fiber-fallback="true">…</div>;

function fallbackOf(widget: Widget): React.ReactNode {
  const placeholder = (widget.props as { placeholder?: unknown }).placeholder;
  return typeof placeholder === "string" ? placeholder : <DefaultSkeleton />;
}

function shouldDefer(config: ResolvedFiberConfig, widget: Widget): boolean {
  if (!config.deferStreaming) return false;
  return (widget.props as { defer?: unknown }).defer === true || widget.kind === "StreamingText";
}

// Mounts one widget per the resolved fiber config: picks the eager or deferred
// selector, and (optionally) wraps it in a per-widget <Suspense> boundary so an
// async BYOC component can suspend without blanking its siblings.
export function mountFiberWidget(
  config: ResolvedFiberConfig,
  props: FiberWidgetProps
): React.ReactElement {
  const key = props.widget.id;
  const defer = shouldDefer(config, props.widget);
  const inner = defer ? <DeferredFiberWidget {...props} /> : <EagerFiberWidget {...props} />;
  if (config.suspense) {
    return (
      <React.Suspense key={key} fallback={fallbackOf(props.widget)}>
        {inner}
      </React.Suspense>
    );
  }
  return defer ? (
    <DeferredFiberWidget key={key} {...props} />
  ) : (
    <EagerFiberWidget key={key} {...props} />
  );
}
