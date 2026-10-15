# Data-plane isolation, untrusted content & media

> Part of the [Loom User Guide](../user-guide.md), [section 17](../user-guide.md#17-kernel-grants-quotas--supervision) (Loom 2.0 kernel hardening). What may cross a boundary: data-plane isolation and egress (K7), the untrusted-content integrity axis (ADR 0085), and images, audio, files and real tool turns (R5).

## Data-plane isolation & egress (K7)

K2's grant table governs *which* effects run; in-process tool bodies still hold ambient
authority. `@loom/isolate` turns the convention into a boundary — the tool runs in a pooled
**child process** at the effect position (innermost, so grants/metering/safety all stay on
the kernel side where the isolate can't forge them):

```ts
import { IsolatedToolEffect } from "@loom/isolate";

effectRuntime.register("fetch-metrics", new IsolatedToolEffect({
  id: "fetch-metrics",
  modulePath: require.resolve("./tools/fetch-metrics.cjs"), // code the CHILD loads — no closures
  egress: ["prometheus.internal:9090"], // K7.3 — static allowlist (tool$({ egress }) mirrors it)
  env: { PROM_TOKEN: secrets.prom },    // K7.4 — this tool's credentials, and ONLY this tool's
  timeoutMs: 30_000,                    // non-cooperative SIGKILL — the real kill path
  idempotent: true,                     // K9 semantics compose unchanged
}));

// tools/fetch-metrics.cjs — authored against the marshaled ctx shim:
module.exports = async (input, ctx) => {
  const res = await ctx.fetch(`http://prometheus.internal:9090/api/v1/query?...`);
  ctx.emit("METRICS_SAMPLED", { at: input.at }); // forwarded, ordered, before the result
  return JSON.parse(res.body);
};
```

The child's environment is **scrubbed** (exactly `env` + PATH — the parent's secrets aren't
there to read), no store handles cross the boundary, and all network goes through the
brokered `ctx.fetch`: the allowlist is enforced **before any connection** (durable
`EGRESS_DENIED` on refusal, folded into `state.variables._egress`) and requests dispatch
**resolve-and-pin** (DNS-rebind safe). The runner also blocks ambient network modules
(`require("http")` throws) as defense-in-depth — for hostile-code-grade confinement add
OS-layer sandboxing (netns/seccomp/container egress) around the worker.

## Untrusted content: the integrity axis (ADR 0085)

K7 governs what leaves. The opposite direction — what may *enter an instruction position* — needs a
different mechanism, because integrity is a property of a **value**, not a field: the same
`summary: string` is trustworthy when your flow computed it and untrusted when a third-party MCP
server returned it, and which one it is is only knowable at runtime.

So taint is attached to the value, at ingress, by whoever acquired it:

```ts
import { tainted, unwrapTainted } from "@loom/classify";

const doc = tainted(await fetchThirdPartyDoc(), "mcp:acme/fetch_doc");
```

The wrapper is plain JSON, so it survives the log verbatim and **a replay hands back a value that is
still tainted**. `@loom/llm`'s `guardRequest` then runs inside every `createLlmEffect`,
unconditionally: tainted content may appear only in a `user` message, and only fenced as
`<untrusted-input origin="…">`. A system message, an assistant turn, or a tool name/description
throws `UntrustedContentError`.

Two producers ship, both opt-in: `registerMcpInvoke(client, runtime, { taintResults: true })` and
`new A2APeerClient({ url, taintResults: true })`. The **refusal is structural**; the **fence is only
a label** — put `UNTRUSTED_CONTENT_SYSTEM_NOTE` in your system prompt so the model knows what the tag
means. Full treatment in [data classification](../data-classification.md#the-integrity-axis--untrusted-content-adr-0085).

## Images, audio, files and real tool turns (R5, [ADR 0120](../adr/0120-llm-content-parts-and-tool-threading.md))

A message's `content` is still a `string` (text only, unchanged) or now an array of **parts**: `text`,
`image` / `audio` / `file` (each with a `mediaType` and a `source`), `tool_use` (the model's call) and
`tool_result` (the answer). `agentLoop$` and `AgentRunner` thread real tool turns: the assistant message
carries `tool_use` parts, and ONE `user` message of `tool_result` parts answers them by id (a refusal or a
failing tool is `isError`). There is no `tool` role: each provider maps the one canonical shape to its own
(Anthropic content blocks, OpenAI `tool_calls` + `role: "tool"`, Gemini `functionCall` / `functionResponse`).

```ts
import { mediaResult } from "@loom/agent";

// A tool hands the model an image by CLAIM-CHECK: store the bytes, return the address. The tool must be
// declared by the operator — `tool$({ ..., returnsMedia: true })` — or its result is just data.
const ref = await contentStore.put(png);
return mediaResult([
  { type: "text", text: "latency by region" },
  { type: "image", mediaType: "image/png", source: { kind: "ref", ref: { address: ref.__loomContent, size: png.length } } },
]);

// Resolve the address to bytes at call time — the journal keeps only the address. The resolver MUST
// authorize: the store is content-addressed with no tenancy, so check that this execution may read it,
// and DENY when `executionId` / `principal` is missing.
effects.register(
  "model",
  createAgentModelEffect(new AnthropicProvider(), {
    resolveContent: async (r, { executionId, principal, maxBytes }) => {
      if (!(await mayRead(principal, executionId, r.address))) return null;
      return contentStore.get({ __loomContent: r.address });
    },
  })
);
```

Inline `{ kind: "data" }` media is capped at 64 KiB per part and 256 KiB per request so the durable log can
never carry real media; over the cap is refused (a tool's oversized inline result becomes an `isError` result
the model can recover from). If a tool's ref cannot be resolved (erased, over the 32 MiB budget, a size that
differs from the ref's declared one), the model sees an `isError` result instead of the run failing; the same
failure for a ref your own code put in a message fails the call.
A provider declares which modalities it takes (`capabilities`). The shipped ones declare media only for
known media-capable model families; an unknown model id, an older one (plain `gpt-4`) or a non-default
`baseUrl` (an OpenAI-compatible server) is text-only until you pass `capabilities: { image: ["image/png"] }`,
and `capabilities: {}` makes any model text-only; anything else throws
`UnsupportedModalityError` before a network call, and so does a ref with no `resolveContent`. A TAINTED tool
output is never interpreted as media (it stays fenced text), and an untrusted media part you build yourself
(`untrusted: { origin }`) may not name a stored ref; it is bracketed by the same `<untrusted-input>` fence as
text and refused outside a `user` message. `onToolDelta` / `onToolReset` stream a tool call's input as it is
generated; on a retry `onToolReset` fires so you discard the failed attempt's fragments (this channel is
outside the delta validators).

> **Warning: never read `message.content` raw.** `LlmMessage.content` is `string | LlmContentPart[]`, and
> `msgs.map((m) => m.content).join(" ")`, `` `${m.content}` `` and `{ text: m.content }` handed to an untyped
> `JSON.stringify` all still type-check, then turn a parts message into `"[object Object]"` or a JSON array. Read it
> with `textOf(content)` (text) or `toParts(content)` (structure), or branch on `typeof content === "string"`.
> Provider-author checklist: (1) read content only through `textOf` / `toParts` / a `typeof` branch; (2) map every
> part type you declare in `capabilities`, and refuse the rest; (3) run `runLlmProviderConformance` from
> `@loom/conformance`, whose parts case fails a provider that string-coerces a parts message. Loom's own source is
> held to this by a type-aware fitness test (`packages/spec/src/rawMessageContent.test.ts`); a third-party package
> has the conformance case and this checklist.

---

Back to [User Guide section 17](../user-guide.md#17-kernel-grants-quotas--supervision).
