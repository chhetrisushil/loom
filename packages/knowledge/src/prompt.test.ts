import { tainted, unwrapTainted } from "@loom/classify";
import { UntrustedContentError, guardRequest } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { groundedRequest, passageMessages } from "./prompt";
import type { Passage } from "./types";

const passage = (docId: string, text: string): Passage => ({
  docId,
  index: 0,
  text: tainted(text, `knowledge:runbooks:${docId}`),
});

const PASSAGES = [
  passage("RB-101", "Cancel the blocking query before touching replication settings."),
  passage("RB-204", "Recycle the pool first; it is graceful and reversible."),
];

describe("passageMessages", () => {
  it("emits one user message per passage, with taint intact", () => {
    const messages = passageMessages(PASSAGES);
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.role === "user")).toBe(true);
    // One message per passage rather than one joined string: joining requires unwrapping,
    // and provenance would stop travelling exactly where it starts to matter.
    expect(messages.map((m) => unwrapTainted(m.content))).toEqual([
      "Cancel the blocking query before touching replication settings.",
      "Recycle the pool first; it is graceful and reversible.",
    ]);
  });

  it("produces a request guardRequest accepts, fenced and labelled by origin", () => {
    const guarded = guardRequest(
      groundedRequest({
        instructions: "Answer strictly from the runbook passages provided.",
        question: "The replica is lagging. What do I do?",
        passages: PASSAGES,
      })
    );
    // What reaches a provider is plain strings: fenced, and each labelled with the origin
    // the passage was ingested under, so the model is told which text is data and whose.
    expect(guarded.messages.every((m) => typeof m.content === "string")).toBe(true);
    expect(guarded.messages[0]?.content).toContain("knowledge:runbooks:RB-101");
    expect(guarded.system).toContain("untrusted-input");
    expect(guarded.messages.at(-1)?.content).toContain("The replica is lagging");
  });

  it("REFUSES the shape every RAG tutorial writes: passages in the system prompt", () => {
    // The failure this package exists to make unreachable. `groundedRequest` types
    // `instructions` as a plain string, so the natural mistake does not compile; assembled
    // by hand it is refused at the boundary instead, before any provider sees it.
    expect(() =>
      guardRequest({
        ...(PASSAGES[0] !== undefined && { system: PASSAGES[0].text }),
        messages: [{ role: "user", content: "The replica is lagging. What do I do?" }],
      })
    ).toThrow(UntrustedContentError);
  });

  it("keeps the question after the passages", () => {
    const request = groundedRequest({
      instructions: "Answer from the passages.",
      question: "Which runbook covers pool saturation?",
      passages: PASSAGES,
      maxTokens: 200,
    });
    expect(request.messages).toHaveLength(3);
    expect(request.messages.at(-1)?.content).toBe("Which runbook covers pool saturation?");
    expect(request.maxTokens).toBe(200);
  });

  it("still carries the untrusted-content note when nothing was retrieved", () => {
    // An empty retrieval is the case where a model is most likely to answer from its
    // priors, so the instruction that it may only use the passages must survive it.
    const request = groundedRequest({
      instructions: "Answer strictly from the passages; say so if they do not cover it.",
      question: "anything",
      passages: [],
    });
    expect(request.messages).toHaveLength(1);
    expect(request.system).toContain("untrusted-input");
  });
});
