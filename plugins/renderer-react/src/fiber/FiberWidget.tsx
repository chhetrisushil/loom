import type { BindingStatus, RendererRegistry, Widget } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import React, { useDeferredValue } from "react";
import type { WidgetAction, WidgetRenderer } from "../RendererRegistry";
import { WidgetFrame, type WidgetValueCheck } from "../WidgetFrame";
import { useWidgetSlice } from "../hooks/useWidgetSlice";
import type { ResolvedFiberConfig } from "./types";

// IR 2.5.0: a redacted widget draws one constant marker and never reads its binding.
const isRedacted = (w: Widget): boolean =>
  (w.source as { redacted?: unknown } | undefined)?.redacted === true;

export interface FiberWidgetProps {
  widget: Widget;
  runtime: ProjectionRuntime;
  executionId: string;
  registry: RendererRegistry<WidgetRenderer>;
  onAction?: (action: WidgetAction) => void;
  /** See BlueprintRendererProps.check — passed straight through to WidgetFrame. */
  check?: WidgetValueCheck;
}

// Shared body: registry lookup + the same "No renderer" fallback as the eager
// path, wrapped in WidgetFrame so both render paths apply the same binding-
// status matrix. Kept separate so the Eager/Deferred wrappers only differ in
// which slice hook they call (each calls exactly one — no conditional hooks).
const WidgetBody: React.FC<{
  widget: Widget;
  value: unknown;
  status?: BindingStatus;
  registry: RendererRegistry<WidgetRenderer>;
  onAction?: (a: WidgetAction) => void;
  check?: WidgetValueCheck;
}> = ({ widget, value, status, registry, onAction, check }) => {
  const Renderer = registry.get(widget.kind);
  const body = !Renderer ? (
    <div data-widget-id={widget.id} data-widget-kind={widget.kind}>
      {`[No renderer for ${widget.kind}]`}
    </div>
  ) : (
    <Renderer
      widget={widget}
      value={value}
      {...(status !== undefined && { status })}
      {...(onAction !== undefined && { onAction })}
    />
  );
  return (
    <WidgetFrame
      widget={widget}
      value={value}
      {...(status !== undefined && { status })}
      {...(check !== undefined && { check })}
    >
      {body}
    </WidgetFrame>
  );
};

const EagerFiberWidgetInner: React.FC<FiberWidgetProps> = ({
  widget,
  runtime,
  executionId,
  registry,
  onAction,
  check,
}) => {
  const { value, status } = useWidgetSlice(runtime, widget, executionId, !isRedacted(widget));
  return (
    <WidgetBody
      widget={widget}
      value={value}
      {...(status !== undefined && { status })}
      registry={registry}
      {...(onAction !== undefined && { onAction })}
      {...(check !== undefined && { check })}
    />
  );
};

// Memoized so a container re-render (rare in fiber mode) doesn't cascade; a
// widget only re-renders when its own subscribed slice changes.
export const EagerFiberWidget = React.memo(EagerFiberWidgetInner);

// Same as EagerFiberWidget but defers rendering the latest slice — for
// high-frequency, low-urgency widgets. Built on the SAME tear-free
// useSyncExternalStore subscription as EagerFiberWidget (useWidgetSlice);
// useDeferredValue only defers which VALUE this component renders, so it
// composes with useSyncExternalStore even though startTransition cannot
// (see useDeferredWidgetValue.ts, which streams via startTransition instead
// and stays available for a caller that needs that trade-off).
const DeferredFiberWidgetInner: React.FC<FiberWidgetProps> = ({
  widget,
  runtime,
  executionId,
  registry,
  onAction,
  check,
}) => {
  const slice = useWidgetSlice(runtime, widget, executionId, !isRedacted(widget));
  const deferred = useDeferredValue(slice);
  return (
    <WidgetBody
      widget={widget}
      value={deferred.value}
      {...(deferred.status !== undefined && { status: deferred.status })}
      registry={registry}
      {...(onAction !== undefined && { onAction })}
      {...(check !== undefined && { check })}
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
