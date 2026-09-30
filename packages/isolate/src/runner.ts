// ── K7 — the CHILD-side runner (the other side of the boundary) ──────────────
//
// This file is the fork() entrypoint. It loads the untrusted tool module and
// runs it against the marshaled ctx shim. Two properties come from the process
// boundary itself (structural, not policy): the child holds NO store handles
// and NO parent environment (the parent scrubs `env` down to the injected
// credentials + PATH). Network egress goes through the brokered `ctx.fetch`,
// enforced on the PARENT side (allowlist + resolve-and-pin) — and as
// defense-in-depth the runner blocks ambient network modules before any tool
// code loads. That deny-list raises the bar considerably but is hardening, not
// hostile-code-grade confinement: a truly malicious module in a hostile
// deployment should additionally be confined at the OS layer (netns/seccomp/
// container egress rules) — see the ADR's non-goals.

import {
  type ChildToParent,
  type IsolatedFetchResponse,
  type IsolatedToolContext,
  type ParentToChild,
  RUNNER_DISCONNECT_EXIT_CODE,
} from "./types";

// A parent that dies (kill -9) or exits without close() severs the IPC channel; without this the
// child — which may be a tool holding the loop open — would run on, orphaned to init. Registered
// FIRST, before the module hook or any tool code. Hardening only: hostile tool code can
// `process.removeAllListeners("disconnect")` and defeat it; OS-level confinement is out of scope.
process.on("disconnect", () => process.exit(RUNNER_DISCONNECT_EXIT_CODE));

// Block ambient network BEFORE untrusted code can load it. `ctx.fetch` is the
// sanctioned path; everything else is denied at require time.
const BLOCKED_MODULES = new Set(
  ["net", "tls", "http", "https", "http2", "dgram", "dns", "undici"].flatMap((m) => [
    m,
    `node:${m}`,
  ])
);

// biome-ignore lint/suspicious/noExplicitAny: Module._load is an untyped Node internal — the one hook that intercepts every require()
const NodeModule = require("node:module") as any;
const originalLoad = NodeModule._load;
NodeModule._load = function blockNetworkModules(request: string, ...rest: unknown[]) {
  if (BLOCKED_MODULES.has(request)) {
    throw new Error(
      `isolated tool: module "${request}" is blocked — network egress goes through ctx.fetch (K7)`
    );
  }
  return originalLoad.call(this, request, ...rest);
};
// biome-ignore lint/suspicious/noExplicitAny: removing the ambient fetch global
(globalThis as any).fetch = undefined;

const send = (msg: ChildToParent): void => {
  process.send?.(msg);
};

let nextFetchId = 1;
const pendingFetches = new Map<
  number,
  { resolve: (r: IsolatedFetchResponse) => void; reject: (e: Error) => void }
>();
const abortControllers = new Map<number, AbortController>();

function makeFetch(runId: number): IsolatedToolContext["fetch"] {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const fetchId = nextFetchId++;
      pendingFetches.set(fetchId, { resolve, reject });
      send({ type: "fetch", runId, fetchId, url, ...(init !== undefined && { init }) });
    });
}

async function run(msg: Extract<ParentToChild, { type: "run" }>): Promise<void> {
  const controller = new AbortController();
  abortControllers.set(msg.runId, controller);
  try {
    // biome-ignore lint/suspicious/noExplicitAny: the tool module is untrusted, dynamically-loaded JS
    const mod = require(msg.modulePath) as any;
    const fn = msg.exportName !== undefined ? mod[msg.exportName] : (mod.default ?? mod);
    if (typeof fn !== "function") {
      throw new Error(
        `isolated tool module "${msg.modulePath}" does not export a function${msg.exportName !== undefined ? ` named "${msg.exportName}"` : ""}`
      );
    }
    const ctx: IsolatedToolContext = {
      ...msg.ctx,
      emit: (eventType, payload) => send({ type: "emit", runId: msg.runId, eventType, payload }),
      signal: controller.signal,
      fetch: makeFetch(msg.runId),
    };
    const output = (await fn(msg.input, ctx)) as unknown;
    send({ type: "result", runId: msg.runId, output });
  } catch (err) {
    send({ type: "error", runId: msg.runId, message: String(err) });
  } finally {
    abortControllers.delete(msg.runId);
  }
}

process.on("message", (msg: ParentToChild) => {
  if (msg.type === "warm") {
    // Cold-start work the parent must not charge to a run: load the tool module now so the run
    // finds it cached. This is where the tool's UNTRUSTED top-level code runs. A throw is a tool
    // fault reported here (the parent fails the load phase and discards this child), so the
    // module's top-level side effects are never executed a second time by a run.
    try {
      require(msg.modulePath);
    } catch (err) {
      send({ type: "load-error", message: String(err) });
      return;
    }
    send({ type: "ready" });
    return;
  }
  if (msg.type === "run") {
    void run(msg);
    return;
  }
  if (msg.type === "abort") {
    abortControllers.get(msg.runId)?.abort(new Error("aborted by kernel"));
    return;
  }
  if (msg.type === "fetch-result") {
    const pending = pendingFetches.get(msg.fetchId);
    if (!pending) return;
    pendingFetches.delete(msg.fetchId);
    if (!msg.ok) {
      const failure = new Error(msg.error ?? "brokered fetch failed");
      if (msg.code !== undefined) {
        failure.name = msg.code === "FETCH_TIMEOUT" ? "IsolatedFetchTimeoutError" : failure.name;
        (failure as Error & { code?: string }).code = msg.code;
      }
      pending.reject(failure);
      return;
    }
    const body = msg.body ?? "";
    const status = msg.status ?? 0;
    pending.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: msg.headers ?? {},
      body,
      text: async () => body,
      json: async () => JSON.parse(body) as unknown,
    });
  }
});

// Trusted boot is done: everything after this point the parent asks for is tool code.
send({ type: "booted" });
