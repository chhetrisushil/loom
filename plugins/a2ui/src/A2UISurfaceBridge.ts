import {
  DEFAULT_SURFACE,
  SURFACE_PATCH,
  applySurfacePatches,
  getSurfaceValue,
} from "@loom/agent-surface";
import type { SurfacePatch, SurfacePatchPayload, SurfaceState } from "@loom/agent-surface";
import { maskPaths } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import { DEFAULT_CATALOG_ID } from "./catalog";
import { A2UI_VERSION } from "./messages";
import type {
  A2UIClientMessage,
  A2UIServerMessage,
  ActionPayload,
  ComponentInstance,
  FunctionResponsePayload,
} from "./messages";
import { isAction, isFunctionResponse } from "./messages";
import { dotPathToParts, dotPathToPointer } from "./pointer";

export interface A2UISurfaceBridgeOptions {
  /** Which Loom agent surface to bridge (default `DEFAULT_SURFACE` = "ui"). */
  surface?: string;
  /** Which execution's surface — one bridge tracks exactly one execution. */
  executionId: string;
  /**
   * The A2UI surfaceId emitted on the wire. Defaults to `${surface}:${executionId}`
   * so concurrent executions/surfaces stay addressable on a shared connection.
   */
  a2uiSurfaceId?: string;
  /** Catalog the emitted `component` types are drawn from. */
  catalogId?: string;
  /**
   * The component tree (the "view"). Exactly one node must have `id: "root"`.
   * Sent once in `createSurface`; the data flows separately as `updateDataModel`.
   */
  components: ComponentInstance[];
  /** Catalog-defined surface metadata (e.g. `agentDisplayName`). */
  surfaceProperties?: Record<string, unknown>;
  /**
   * K10-R6 egress redaction — surface dot-paths masked to `[redacted]` before any
   * value leaves for the client. Applied on egress only; the internal fold keeps
   * true values so `increment`/`append`/`merge` stay correct.
   */
  redact?: readonly string[];
}

// ── The egress bridge ──────────────────────────────────────────────────────────
//
// One bridge = one A2UI session for one Loom execution's surface. Feed it the
// Loom event stream; it folds `SURFACE_PATCH` events into the surface state and
// translates each into A2UI wire messages a compliant client can render.
//
// The core translation: Loom's *delta* patch ops (`set`/`merge`/`append`/
// `increment`/`remove`) become A2UI's *absolute value-replacement* semantics.
// A2UI has no patch/delta framework — `updateDataModel` replaces the value at a
// JSON Pointer — so the bridge folds locally and emits the concrete post-patch
// value at each touched path. That is where Loom's event-sourced grain and
// A2UI's replace-at-path model are reconciled.
export class A2UISurfaceBridge {
  private readonly surface: string;
  private readonly executionId: string;
  private readonly a2uiSurfaceId: string;
  private readonly catalogId: string;
  private readonly components: ComponentInstance[];
  private readonly surfaceProperties: Record<string, unknown> | undefined;
  private readonly redact: readonly string[];

  private state: SurfaceState = {};
  private opened = false;

  constructor(options: A2UISurfaceBridgeOptions) {
    this.surface = options.surface ?? DEFAULT_SURFACE;
    this.executionId = options.executionId;
    this.a2uiSurfaceId = options.a2uiSurfaceId ?? `${this.surface}:${this.executionId}`;
    this.catalogId = options.catalogId ?? DEFAULT_CATALOG_ID;
    this.components = options.components;
    this.surfaceProperties = options.surfaceProperties;
    this.redact = options.redact ?? [];
  }

  /** The A2UI surfaceId this bridge emits/accepts on the wire. */
  get surfaceId(): string {
    return this.a2uiSurfaceId;
  }

  // Redacted egress view of the current state (unredacted state is kept internally
  // so folds stay correct). Idempotent — re-masking a `[redacted]` value is a no-op.
  private view(): SurfaceState {
    return this.redact.length > 0
      ? (maskPaths(this.state, this.redact) as SurfaceState)
      : this.state;
  }

  private createSurface(): A2UIServerMessage {
    return {
      version: A2UI_VERSION,
      createSurface: {
        surfaceId: this.a2uiSurfaceId,
        catalogId: this.catalogId,
        components: this.components,
        dataModel: this.view(),
        ...(this.surfaceProperties !== undefined && {
          surfaceProperties: this.surfaceProperties,
        }),
      },
    };
  }

  /**
   * The full initial handshake for a (possibly late-joining) client: a single
   * `createSurface` carrying the component tree and the current data model.
   * Idempotent bookkeeping — marks the session opened so `handleEvent` emits
   * incremental `updateDataModel`s thereafter.
   */
  snapshot(): A2UIServerMessage[] {
    this.opened = true;
    return [this.createSurface()];
  }

  /**
   * Fold one Loom event and return the A2UI messages to forward to the client.
   * Non-matching events (wrong type/execution/surface) return `[]`. The first
   * matching event auto-opens the session with a `createSurface` carrying the
   * folded data; subsequent events emit one `updateDataModel` per patch.
   */
  handleEvent(event: EventEnvelope): A2UIServerMessage[] {
    if (event.eventType !== SURFACE_PATCH) return [];
    if (event.executionId !== this.executionId) return [];
    const payload = event.payload as SurfacePatchPayload;
    const targetSurface = payload.surface ?? DEFAULT_SURFACE;
    if (targetSurface !== this.surface) return [];

    if (!this.opened) {
      // First event: fold, then deliver the initial state via createSurface.
      this.state = applySurfacePatches(this.state, payload.patches);
      this.opened = true;
      return [this.createSurface()];
    }

    // Fold incrementally, emitting the concrete post-patch value per patch so a
    // batch of deltas becomes an ordered run of absolute A2UI updates.
    const messages: A2UIServerMessage[] = [];
    for (const patch of payload.patches) {
      this.state = applySurfacePatches(this.state, [patch]);
      messages.push(this.toUpdate(patch));
    }
    return messages;
  }

  private toUpdate(patch: SurfacePatch): A2UIServerMessage {
    const path = dotPathToPointer(patch.path);
    // `remove` deletes the key — A2UI models removal as an upsert to `null`.
    const contents =
      patch.op === "remove" ? null : getSurfaceValue(this.view(), dotPathToParts(patch.path));
    return {
      version: A2UI_VERSION,
      updateDataModel: { surfaceId: this.a2uiSurfaceId, path, contents },
    };
  }

  /** Tear down the surface on the client. */
  close(): A2UIServerMessage[] {
    return [{ version: A2UI_VERSION, deleteSurface: { surfaceId: this.a2uiSurfaceId } }];
  }

  /**
   * Normalize an inbound client message into an action for THIS surface, or
   * `null` if it isn't an `action` targeting this bridge. The caller decides how
   * to turn the returned action into a Loom inbound event (e.g. resume a gate).
   */
  ingestAction(message: A2UIClientMessage): ActionPayload | null {
    if (!isAction(message)) return null;
    const { action } = message;
    if (action.surfaceId !== this.a2uiSurfaceId) return null;
    return action;
  }

  /**
   * Emit a `callFunction` request asking the client to invoke a named catalog
   * function and answer with a `functionResponse`.
   *
   * The bridge is deliberately clock- and random-free (like the rest of its
   * surface — it never calls `Date.now`/`Math.random`), so the correlation
   * `callId` is caller-supplied and MUST be deterministic: derive it from the
   * calling step (grain A: `ctx.stepId`; grain B: `ctx.idempotencyKey`, i.e.
   * `executionId:stepId`). A crash-recovered re-issue then reuses the same
   * `callId`, letting the client dedup — the K9 delivery contract on the wire.
   */
  callFunction(
    name: string,
    args: unknown,
    opts: { callId: string; callableFrom?: string }
  ): A2UIServerMessage {
    return {
      version: A2UI_VERSION,
      callFunction: {
        surfaceId: this.a2uiSurfaceId,
        callId: opts.callId,
        name,
        ...(args !== undefined && { args }),
        ...(opts.callableFrom !== undefined && { callableFrom: opts.callableFrom }),
      },
    };
  }

  /**
   * Normalize an inbound client message into a `functionResponse` for THIS
   * surface, or `null` if it isn't a `functionResponse` targeting this bridge.
   * Twin of {@link ingestAction}: the plugin creates no Loom event itself — the
   * caller maps the returned payload to a resume event (grain A) or resolves the
   * awaiting `a2ui.callFunction` effect by `callId` (grain B).
   */
  ingestFunctionResponse(message: A2UIClientMessage): FunctionResponsePayload | null {
    if (!isFunctionResponse(message)) return null;
    const { functionResponse } = message;
    if (functionResponse.surfaceId !== this.a2uiSurfaceId) return null;
    return functionResponse;
  }
}
