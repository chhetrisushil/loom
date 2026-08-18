import { TypedFailure } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import type { EffectContext } from "@loom/effect-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AGENT_INTERRUPTED } from "./AgentRunner";
import type { InterruptedAgentRun } from "./AgentRunner";
import { AgentRunner } from "./AgentRunner";

// ── R6 — an interrupted agent turn keeps what it produced ─────────────────────
//
// A user stop, a `guard$` trip or an exhausted budget aborts the run. Everything
// the agent had produced — the partial generation AND the tool calls already
// made, which are the expensive part — used to vanish: `throwIfAborted` threw a
// bare abort, and on the `complete` path there was no partial to keep anyway
// (fetch aborts with the body unread).
//
// R9 gave the model call a partial to hand back. This carries it, plus the work
// already done, out through an ADR 0060 typed channel so the flow can settle
// rather than start the turn again from nothing.

function makeCtx(signal?: AbortSignal): EffectContext {
  return {
    executionId: "exec-1",
    stepId: "agent",
    workflowId: "wf-1",
    attempt: 1,
    emit: vi.fn(),
    ...(signal !== undefined && { signal }),
  };
}

const lookup = tool$({
  id: "lookup",
  name: "Lookup",
  description: "Looks up",
  kind: "tool",
  inputSchema: z.object({}),
  outputSchema: z.object({}),
});

const agentDef = agent$({ id: "a", name: "A", tools: [lookup] });

function effectsThatAbort(controller?: AbortController): EffectRuntime {
  const rt = new EffectRuntime();
  rt.register(
    "lookup",
    new ToolEffect(async () => {
      controller?.abort(); // the stop lands WHILE the agent is working
      return { rows: 3 };
    })
  );
  return rt;
}

/** Turn 1 calls a tool; turn 2 would answer. */
const twoTurnProvider = (): LlmProvider => {
  let call = 0;
  const responses: LlmResponse[] = [
    {
      content: "checking",
      toolCalls: [{ id: "c1", name: "lookup", input: {} }],
      stopReason: "tool_use",
    },
    { content: "done", stopReason: "end_turn" },
  ];
  return {
    async complete() {
      return responses[Math.min(call++, 1)] as LlmResponse;
    },
    async *stream() {
      const res = responses[Math.min(call++, 1)] as LlmResponse;
      yield { delta: res.content, done: false };
      yield {
        delta: "",
        done: true,
        ...(res.toolCalls !== undefined && { toolCalls: res.toolCalls }),
        stopReason: res.stopReason,
      };
    },
  };
};

describe("an interrupted agent turn keeps its work (R6)", () => {
  it("carries the completed tool calls out on a typed channel", async () => {
    const controller = new AbortController();
    const runner = new AgentRunner({
      definition: agentDef,
      provider: twoTurnProvider(),
      effectRuntime: effectsThatAbort(controller),
    });

    const err = await runner.run({ prompt: "go" }, makeCtx(controller.signal)).catch((e) => e);

    expect(err).toBeInstanceOf(TypedFailure);
    expect((err as TypedFailure).channel).toBe(AGENT_INTERRUPTED);

    const payload = (err as TypedFailure).payload as InterruptedAgentRun;
    // The tool ran and returned before the stop landed. Losing that is losing the
    // expensive half of the turn.
    expect(payload.toolCallLog).toHaveLength(1);
    expect(payload.toolCallLog[0]?.toolName).toBe("lookup");
    expect(payload.iterations).toBe(1);
  });

  it("carries the partial generation when the stop lands mid-stream", async () => {
    const controller = new AbortController();
    const slowStream: LlmProvider = {
      async complete() {
        return { content: "unused", stopReason: "end_turn" };
      },
      async *stream(request) {
        yield { delta: "par", done: false };
        controller.abort();
        if (request.signal?.aborted === true) throw new Error("aborted");
        yield { delta: "", done: true };
      },
    };
    const runner = new AgentRunner({
      definition: agentDef,
      provider: slowStream,
      effectRuntime: new EffectRuntime(),
      stream: true,
    });

    const err = await runner.run({ prompt: "go" }, makeCtx(controller.signal)).catch((e) => e);

    const payload = (err as TypedFailure).payload as InterruptedAgentRun;
    expect((err as TypedFailure).channel).toBe(AGENT_INTERRUPTED);
    expect(payload.content).toBe("par"); // the tokens paid for, not discarded
  });

  it("streams deltas to the sink when asked", async () => {
    const seen: string[] = [];
    const runner = new AgentRunner({
      definition: agentDef,
      provider: twoTurnProvider(),
      effectRuntime: new EffectRuntime(),
      stream: true,
      onDelta: (d) => seen.push(d),
    });
    await runner.run({ prompt: "go" }, makeCtx());
    // Turn 1 said "checking", turn 2 "done" — the loop streams every turn.
    expect(seen).toEqual(["checking", "done"]);
  });

  it("is unchanged when nothing interrupts it (G2)", async () => {
    const runner = new AgentRunner({
      definition: agentDef,
      provider: twoTurnProvider(),
      effectRuntime: effectsThatAbort(),
    });
    const out = await runner.run({ prompt: "go" }, makeCtx());
    expect(out.content).toBe("done");
    expect(out.toolCallLog).toHaveLength(1);
  });

  it("does not turn an ordinary tool failure into an interruption", async () => {
    // Only an abort is an interruption. A failing tool is feedback the model can
    // act on (R4 keeps that behaviour), and must not surface as lost work.
    const rt = new EffectRuntime();
    rt.register(
      "lookup",
      new ToolEffect(async () => {
        throw new Error("upstream down");
      })
    );
    const out = await new AgentRunner({
      definition: agentDef,
      provider: twoTurnProvider(),
      effectRuntime: rt,
    }).run({ prompt: "go" }, makeCtx());
    expect(out.content).toBe("done");
  });
});
