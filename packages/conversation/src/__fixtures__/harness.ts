import { createAgentModelEffect } from "@loom/agent";
import { agent$ } from "@loom/core";
import { EffectRuntime, GrantTable, ToolEffect } from "@loom/effect-runtime";
import type { PrincipalChain } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import type { EventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest, LlmResponse, LlmStreamChunk } from "@loom/llm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, executionAccessPolicy } from "@loom/workflow-runtime";
import type { ExecutionAuthorizer, WorkflowRuntimeDeps } from "@loom/workflow-runtime";
import {
  type ConversationConfig,
  ConversationHub,
  conversation$,
  createConversations,
  inboxBargeIn,
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
  hub?: ConversationHub;
  /** A streaming provider: yields the chunks of a reply (the terminal `done` chunk included). */
  chunks?: (request: LlmRequest, nth: number) => AsyncIterable<LlmStreamChunk>;
  extraEffects?: (e: EffectRuntime) => void;
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
        (await opts.reply?.(request, calls.n)) ?? {
          content: `re: ${lastUserText(request)}`,
          stopReason: "end_turn",
        }
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
  const effects = new EffectRuntime(
    [],
    opts.secure ? { authorizer: new GrantTable({ conversation: ["model", "summarize"] }) } : {}
  );
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
  const mk = (extra: Partial<WorkflowRuntimeDeps> = {}) =>
    new WorkflowRuntime({
      eventStore,
      snapshotStore,
      effectRuntime: effects,
      inboxEnabled: true,
      timerStore,
      continueAsNewEnabled: true,
      divergence: "fail",
      ...(opts.secure && {
        executionAuthorizer: opts.policy ?? executionAccessPolicy(),
        executionAuthz: { requirePrincipal: true },
      }),
      ...opts.runtime,
      ...extra,
    });
  const runtime = mk();
  const flow = conversation$(
    {
      agent: { definition: agent$({ id: "chat", name: "Chat", tools: [] }), modelToolId: "model" },
      hub,
      bargeIn: inboxBargeIn(eventStore),
      ...opts.config,
    } as ConversationConfig,
    { id: "conversation" }
  );
  runtime.registerFlow(flow.definition, flow.runner);
  const conv = createConversations({ runtime, eventStore, flow });
  return { runtime, eventStore, conv, requests, calls, hub, flow, effects, mk, snapshotStore };
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
