import { tainted } from "@loom/classify";
import { fail, projection$, step$ } from "@loom/core";
import type { EventEnvelope, ProjectionDefinition, StepDefinition } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import type { EffectRuntime, PrincipalChain } from "@loom/effect-runtime";
import { z } from "zod";
import type { McpClient } from "./McpClient";
import { projectToolResult, throwIfToolError } from "./McpClient";
import type { MappedMcpTool, McpCallToolResult, McpResultFidelity } from "./types";
import { toUiResource, uiFromResult } from "./ui";

// ── ADR 0063 — MCP dynamic dispatch with schema-hash pinning ─────────────────
//
// ONE registered effect (`mcp.invoke`); tool name + args are RUNTIME DATA on
// dynamically-minted steps (the ADR 0061 interpreter idiom — never an effect
// per tool, so the static registry stays static, P5). The safety loop: pin a
// tool's `schemaHash` at plan time (from `listTools`), verify per call, fail
// TYPED on drift (ADR 0060) — recorded, replay-substituted, branchable into
// repair without re-invoking the backend.

/** The single registered effect id every mcpInvoke$ step dispatches through. */
export const MCP_INVOKE_TOOL_ID = "mcp.invoke";

/**
 * Userspace domain event recorded per successful dispatch (the fold skips
 * unknown types — no EVENT_SCHEMA change). Index it with a read-model/
 * projection ({@link mcpDispatchIndex}) — never by parsing argument blobs.
 */
export const MCP_DISPATCHED = "MCP_DISPATCHED";

/**
 * Userspace domain event recorded when a dispatched tool's result carries an
 * MCP Apps (`io.modelcontextprotocol/ui`) declaration — the resource URI, and
 * the content-hash pin when one could be obtained.
 *
 * A SEPARATE event rather than a field on {@link MCP_DISPATCHED}, for two
 * reasons. `MCP_DISPATCHED` is emitted BEFORE the call so a failed attempt is
 * still indexed for proactive repair; UI provenance is only knowable after it,
 * and moving the emit to close that gap would silently drop failures from the
 * repair index. And a UI is the exception, not the rule — most dispatches carry
 * none, and an always-present-but-usually-empty field reads as coverage.
 *
 * The fold skips unknown types, so this is no EVENT_SCHEMA change (ADR 0063 D4).
 */
export const MCP_UI_OBSERVED = "MCP_UI_OBSERVED";

/**
 * How the `contentHash` on {@link MCP_UI_OBSERVED} was obtained — or why there
 * isn't one. Four explicit states rather than an absent field, because "no
 * pin" is ambiguous between *not asked for*, *asked for and unavailable*, and
 * *free because the server inlined it*, and a pin is a correctness device.
 *
 * - `embedded` — the result inlined the `ui://` resource; hashed at no cost.
 * - `resolved` — `resolveUi` was set and `resources/read` returned a body.
 * - `not-requested` — a UI was declared; `resolveUi` was off, so it was not fetched.
 * - `unresolvable` — `resolveUi` was set and the server produced no body.
 */
export type McpUiPin = "embedded" | "resolved" | "not-requested" | "unresolvable";

export interface McpUiObservedPayload {
  toolName: string;
  resourceUri: string;
  /** `fnv1a64:<hex16>` over the resource body; absent unless `pin` says otherwise. */
  contentHash?: string;
  pin: McpUiPin;
}

export const SchemaDriftPayload = z.object({
  toolName: z.string(),
  expectedSchemaHash: z.string(),
  observedHash: z.string(),
});

export const ToolNotFoundPayload = z.object({
  toolName: z.string(),
});

/** Declared failure channels (ADR 0060) — registry-level, so every minted step inherits them. */
export const MCP_INVOKE_ERRORS = {
  schemaDrift: SchemaDriftPayload,
  toolNotFound: ToolNotFoundPayload,
};

/**
 * The step input. `authToken` is the per-call credential FALLBACK and MUST be a
 * `secretRef(...)` (K10.3) in the logged input — `redactionMiddleware` resolves
 * it to the raw token only inside the effect, so STEP_STARTED records the
 * reference, never the credential. The PRIMARY path is the opaque K12.1
 * `ctx.principal`, which never appears in the input at all.
 *
 * ENFORCEMENT (audit SEC-1): a string `authToken` reaching the effect is
 * ambiguous — either the wired redaction middleware resolved a secretRef
 * (safe: the log holds the ref), or a caller passed a raw credential (which
 * STEP_STARTED has already persisted into the immutable log). The effect
 * therefore REJECTS string tokens unless `acceptResolvedTokens: true` is set —
 * the explicit assertion that redactionMiddleware is wired and callers pass
 * refs. The default turns a silent permanent credential leak into a loud,
 * immediate error.
 */
export const McpInvokeInput = z.object({
  toolName: z.string(),
  args: z.unknown().optional(),
  /** Pin from the Agent Registry / a prior listTools; omit to skip verification. */
  expectedSchemaHash: z.string().optional(),
  /** A secretRef (resolved by redactionMiddleware) — never a raw token. */
  authToken: z.unknown().optional(),
});

/** Structural K10.3 SecretRef check (kept local so the plugin stays middleware-free at runtime). */
function isSecretRefShape(value: unknown): value is { __loomSecret: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { __loomSecret?: unknown }).__loomSecret === "string"
  );
}

export type McpInvokeInputValue = z.infer<typeof McpInvokeInput>;

export interface McpInvokeOptions {
  /** Server label recorded on MCP_DISPATCHED (defaults to the client's URL host if omitted). */
  server?: string;
  /** listTools snapshot TTL for name/hash lookups. Default 60s. */
  toolsTtlMs?: number;
  /** K12.1 primary path: map the opaque principal chain to transport headers. */
  principalToHeaders?: (principal: PrincipalChain) => Record<string, string>;
  /** Fallback: map a resolved per-call token to headers. Default: `authorization: Bearer <token>`. */
  tokenToHeaders?: (token: string) => Record<string, string>;
  /**
   * Audit SEC-1 — assert that redactionMiddleware is wired and every caller
   * passes `authToken` as a secretRef, so a string token reaching the effect is
   * a middleware-RESOLVED credential (never logged raw). Without this flag,
   * string tokens are rejected loudly. Default false (safe).
   */
  acceptResolvedTokens?: boolean;
  /**
   * What a dispatched step yields — see {@link McpResultFidelity}. Default
   * `"value"`; set `"full"` to observe `_meta.ui`, embedded `ui://` resources,
   * or non-text content blocks from a flow.
   *
   * Independent of {@link resolveUi}: the effect always reads the full result
   * internally (that is where a UI declaration lives), and this option only
   * decides what it hands back.
   */
  resultFidelity?: McpResultFidelity;
  /**
   * Fetch a declared-but-not-inlined `ui://` resource to pin its content hash
   * on {@link MCP_UI_OBSERVED}. Costs ONE extra `resources/read` per dispatch
   * that declares a UI, which is why it is opt-in rather than the default; an
   * INLINED resource is hashed for free and needs no flag.
   *
   * A failed or empty read never fails the dispatch — the tool call already
   * succeeded and its side effect already happened. The gap is recorded as
   * `pin: "unresolvable"` instead.
   */
  resolveUi?: boolean;
  /**
   * Wrap every result as untrusted (`@loom/classify`'s `tainted`), stamped with
   * origin `mcp:<server>/<toolName>`. The prompt boundary in `@loom/llm` then
   * REFUSES that content in any instruction position — system prompt, assistant
   * turn, tool description — and fences it in a `user` message.
   *
   * A third-party MCP server writes the text its tools return, so any of it may
   * be an instruction aimed at whatever model reads it next. This is the switch
   * that makes that fact travel with the value instead of being a comment in a
   * design doc.
   *
   * Off by default because it changes the step's output SHAPE: consumers see
   * `{ __loomTainted, value }` and must `unwrapTainted()` to compute with it.
   * That friction is the point — every unwrap is a visible place where
   * provenance stops travelling.
   */
  taintResults?: boolean;
}

/**
 * Register the `mcp.invoke` effect. Channels are declared at the registry level
 * (`Effect.errors`), so dynamically-minted steps get typed `schemaDrift`/
 * `toolNotFound` failures with no per-step declaration.
 */
export function registerMcpInvoke(
  client: McpClient,
  effectRuntime: EffectRuntime,
  options: McpInvokeOptions = {}
): ToolEffect {
  const ttlMs = options.toolsTtlMs ?? 60_000;
  const fidelity = options.resultFidelity ?? "value";
  const tokenToHeaders =
    options.tokenToHeaders ?? ((token: string) => ({ authorization: `Bearer ${token}` }));

  // Audit PERF-A2 — single-flight refresh: concurrent invokes at TTL expiry
  // (exactly the fanout$ case) share ONE listTools round-trip instead of a
  // thundering herd of K RPCs + K re-hashes with K−1 snapshots discarded.
  let snapshot: { at: number; byName: Map<string, MappedMcpTool> } | undefined;
  let refreshing: Promise<Map<string, MappedMcpTool>> | undefined;
  const toolsByName = (): Promise<Map<string, MappedMcpTool>> => {
    if (snapshot !== undefined && Date.now() - snapshot.at <= ttlMs) {
      return Promise.resolve(snapshot.byName);
    }
    refreshing ??= client
      .listTools()
      .then((tools) => {
        snapshot = { at: Date.now(), byName: new Map(tools.map((t) => [t.definition.id, t])) };
        return snapshot.byName;
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };

  const effect = new ToolEffect(
    async (input: unknown, ctx) => {
      const call = McpInvokeInput.parse(input);
      const tool = (await toolsByName()).get(call.toolName);
      if (tool === undefined) {
        fail("toolNotFound", { toolName: call.toolName });
      }
      if (call.expectedSchemaHash !== undefined && tool.schemaHash !== call.expectedSchemaHash) {
        fail("schemaDrift", {
          toolName: call.toolName,
          expectedSchemaHash: call.expectedSchemaHash,
          observedHash: tool.schemaHash,
        });
      }

      // Principal → transport headers, inside the effect only. Primary: the
      // opaque ctx.principal chain (never logged anywhere). Fallback: a
      // redaction-resolved per-call token (logged only as its secretRef).
      let headers: Record<string, string> | undefined;
      if (ctx.principal !== undefined && options.principalToHeaders !== undefined) {
        headers = options.principalToHeaders(ctx.principal);
      } else if (call.authToken !== undefined) {
        if (isSecretRefShape(call.authToken)) {
          // An UNRESOLVED ref reached the effect: redactionMiddleware is not wired.
          throw new Error(
            "mcpInvoke: authToken secretRef was not resolved — wire redactionMiddleware (K10.3) or use principalToHeaders (ADR 0063)"
          );
        }
        if (typeof call.authToken === "string") {
          if (options.acceptResolvedTokens !== true) {
            throw new Error(
              "mcpInvoke: string authToken rejected — pass a secretRef and wire redactionMiddleware, then set acceptResolvedTokens:true. A raw token here would already be persisted in STEP_STARTED; if one was passed, rotate it (ADR 0063, audit SEC-1)"
            );
          }
          headers = tokenToHeaders(call.authToken);
        }
      }

      ctx.emit(MCP_DISPATCHED, {
        toolName: call.toolName,
        schemaHash: tool.schemaHash,
        ...(options.server !== undefined && { server: options.server }),
      });

      // ADR 0072 D3 — read the FULL result unconditionally. A UI declaration
      // lives in `_meta.ui` or an embedded `ui://` content block, and both are
      // erased by the convenience projection, so a `callTool` here would make
      // the whole ingress layer unobservable from the log (which is exactly
      // what it was). Fidelity decides only what is HANDED BACK.
      const result = await client.callToolResult(call.toolName, call.args, headers);
      throwIfToolError(call.toolName, result);

      const observed = await observeUi(client, call.toolName, tool, result, options.resolveUi);
      if (observed !== undefined) ctx.emit(MCP_UI_OBSERVED, observed);

      const value = fidelity === "full" ? result : projectToolResult(call.toolName, result);
      // Taint at INGRESS — the moment third-party content crosses in. The
      // wrapper IS the step output, so it is what STEP_COMPLETED records and
      // what a replay hands back; tainting anywhere later would be a guess.
      return options.taintResults === true
        ? tainted(value, `mcp:${options.server ?? "server"}/${call.toolName}`)
        : value;
    },
    { errors: MCP_INVOKE_ERRORS }
  );

  effectRuntime.register(MCP_INVOKE_TOOL_ID, effect);
  return effect;
}

/**
 * The MCP Apps declaration this dispatch carried, if any — the ADR 0072 D3
 * "carry, never render" half, made observable from the log.
 *
 * A UI can be declared in three places, and they are consulted in decreasing
 * authority: the RESULT's `_meta.ui` (what this call actually returned), an
 * inlined `ui://` content block, then the TOOL's static declaration from
 * `tools/list`. Returns `undefined` when none of them names one, so a
 * non-UI dispatch emits nothing at all rather than an empty marker.
 */
async function observeUi(
  client: McpClient,
  toolName: string,
  tool: MappedMcpTool,
  result: McpCallToolResult,
  resolveUi: boolean | undefined
): Promise<McpUiObservedPayload | undefined> {
  const { meta, embedded } = uiFromResult(result);
  const resourceUri = meta?.resourceUri ?? embedded[0]?.uri ?? tool.ui?.resourceUri;
  if (resourceUri === undefined) return undefined;

  // Inlined body ⇒ pin for free, no round-trip. `toUiResource` rather than a
  // local hash call, so egress, ingress and this path share ONE hashing
  // implementation (the ADR 0063 D1 lesson — a second one that mostly agrees
  // is how a pin silently stops detecting drift).
  const inlined = embedded.find((r) => r.uri === resourceUri);
  if (inlined !== undefined) {
    return {
      toolName,
      resourceUri,
      contentHash: toUiResource(inlined).contentHash,
      pin: "embedded",
    };
  }

  if (resolveUi !== true) return { toolName, resourceUri, pin: "not-requested" };

  // The dispatch already succeeded and its side effect already happened; a
  // template we cannot fetch is a provenance gap, never a retroactive failure.
  try {
    const fetched = await client.readUiResource(resourceUri);
    return fetched === undefined
      ? { toolName, resourceUri, pin: "unresolvable" }
      : { toolName, resourceUri, contentHash: fetched.contentHash, pin: "resolved" };
  } catch {
    return { toolName, resourceUri, pin: "unresolvable" };
  }
}

/**
 * Mint a step dispatching through `mcp.invoke`. Ids follow the ADR 0061
 * identity rule when minted in loops (`` mcpInvoke$(`hydrate#${i}`) ``); the
 * tool name/args/pin ride in the RUN-TIME input, so a blueprint's dispatch
 * targets are data, never registrations.
 */
export function mcpInvoke$(id: string): StepDefinition<McpInvokeInputValue, unknown> {
  return step$<McpInvokeInputValue, unknown>({
    id,
    name: id,
    toolId: MCP_INVOKE_TOOL_ID,
    inputSchema: McpInvokeInput,
    outputSchema: z.unknown(),
    errors: MCP_INVOKE_ERRORS,
  });
}

// ── The dispatch index (ADR 0063 D4) ─────────────────────────────────────────

export interface McpDispatchIndexState {
  /**
   * toolName → the executions that dispatched it and every schema hash
   * observed. `seen` is the O(1) membership companion of the two ordered
   * arrays (audit PERF-A3 — `includes` scans made the fold O(E²) per hot
   * tool); keys are `x:<executionId>` / `h:<schemaHash>`. Plain JSON so the
   * read-model plugin persists it as-is. Growth is one entry per distinct
   * (tool, execution) pair by design — retention rides the read-model store's
   * lifecycle, not this fold.
   */
  byTool: Record<
    string,
    { executions: string[]; schemaHashes: string[]; seen: Record<string, true> }
  >;
}

/**
 * The proactive-repair query — "which executions called tool X, at which schema
 * version" — as a plain projection over MCP_DISPATCHED. Wire it to the
 * projection runtime or the read-model plugin (ADR 0058); this is the indexed
 * path, NOT log parsing.
 */
export const mcpDispatchIndex: ProjectionDefinition<McpDispatchIndexState> = projection$({
  id: "mcp-dispatch-index",
  name: "mcp-dispatch-index",
  initialState: { byTool: {} },
  handlers: {
    [MCP_DISPATCHED]: (state: McpDispatchIndexState, event: EventEnvelope) => {
      const payload = event.payload as { toolName: string; schemaHash: string };
      const entry = state.byTool[payload.toolName] ?? {
        executions: [],
        schemaHashes: [],
        seen: {},
      };
      const executionKey = `x:${event.executionId}`;
      const hashKey = `h:${payload.schemaHash}`;
      const newExecution = entry.seen[executionKey] === undefined;
      const newHash = entry.seen[hashKey] === undefined;
      if (!newExecution && !newHash) return state; // O(1) no-op for repeat dispatches
      return {
        byTool: {
          ...state.byTool,
          [payload.toolName]: {
            executions: newExecution ? [...entry.executions, event.executionId] : entry.executions,
            schemaHashes: newHash
              ? [...entry.schemaHashes, payload.schemaHash]
              : entry.schemaHashes,
            seen: {
              ...entry.seen,
              ...(newExecution && { [executionKey]: true as const }),
              ...(newHash && { [hashKey]: true as const }),
            },
          },
        },
      };
    },
  },
});
