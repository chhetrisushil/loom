import {
  DEFAULT_SURFACE,
  SURFACE_PATCH,
  applySurfacePatches,
  getSurfaceValue,
} from "@loom/agent-surface";
import type { SurfacePatch, SurfacePatchPayload, SurfaceState } from "@loom/agent-surface";
import { preservesNodes } from "@loom/blueprint-runtime";
import type { IdentityReport } from "@loom/blueprint-runtime";
import { maskPaths } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import { DEFAULT_CATALOG_ID, defaultCatalog } from "./catalog";
import type { A2UICatalog } from "./catalog";
import { describeFindings, validateComponents, validateFunctionCall } from "./conformance";
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
  /**
   * The catalogue the emitted `component` types are drawn from. Defaults to
   * `defaultCatalog`. Supplying it is what makes `catalogId` a claim the bridge
   * can check rather than a label it merely stamps.
   */
  catalog?: A2UICatalog;
  /**
   * The catalogue id, when the catalogue itself is not supplied.
   *
   * Naming a catalogue without supplying it is REFUSED at construction: the
   * bridge would otherwise stamp an id it cannot verify a single component
   * against, which is the defect this option's checking exists to close. Pass
   * `catalog` instead; `catalogId` is then redundant and must agree with it.
   */
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
  private readonly catalog: A2UICatalog;
  private readonly catalogId: string;
  private components: ComponentInstance[];
  private readonly surfaceProperties: Record<string, unknown> | undefined;
  private readonly redact: readonly string[];

  private state: SurfaceState = {};
  private opened = false;

  constructor(options: A2UISurfaceBridgeOptions) {
    this.surface = options.surface ?? DEFAULT_SURFACE;
    this.executionId = options.executionId;
    this.a2uiSurfaceId = options.a2uiSurfaceId ?? `${this.surface}:${this.executionId}`;
    this.catalog = options.catalog ?? defaultCatalog;
    if (options.catalog === undefined && options.catalogId !== undefined) {
      if (options.catalogId !== DEFAULT_CATALOG_ID) {
        throw new Error(
          `A2UISurfaceBridge: catalogId "${options.catalogId}" was named but the catalogue was not supplied, so no component can be checked against it. Pass \`catalog\` instead.`
        );
      }
    } else if (options.catalogId !== undefined && options.catalogId !== this.catalog.id) {
      throw new Error(
        `A2UISurfaceBridge: catalogId "${options.catalogId}" disagrees with the supplied catalogue's id "${this.catalog.id}".`
      );
    }
    this.catalogId = this.catalog.id;
    // The initial tree carries the whole view, so it must name its root. Checked
    // here rather than on first emit: construction is the earliest point at which
    // the failure can be attributed to the code that caused it.
    this.assertConformant(options.components, true);
    this.components = options.components;
    this.surfaceProperties = options.surfaceProperties;
    this.redact = options.redact ?? [];
  }

  /**
   * Refuse a component tree the declared catalogue does not cover. Throws rather
   * than dropping the message: a bridge that silently emitted nothing would turn
   * an authoring bug into a surface that never updates, which is the silent
   * omission this whole seam exists to prevent. Callers that want to degrade
   * instead can run `validateComponents` first and act on the report.
   */
  private assertConformant(components: readonly ComponentInstance[], requireRoot: boolean): void {
    const report = validateComponents(components, this.catalog, { requireRoot });
    if (!report.ok) {
      throw new Error(
        `A2UISurfaceBridge: component tree does not conform to catalogue "${this.catalog.id}" — ${describeFindings(report)}`
      );
    }
  }

  /**
   * Replace the surface's component tree — the STRUCTURAL update, as opposed to
   * the data updates `handleEvent` produces.
   *
   * This is what a recomposition is: a new panel beside an existing one, an
   * agent's proposal rendered into a surface already open, a view the user edited
   * before approving. A2UI models it as `updateComponents`, whose payload type
   * this plugin has always declared and never produced — so until now the
   * component tree was fixed for the life of a session.
   *
   * Before the session is open there is no client to update: the new tree simply
   * becomes the one the pending `createSurface` will carry, and no message is
   * emitted. That is why the root requirement is checked at construction and not
   * here — an `updateComponents` batch may legitimately replace a subtree.
   */
  recompose(components: ComponentInstance[]): A2UIServerMessage[] {
    this.assertConformant(components, false);
    this.components = components;
    if (!this.opened) return [];
    return [
      {
        version: A2UI_VERSION,
        updateComponents: { surfaceId: this.a2uiSurfaceId, components },
      },
    ];
  }

  /**
   * Which component ids a proposed `recompose` would drop — a pure query, run BEFORE
   * committing to the new tree.
   *
   * A client keys its rendered components by id, so an id present before and absent after
   * is a component the client unmounts and rebuilds: state inside it is discarded, and
   * anything that referenced it — a pin, an annotation, a runbook step naming the panel —
   * now points at nothing. That is correct when a subtree is genuinely being replaced and
   * a defect when a composer merely edited a prop and re-emitted the tree, and the bridge
   * cannot tell those apart. So it reports, exactly as `validateComponents` does, and the
   * caller decides.
   *
   * Shares `preservesNodes` with `@loom/blueprint-runtime` rather than reimplementing the
   * diff: the same question is asked of a composed Blueprint's widget ids
   * ([ADR 0094](../../../docs/adr/0094-blueprint-node-identity.md)), and one answer that
   * both surfaces agree on is the point.
   */
  identityDiff(next: readonly ComponentInstance[]): IdentityReport {
    return preservesNodes(
      this.components.map((c) => c.id),
      next.map((c) => c.id)
    );
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
   * `callId` is caller-supplied and MUST be:
   *   1. **deterministic** (never random) — a crash-recovered re-issue reuses the
   *      same `callId`, letting the client dedup (the K9 delivery contract on the
   *      wire); and
   *   2. **call-site-unique** — two calls in one execution, *even of the same
   *      function*, must carry distinct `callId`s, or their request/response
   *      correlation collides. This mirrors the step-identity rule (ADR 0061).
   *
   * Grain B (a delegated `a2ui.callFunction` effect) gets both for free: use
   * `ctx.idempotencyKey` (= `executionId:stepId`, and each `ctx.execute` has a
   * distinct step id). Grain A (a suspend gate) has no step id, so the flow
   * author mints the id per call site — e.g. `` `${ctx.executionId}:getLocale#1` ``,
   * NOT `` `${ctx.executionId}:getLocale` `` (which would collide on a second call).
   */
  callFunction(
    name: string,
    args: unknown,
    opts: { callId: string; callableFrom?: string }
  ): A2UIServerMessage {
    // A catalogue is the client's contract for what it will answer. Emitting a
    // call it never declared produces a request no compliant client can honour,
    // and the flow then waits on a response that is not coming.
    const report = validateFunctionCall(name, this.catalog);
    if (!report.ok) {
      throw new Error(`A2UISurfaceBridge: ${describeFindings(report)}`);
    }
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
   *
   * SECURITY: a client controls this message, so a reply is only as trustworthy
   * as its correlation. Pass `expectedCallId` (the id of the request you actually
   * issued) to reject a forged or replayed response — without it this checks only
   * the surface, so an unsolicited reply for an arbitrary `callId` would pass and
   * (if the caller resumes a gate with it) let the client inject data. Always
   * pass it when the pending request's id is known.
   */
  ingestFunctionResponse(
    message: A2UIClientMessage,
    expectedCallId?: string
  ): FunctionResponsePayload | null {
    if (!isFunctionResponse(message)) return null;
    const { functionResponse } = message;
    if (functionResponse.surfaceId !== this.a2uiSurfaceId) return null;
    if (expectedCallId !== undefined && functionResponse.callId !== expectedCallId) return null;
    return functionResponse;
  }
}
