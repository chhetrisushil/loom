import { createAgentModelEffect } from "@loom/agent";
import {
  type ConversationConfig,
  ConversationHub,
  conversation$,
  createConversations,
  inboxBargeIn,
} from "@loom/conversation";
import { agent$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { PrincipalChain } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest, LlmStreamChunk } from "@loom/llm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, executionAccessPolicy } from "@loom/workflow-runtime";
import type { ExecutionAuthorizer } from "@loom/workflow-runtime";
import { type ConversationSseOptions, createConversationSseServer } from "../index";

export const alice: PrincipalChain = { actor: "alice", tenant: "t1" };
export const bob: PrincipalChain = { actor: "bob", tenant: "t2" };
export const colleague: PrincipalChain = { actor: "carol", tenant: "t1" };

/** Bearer tokens -> principals: the stand-in for a real verifier. */
export const TOKENS: Record<string, PrincipalChain> = {
  "tok-alice": alice,
  "tok-bob": bob,
  "tok-carol": colleague,
};

export function lastUserText(request: LlmRequest): string {
  const last = request.messages[request.messages.length - 1];
  const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
  return (/<untrusted-input[^>]*>([\s\S]*?)<\/untrusted-input>/.exec(text)?.[1] ?? text).trim();
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
  chunks?: (request: LlmRequest, nth: number) => AsyncIterable<LlmStreamChunk>;
  config?: Partial<ConversationConfig>;
  server?: Partial<ConversationSseOptions>;
  hub?: ConversationHub;
  /** The runtime's execution authorizer (default: the reference policy). */
  policy?: ExecutionAuthorizer;
  /** Tokens the default authenticate accepts (default {@link TOKENS}). */
  tokens?: Record<string, PrincipalChain>;
}

export async function boot(opts: BootOptions = {}) {
  const requests: LlmRequest[] = [];
  const calls = { n: 0 };
  const provider: LlmProvider = {
    async complete(request) {
      calls.n++;
      requests.push(request);
      return { content: `re: ${lastUserText(request)}`, stopReason: "end_turn" };
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
  const effects = new EffectRuntime();
  effects.register(
    "model",
    createAgentModelEffect(hub.wrapProvider(provider), {
      stream: opts.chunks !== undefined,
      onDelta: hub.deltaSink(),
    })
  );
  effects.register(
    "summarize",
    new ToolEffect(async () => ({ summary: "earlier turns, summarized" }))
  );
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    timerStore: new InMemoryTimerStore(),
    inboxEnabled: true,
    continueAsNewEnabled: true,
    divergence: "fail",
    executionAuthorizer: opts.policy ?? executionAccessPolicy(),
    executionAuthz: { requirePrincipal: true },
  });
  const flow = conversation$({
    agent: { definition: agent$({ id: "chat", name: "Chat", tools: [] }), modelToolId: "model" },
    hub,
    bargeIn: inboxBargeIn(eventStore),
    ...opts.config,
  });
  runtime.registerFlow(flow.definition, flow.runner);
  const conversations = createConversations({ runtime, eventStore, flow });
  const tokens = opts.tokens ?? TOKENS;
  const server = createConversationSseServer({
    conversations,
    hub,
    eventStore,
    authenticate: (req) => {
      const h = req.headers.authorization;
      return h?.startsWith("Bearer ") ? tokens[h.slice(7)] : undefined;
    },
    ...opts.server,
  });
  await server.start();
  return { server, conversations, runtime, eventStore, hub, requests, calls, url: server.url };
}
export type Booted = Awaited<ReturnType<typeof boot>>;

// ── a tiny SSE client ───────────────────────────────────────────────────────────────────────────

export interface SseEvent {
  event: string;
  id?: string;
  data: unknown;
}

export interface SseConn {
  status: number;
  headers: Headers;
  events: SseEvent[];
  /** Resolves with the first event (from the start) satisfying `pred`. */
  waitFor(pred: (e: SseEvent) => boolean, what?: string): Promise<SseEvent>;
  readonly ended: Promise<void>;
  close(): void;
}

export async function openSse(url: string, headers: Record<string, string> = {}): Promise<SseConn> {
  const ctl = new AbortController();
  const res = await fetch(url, {
    headers: { accept: "text/event-stream", ...headers },
    signal: ctl.signal,
  });
  const events: SseEvent[] = [];
  let resolveEnded!: () => void;
  const ended = new Promise<void>((r) => {
    resolveEnded = r;
  });
  if (res.status === 200 && res.body !== null) {
    void (async () => {
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          for (;;) {
            const i = buf.indexOf("\n\n");
            if (i < 0) break;
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = "message";
            let id: string | undefined;
            let data = "";
            let any = false;
            for (const line of block.split("\n")) {
              if (line.startsWith(":")) continue;
              any = true;
              if (line.startsWith("event: ")) event = line.slice(7);
              else if (line.startsWith("id: ")) id = line.slice(4);
              else if (line.startsWith("data: ")) data += line.slice(6);
            }
            if (any && data !== "")
              events.push({ event, ...(id !== undefined && { id }), data: JSON.parse(data) });
          }
        }
      } catch {
        // aborted
      } finally {
        resolveEnded();
      }
    })();
  } else {
    resolveEnded();
    await res.arrayBuffer().catch(() => undefined);
  }
  return {
    status: res.status,
    headers: res.headers,
    events,
    ended,
    async waitFor(pred, what = "an event") {
      await until(() => events.some(pred), what);
      return events.find(pred) as SseEvent;
    },
    close: () => ctl.abort(),
  };
}

export async function post(
  url: string,
  token: string | undefined,
  body: unknown,
  extra: Record<string, string> = {}
  // biome-ignore lint/suspicious/noExplicitAny: a test fixture reading arbitrary JSON
): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token && { authorization: `Bearer ${token}` }),
      ...extra,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

export async function get(
  url: string,
  token: string | undefined,
  extra: Record<string, string> = {}
  // biome-ignore lint/suspicious/noExplicitAny: a test fixture reading arbitrary JSON
): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...extra },
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}
