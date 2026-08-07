// ── Closing the missing server-push channel ──────────────────────────────────
//
// MCP Apps has NO server push. `ui/notifications/tool-result` fires once when the
// tool completes, and that is the end of the server→View channel. A loom
// execution, meanwhile, streams surface patches for as long as it runs.
//
// The only seam the extension offers is repeatable VIEW-INITIATED `tools/call`,
// combined with `visibility: ["app"]` so the tool never appears in the model's
// tool list. So the View polls a cursor over the durable log.
//
// This is polling, and it is worse than SSE. That is the extension's limitation
// rather than loom's, it is contained behind exactly one tool, and if a future
// revision adds push this same cursor becomes the push source with no change to
// the payload contract. Recorded plainly instead of engineered around.
//
// The cursor is declared `mode: "ambient"` (ADR 0072): it is an enrichment read
// whose count and order are driven by a user, and journaling it would poison
// replay. The declaration is what lets a serving surface route it correctly
// instead of relying on a hardcoded allowlist.

import { readRangeOf } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import type { ComponentInstance } from "@loom/plugin-a2ui";
import type { McpServedTool } from "@loom/plugin-mcp";
import { surfacePayload } from "./surfaceBridge";
import type { SurfacePayload } from "./surfaceBridge";

/** Default id for the app-visibility surface cursor tool. */
export const SURFACE_CURSOR_TOOL = "loom.surface.since";

export interface SurfaceCursorOptions {
  store: EventStore;
  /** The component tree served with every payload. */
  components: ComponentInstance[];
  /** Which agent surface to project. */
  surface?: string;
  /** Egress redaction — required, see {@link SurfacePayloadOptions.redact}. */
  redact: readonly string[];
  /** Tool id/name; defaults to {@link SURFACE_CURSOR_TOOL}. */
  name?: string;
  /**
   * Decide whether this caller may read this execution's surface. **Unset means
   * ANY caller may read ANY executionId they can name** — a rendered View is
   * untrusted, and execution ids are guessable, so wire this in any deployment
   * where surfaces are not uniformly public.
   */
  authorize?: (executionId: string) => boolean | Promise<boolean>;
}

export interface SurfaceCursorInput {
  executionId: string;
  /** Read from this sequence onward; omit or 0 for a full (re)hydrate. */
  fromSequence?: number;
}

/** Highest sequence a single cursor read will fold, bounding one response. */
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

/**
 * Build the app-visibility cursor tool. Register it on an {@link
 * createMcpServer} instance alongside the model-visible tools.
 */
export function surfaceCursorTool(options: SurfaceCursorOptions): McpServedTool {
  return {
    name: options.name ?? SURFACE_CURSOR_TOOL,
    description:
      "Read an execution's agent-surface state from a sequence cursor. App-only; never journaled.",
    inputSchema: {
      type: "object",
      properties: {
        executionId: { type: "string" },
        fromSequence: { type: "number", minimum: 0 },
      },
      required: ["executionId"],
    },
    // App-only: the model never sees or calls this — it is the View's refresh
    // channel, not a capability the agent should reason about.
    ui: { resourceUri: "ui://loom/surface-host", visibility: ["app"] },
    mode: "ambient",
    async handler(args: unknown): Promise<SurfacePayload> {
      const input = (args ?? {}) as Partial<SurfaceCursorInput>;
      if (typeof input.executionId !== "string" || input.executionId.length === 0) {
        throw new Error("executionId must be a non-empty string");
      }
      if (options.authorize !== undefined && !(await options.authorize(input.executionId))) {
        // Same wording as an absent surface: a distinct "forbidden" reply would
        // confirm the execution exists to a caller probing for ids.
        throw new Error(`no surface for execution ${input.executionId}`);
      }

      const from =
        typeof input.fromSequence === "number" && Number.isFinite(input.fromSequence)
          ? Math.max(0, Math.floor(input.fromSequence))
          : 0;

      const events = await readRangeOf(options.store, input.executionId, from, MAX_SEQUENCE);
      return surfacePayload(events, {
        executionId: input.executionId,
        components: options.components,
        redact: options.redact,
        ...(options.surface !== undefined && { surface: options.surface }),
      });
    },
  };
}
