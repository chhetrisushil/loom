import { EventEmitter } from "node:events";
import type * as http from "node:http";
import { describe, expect, it } from "vitest";
import { SseSink, frame } from "./sse";

/** A response whose socket can be backed up and drained on demand. */
function fakeRes() {
  const res = new EventEmitter() as EventEmitter & {
    written: string[];
    backed: boolean;
    write(s: string): boolean;
  };
  res.written = [];
  res.backed = false;
  res.write = (s: string) => {
    res.written.push(s);
    return !res.backed;
  };
  return res;
}
const build = (turn: number, text: string) => frame("delta", { turn, text });

describe("SseSink backpressure", () => {
  it("frames are single-line JSON with an optional id", () => {
    expect(frame("message", { a: "x\ny" }, "0.5")).toBe(
      'id: 0.5\nevent: message\ndata: {"a":"x\\ny"}\n\n'
    );
    expect(frame("delta", {})).not.toContain("id:");
  });

  it("while the socket is backed up deltas are COALESCED, durable frames are queued in order, and a drain flushes both", () => {
    const res = fakeRes();
    const sink = new SseSink(res as unknown as http.ServerResponse, 1_000_000, () => {});
    sink.send("A");
    res.backed = true;
    sink.send("B"); // written, and the socket reports it is full
    sink.delta(1, "he", build);
    sink.delta(1, "llo", build);
    sink.delta(1, " world", build);
    sink.send("C");
    expect(res.written).toEqual(["A", "B"]); // nothing more reached the socket
    res.backed = false;
    res.emit("drain");
    expect(res.written.slice(2)).toEqual(["C", build(1, "hello world")]); // ONE coalesced delta
  });

  it("a client that never reads is closed once its pending bytes pass the cap, and nothing is written after", () => {
    const res = fakeRes();
    let overflowed = 0;
    const sink = new SseSink(res as unknown as http.ServerResponse, 100, () => overflowed++);
    res.backed = true;
    sink.send("x"); // fills the socket
    for (let i = 0; i < 20; i++) sink.send("durable-frame-padding-".repeat(2));
    expect(overflowed).toBe(1);
    expect(sink.isClosed).toBe(true);
    const n = res.written.length;
    sink.send("late");
    sink.delta(1, "late", build);
    res.backed = false;
    res.emit("drain");
    expect(res.written.length).toBe(n);
  });

  it("an endless stream of deltas to a stalled client is bounded too", () => {
    const res = fakeRes();
    let overflowed = 0;
    const sink = new SseSink(res as unknown as http.ServerResponse, 500, () => overflowed++);
    res.backed = true;
    sink.send("x");
    for (let i = 0; i < 1000; i++) sink.delta(1, "tokentoken", build);
    expect(overflowed).toBe(1);
  });

  it("deltas of a new turn do not merge into the previous turn's coalesced text", () => {
    const res = fakeRes();
    const sink = new SseSink(res as unknown as http.ServerResponse, 1_000_000, () => {});
    res.backed = true;
    sink.send("x");
    sink.delta(1, "one", build);
    sink.delta(2, "two", build);
    res.backed = false;
    res.emit("drain");
    expect(res.written.slice(1)).toEqual([build(1, "one"), build(2, "two")]);
  });
});
