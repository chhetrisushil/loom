import { createAgentModelEffect } from "@loom/agent";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, GrantTable, ToolEffect } from "@loom/effect-runtime";
import type { PrincipalChain } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamChunk } from "@loom/llm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, executionAccessPolicy } from "@loom/workflow-runtime";
import type { ExecutionAuthorizer, WorkflowRuntimeDeps } from "@loom/workflow-runtime";
import { z } from "zod";
import { signedEnvelope } from "../conversation";
import {
  type ConversationConfig,
  ConversationHub,
  type Identity,
  type SharedConfig,
  conversation$,
  createConversations,
  inboxBargeIn,
  logParticipants,
} from "../index";

/** The user text of a request's last message, with the prompt-boundary fence stripped. */
export function lastUserText(request: LlmRequest): string {
  const last = request.messages[request.messages.length - 1];
  const c = last?.content;
  const text = typeof c === "string" ? c : JSON.stringify(c);
  const m = /<untrusted-input[^>]*>([\s\S]*?)<\/untrusted-input>/.exec(text);
  return (m?.[1] ?? text).trim();
}

export class Latch {
  private open!: () => void;
  readonly promise = new Promise<void>((r) => {
    this.open = r;
  });
  release(): void {
    this.open();
  }
}

/** Wait on a condition (never a fixed sleep). */
export async function until(
  cond: () => boolean | Promise<boolean>,
  what = "condition",
  ms = 5000
): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

export interface BootOptions {
  /** Provider behaviour; default echoes `re: <text>`. */
  reply?: (request: LlmRequest, nth: number) => LlmResponse | Promise<LlmResponse>;
  config?: Partial<ConversationConfig>;
  store?: EventStore;
  runtime?: Partial<WorkflowRuntimeDeps>;
  secure?: boolean;
  /** The execution authorizer when `secure` (default: the reference policy, tenant scope). */
  policy?: ExecutionAuthorizer;
  /** Assert the (custom) policy is owner-scoped although it cannot be inspected: for tests that loosen it on purpose. */
  ackPolicy?: boolean;
  /** Pass the createConversations options through (e.g. `principalFor`, `maxQueuedPerAsker`). */
  conversations?: Record<string, unknown>;
  hub?: ConversationHub;
  /** A streaming provider: yields the chunks of a reply (the terminal `done` chunk included). */
  chunks?: (request: LlmRequest, nth: number) => AsyncIterable<LlmStreamChunk>;
  extraEffects?: (e: EffectRuntime) => void;
  /**
   * SHARED mode (ADR 0122 D10). Implies `secure`. The agent gets two tools, `kb` (class "public") and
   * `secret-db` (class "restricted"); K2 grants are per ASKER (alice: both, bob: kb only, carol: kb only);
   * a viewer is cleared for "restricted" only if they are alice or dave.
   */
  shared?: Partial<SharedConfig> | true;
}

export const TEST_KEY = "test-envelope-key";
export const SERVICE: PrincipalChain = { actor: "conversation-service", tenant: "svc" };
/** The reference policy, OWNER-scoped for everything a conversation's log must be protected by. */
export const ownerScoped = () =>
  executionAccessPolicy({
    rules: { query: "owner", send: "owner", cancel: "owner", resume: "owner" },
  });
export const carol: PrincipalChain = { actor: "carol", tenant: "t2" };
export const dave: PrincipalChain = { actor: "dave", tenant: "t3" };
export const SECRET = "TOP-SECRET-PAYLOAD";

export const kb = tool$({
  id: "kb",
  name: "kb",
  description: "public knowledge base",
  kind: "tool",
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.any(),
});
export const secretDb = tool$({
  id: "secret-db",
  name: "secret-db",
  description: "restricted database",
  kind: "tool",
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.any(),
});

/** The default shared-mode model: calls a tool when the user text asks, then answers with what it got. */
export function sharedScript(request: LlmRequest): LlmResponse {
  const last = request.messages[request.messages.length - 1];
  const parts = Array.isArray(last?.content) ? last.content : [];
  const results = parts.filter((p) => (p as { type?: string }).type === "tool_result");
  if (results.length > 0) {
    return {
      content: `answer: ${JSON.stringify(results.map((r) => (r as { content: unknown }).content))}`,
      stopReason: "end_turn",
    };
  }
  const text = lastUserText(request);
  const name = text.includes("secret") ? "secret-db" : text.includes("kb") ? "kb" : undefined;
  return name === undefined
    ? { content: `re: ${text}`, stopReason: "end_turn" }
    : { content: "", toolCalls: [{ id: `c-${name}`, name, input: {} }], stopReason: "tool_use" };
}

export const alice: PrincipalChain = { actor: "alice", tenant: "t1" };
export const bob: PrincipalChain = { actor: "bob", tenant: "t1" };
export const mallory: PrincipalChain = { actor: "mallory", tenant: "t2" };

export function boot(opts: BootOptions = {}) {
  const requests: LlmRequest[] = [];
  const calls = { n: 0 };
  const provider: LlmProvider = {
    async complete(request) {
      calls.n++;
      requests.push(request);
      return (
        (await opts.reply?.(request, calls.n)) ??
        (opts.shared !== undefined
          ? sharedScript(request)
          : {
              content: `re: ${lastUserText(request)}`,
              stopReason: "end_turn",
            })
      );
    },
  };
  if (opts.chunks !== undefined) {
    const chunks = opts.chunks;
    provider.stream = (request) => {
      calls.n++;
      requests.push(request);
      return chunks(request, calls.n);
    };
  }
  const hub = opts.hub ?? new ConversationHub();
  const sharedOpts =
    opts.shared === undefined ? undefined : opts.shared === true ? {} : opts.shared;
  const secure = opts.secure === true || sharedOpts !== undefined;
  const effects = new EffectRuntime(
    [],
    sharedOpts !== undefined
      ? {
          authorizer: new GrantTable(
            {
              // the SERVICE principal owns the coordinator: it only coordinates (runs turns, summarizes)
              "conversation-service": ["conversation.turn", "summarize", "audit"],
              alice: ["model", "kb", "secret-db", "summarize", "audit", "memwrite"],
              bob: ["model", "kb", "summarize", "memwrite"],
              carol: ["model", "kb", "summarize", "memwrite"],
              dave: ["model", "kb", "secret-db", "summarize", "memwrite"],
              "limited-bot": ["model", "kb"],
            },
            { principal: (req) => req.principal?.actor ?? req.workflowId }
          ),
        }
      : secure
        ? { authorizer: new GrantTable({ conversation: ["model", "summarize"] }) }
        : {}
  );
  if (sharedOpts !== undefined) {
    effects.register("kb", new ToolEffect(async () => ({ fact: "public-fact" })));
    effects.register("secret-db", new ToolEffect(async () => ({ secret: SECRET })));
  }
  effects.register(
    "model",
    createAgentModelEffect(hub.wrapProvider(provider), {
      stream: opts.chunks !== undefined,
      onDelta: hub.deltaSink(),
    })
  );
  effects.register(
    "summarize",
    new ToolEffect(async (input: unknown) => ({
      summary: `summary of ${(input as { messages: unknown[] }).messages.length} messages`,
    }))
  );
  opts.extraEffects?.(effects);
  const eventStore = opts.store ?? new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const timerStore = new InMemoryTimerStore();
  const ownerPolicy = ownerScoped();
  const mk = (extra: Partial<WorkflowRuntimeDeps> = {}) =>
    new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime: effects,
      inboxEnabled: true,
      timerStore,
      continueAsNewEnabled: true,
      divergence: "fail",
      ...(secure && {
        executionAuthorizer: opts.policy ?? ownerPolicy,
        executionAuthz: { requirePrincipal: true },
      }),
      ...opts.runtime,
      ...extra,
    });
  const runtime = mk();
  const sharedConfig: SharedConfig | undefined =
    sharedOpts === undefined
      ? undefined
      : {
          servicePrincipal: SERVICE,
          directory: logParticipants(eventStore),
          cleared: (viewer: Identity, classes: readonly string[]) =>
            classes.every(
              (c) =>
                c === "public" ||
                (c === "restricted" && (viewer.actor === "alice" || viewer.actor === "dave"))
            ),
          classOf: (tool: string) =>
            tool === "kb" ? "public" : tool === "secret-db" ? "restricted" : undefined,
          ...sharedOpts,
        };
  const flow = conversation$(
    {
      agent: {
        definition: agent$({ id: "chat", name: "Chat", tools: sharedConfig ? [kb, secretDb] : [] }),
        modelToolId: "model",
      },
      key: TEST_KEY,
      hub,
      bargeIn: inboxBargeIn(eventStore),
      ...(sharedConfig && { shared: sharedConfig }),
      ...opts.config,
    } as ConversationConfig,
    { id: "conversation" }
  );
  runtime.registerFlow(flow.definition, flow.runner);
  const conv = createConversations({
    runtime,
    eventStore,
    flow,
    ...(sharedConfig && { effects }),
    ...(secure && opts.policy === undefined ? { policy: ownerPolicy } : {}),
    ...((!secure || opts.ackPolicy === true) && { runtimePolicyIsOwnerScoped: true }),
    ...opts.conversations,
  });
  return {
    runtime,
    eventStore,
    conv,
    requests,
    calls,
    hub,
    flow,
    effects,
    mk,
    snapshotStore,
    shared: sharedConfig,
  };
}

/** Copy the streams of `ids` into a fresh store: a process that died with exactly these events durable. */
export async function cloneStreams(
  from: EventStore,
  ids: readonly string[],
  upTo: Record<string, number> = {}
): Promise<InMemoryAsyncEventStore> {
  const to = new InMemoryAsyncEventStore();
  for (const id of ids) {
    for (const e of await from.read(id)) {
      if (e.sequence <= (upTo[id] ?? Number.MAX_SAFE_INTEGER)) await to.append(e);
    }
  }
  return to;
}

export type Booted = ReturnType<typeof boot>;

/** Wait until the transcript holds `n` messages. */
export async function messages(b: Booted, id: string, n: number, principal?: PrincipalChain) {
  let out = await b.conv.history(id, { ...(principal && { principal }) });
  await until(async () => {
    out = await b.conv.history(id, { ...(principal && { principal }) });
    return out.entries.length >= n;
  }, `${n} messages`);
  return out.entries;
}

/** A message signed the way the host's client signs it, for tests that write to the inbox raw. */
export function signRaw(
  conversationId: string,
  body: { kind: "user" | "close"; text?: string; id?: string; asker?: Identity; iat?: number }
): Record<string, unknown> {
  return signedEnvelope(TEST_KEY, {
    id: `raw-${Math.random().toString(36).slice(2)}`,
    iat: Date.now(),
    ...body,
    conversationId,
  });
}
