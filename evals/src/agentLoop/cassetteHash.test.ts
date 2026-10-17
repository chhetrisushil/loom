import { CassetteMissError, CassetteProvider } from "@loom/eval";
import type { LlmRequest, LlmResponse } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { authorCassette, loadCassette } from "./cassettes";
import { runTask } from "./subject";
import { TASKS } from "./tasks";

// The cassettes are keyed by a hash of the request. Before relying on them: the key must be a function of the
// SEMANTIC request, so a semantically irrelevant change (object key order, an `undefined` field, the abort
// `signal`) neither misses a recorded exchange nor forks it, while a real change (the prompt text) does miss.

/** A deep copy with every object's keys in the OPPOSITE order. */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .reverse()
        .map(([k, x]) => [k, reverseKeys(x)])
    );
  }
  return v;
}

const answer: LlmResponse = { content: "ok", stopReason: "end_turn" };

/** Every request the REAL loop sends for a tool-bearing task (system prompt, tool menu, tool_use / tool_result parts). */
async function capturedRequests(taskId: string): Promise<LlmRequest[]> {
  const task = TASKS.find((t) => t.id === taskId);
  if (task === undefined) throw new Error(taskId);
  const seen: LlmRequest[] = [];
  const cassette = new CassetteProvider({ mode: "replay", data: loadCassette(taskId) });
  await runTask(task, {
    complete: async (r) => {
      seen.push(structuredClone(r));
      return cassette.complete(r);
    },
  });
  return seen;
}

describe("CassetteProvider request hashing is stable (semantic, not textual)", () => {
  it("serves a recorded exchange to the same request with every object's keys reordered", async () => {
    for (const r of await capturedRequests("search-then-parallel")) {
      const rec = new CassetteProvider({
        mode: "record",
        inner: { complete: async () => answer },
      });
      await rec.complete(r);
      const replay = new CassetteProvider({ mode: "replay", data: rec.toJSON() });
      const shuffled = reverseKeys(r) as LlmRequest;
      expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(r)); // the reorder is real
      await expect(replay.complete(shuffled)).resolves.toEqual(answer);
    }
  });

  it("ignores the abort signal and undefined fields, but NOT the prompt", async () => {
    const [req] = await capturedRequests("single-lookup");
    const rec = new CassetteProvider({ mode: "record", inner: { complete: async () => answer } });
    await rec.complete(req as LlmRequest);
    const replay = new CassetteProvider({ mode: "replay", data: rec.toJSON() });
    const same = {
      ...(req as LlmRequest),
      signal: new AbortController().signal,
      temperature: undefined,
    } as unknown as LlmRequest;
    await expect(replay.complete(same)).resolves.toEqual(answer);

    const edited = structuredClone(req as LlmRequest);
    edited.messages[0] = { role: "user", content: "a different question" };
    await expect(replay.complete(edited)).rejects.toBeInstanceOf(CassetteMissError);
  });

  it("a cassette recorded under one execution id replays under another (no execution id in the request)", async () => {
    const task = TASKS.find((t) => t.id === "refund-approved");
    if (task === undefined) throw new Error("task");
    const fresh = await authorCassette({ ...task, id: "some-other-execution" });
    expect(fresh).toEqual(loadCassette("refund-approved"));
  });
});
