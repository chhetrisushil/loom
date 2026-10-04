import { A2AEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import type { A2ATask, A2ATaskResult, A2ATaskStatus } from "./types";

export interface A2AClientOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  pollIntervalMs?: number;
}

export function createA2AClientEffect(
  agentUrl: string,
  options: A2AClientOptions = {}
): A2AEffect<A2ATask, A2ATaskResult> {
  const { timeoutMs = 60_000, pollIntervalMs = 500, headers = {} } = options;

  return new A2AEffect<A2ATask, A2ATaskResult>(async (task: A2ATask, _ctx: EffectContext) => {
    const baseHeaders = { "content-type": "application/json", ...headers };

    const sendResp = await fetch(`${agentUrl}/tasks/send`, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify(task),
    });

    if (!sendResp.ok) {
      throw new Error(`A2A send error ${sendResp.status}: ${await sendResp.text()}`);
    }

    const sentBody: unknown = await sendResp.json();
    // A malformed answer (not an object at all — e.g. a bare JSON string) used to reach the
    // `"status" in sent` check below and throw a bare, unhelpful `TypeError`. Fail with a
    // message in the style of the other A2A errors instead.
    if (typeof sentBody !== "object" || sentBody === null) {
      throw new Error("A2A send error: malformed answer");
    }
    const sent = sentBody as { id?: unknown; status?: unknown } & Partial<A2ATaskResult>;
    // A peer that answers `/tasks/send` with the finished task (a synchronous agent — e.g. a
    // thin shim whose send handler runs the graph and returns its artifact) has already given
    // the result. Polling for it again cost every such call a full `pollIntervalMs` sleep plus
    // a second request, and failed outright against a peer that does not keep the task (L18).
    // A send that returns only `{ id }` (loom's own server: 202) is polled as before.
    if (typeof sent.status === "string" && terminalStatuses.has(sent.status as A2ATaskStatus)) {
      // A terminal task with no `id` is as malformed as one with no id at all — the caller
      // can't reconcile it against the task it just submitted.
      if (typeof sent.id !== "string") {
        throw new Error("A2A send error: malformed answer");
      }
      return sent as A2ATaskResult;
    }
    if (typeof sent.id !== "string") {
      throw new Error("A2A send error: malformed answer");
    }
    const taskId = sent.id;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);

      const statusResp = await fetch(`${agentUrl}/tasks/${encodeTaskIdSegment(taskId)}`, {
        headers: baseHeaders,
      });
      if (!statusResp.ok) {
        throw new Error(`A2A status error ${statusResp.status}: ${await statusResp.text()}`);
      }

      const result = (await statusResp.json()) as A2ATaskResult;

      if (result.status === "completed" || result.status === "failed") {
        return result;
      }
    }

    throw new Error(`A2A task ${taskId} timed out after ${timeoutMs}ms`);
  });
}

const terminalStatuses = new Set<A2ATaskStatus>(["completed", "failed"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Escape only the characters that are unsafe in a SINGLE path segment: `/` (would otherwise
 * split the segment — this is what stops a `../admin`-style id from being collapsed by URL
 * dot-segment normalization into a request for a different route), `?` and `#` (would start a
 * query string / fragment), and a literal `%` (would corrupt the escape sequence itself on
 * decode). Everything else — INCLUDING `:` — is left byte-identical to the pre-encoding wire
 * format.
 *
 * `:` matters because every loom task id contains one (`A2APeerClient` sets
 * `task.id = `${executionId}:${stepId}``, plus `:${callKey}` for a decider-scope call, and `TenantScoped` uses `:` as its own separator). A
 * full `encodeURIComponent` here would send `exec%3Astep` — a NEW client talking to an OLD
 * `A2AServer` (or any third-party peer) that does not `decodeURIComponent` the path segment
 * would then 404 every poll during a rolling upgrade. `A2AServer`'s `GET /tasks/:id` route still
 * `decodeURIComponent`s the segment on the way in, which is a no-op for an id with no `%` in it
 * and round-trips one of the escaped characters above, so both old- and new-server peers resolve
 * the same id from the same request.
 *
 * Trade-off accepted deliberately: an id containing a literal `%` cannot be resolved by an old,
 * non-decoding server (it would look up the literal `...%25...` instead of the real id) — but no
 * loom-issued task id contains one.
 */
function encodeTaskIdSegment(id: string): string {
  return id.replace(/[/?#%]/g, (c) => encodeURIComponent(c));
}

export { terminalStatuses };
