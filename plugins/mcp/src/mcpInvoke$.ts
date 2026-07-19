import { fail, projection$, step$ } from "@loom/core";
import type { EventEnvelope, ProjectionDefinition, StepDefinition } from "@loom/core";
import { ToolEffect } from "@loom/effect-runtime";
import type { EffectRuntime, PrincipalChain } from "@loom/effect-runtime";
import { z } from "zod";
import type { McpClient } from "./McpClient";
import type { MappedMcpTool } from "./types";

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
      return client.callTool(call.toolName, call.args, headers);
    },
    { errors: MCP_INVOKE_ERRORS }
  );

  effectRuntime.register(MCP_INVOKE_TOOL_ID, effect);
  return effect;
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
