import type { ExecutionState } from "@loom/core";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import type { WorkflowRuntime } from "@loom/workflow-runtime";
import { deserializeExecution, deserializeProjections } from "@loom/workflow-runtime";
import type React from "react";
import { createContext, useContext, useRef } from "react";
import type { FiberConfig } from "./fiber/types";

interface LoomContextValue {
  projectionRuntime: ProjectionRuntime;
  workflowRuntime: WorkflowRuntime;
  preloadedExecutionState: ExecutionState | null;
  // Optional default render-side fiber config; a BlueprintRenderer `fiber` prop
  // overrides it.
  fiber?: FiberConfig;
}

// Exported so BlueprintRenderer can read an optional default WITHOUT the throwing
// useLoom() — the renderer must keep working with no provider (as in tests).
export const LoomContext = createContext<LoomContextValue | null>(null);

interface LoomProviderProps {
  projectionRuntime: ProjectionRuntime;
  workflowRuntime: WorkflowRuntime;
  serializedExecutionState?: string;
  serializedProjectionState?: string;
  fiber?: FiberConfig;
  children: React.ReactNode;
}

export function LoomProvider({
  projectionRuntime,
  workflowRuntime,
  serializedExecutionState,
  serializedProjectionState,
  fiber,
  children,
}: LoomProviderProps) {
  // Seed projection state synchronously on the first render so child
  // components never see an empty-state flash.
  const seededRef = useRef(false);
  if (!seededRef.current && serializedProjectionState) {
    const snapshot = deserializeProjections(serializedProjectionState);
    for (const [projId, state] of Object.entries(snapshot.states)) {
      projectionRuntime.seedState(projId, snapshot.executionId, state);
    }
    seededRef.current = true;
  }

  const preloadedExecutionState = serializedExecutionState
    ? deserializeExecution(serializedExecutionState)
    : null;

  return (
    <LoomContext.Provider
      value={{
        projectionRuntime,
        workflowRuntime,
        preloadedExecutionState,
        ...(fiber !== undefined && { fiber }),
      }}
    >
      {children}
    </LoomContext.Provider>
  );
}

export function useLoom(): LoomContextValue {
  const ctx = useContext(LoomContext);
  if (!ctx) throw new Error("useLoom must be used within <LoomProvider>");
  return ctx;
}
