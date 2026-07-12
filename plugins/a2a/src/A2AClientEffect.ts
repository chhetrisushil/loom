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

    const sent = (await sendResp.json()) as { id: string };
    const taskId = sent.id;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);

      const statusResp = await fetch(`${agentUrl}/tasks/${taskId}`, { headers: baseHeaders });
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

export { terminalStatuses };
