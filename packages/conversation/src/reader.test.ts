import type { EventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { boot, messages } from "./__fixtures__/harness";
import { InvalidCursorError, createConversationReader, formatCursor, parseCursor } from "./index";

/** A store that records how much each range read asked for, and refuses a whole-log read. */
function metered(store: EventStore) {
  const reads: { id: string; span: number }[] = [];
  const spy = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "readRange") {
        return async (id: string, from: number, to: number) => {
          reads.push({ id, span: to - from + 1 });
          return target.readRange?.(id, from, to) ?? [];
        };
      }
      if (prop === "read" || prop === "readFrom") {
        return () => {
          throw new Error(`whole-log read (${String(prop)})`);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { spy: spy as EventStore, reads };
}

describe("history reads are bounded", () => {
  it("never reads a whole log; one call scans at most maxScan events and hands back a cursor", async () => {
    const b = boot({ config: { rotateEveryTurns: 3 } });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 6; i++) {
      await b.conv.sendTurn(id, `q${i}`);
      await messages(b, id, i * 2);
    }
    const { spy, reads } = metered(b.eventStore);
    const reader = createConversationReader(spy);

    const collected: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (; pages < 100; pages++) {
      const p = await reader.read(id, { maxScan: 4, limit: 500, ...(cursor && { cursor }) });
      expect(p.entries.length).toBeLessThanOrEqual(4); // at most maxScan events -> at most maxScan messages
      collected.push(...p.entries.map((m) => m.text));
      if (p.done) break;
      cursor = p.nextCursor;
    }
    expect(collected).toEqual(
      Array.from({ length: 6 }, (_, i) => [`q${i + 1}`, `re: q${i + 1}`]).flat()
    );
    expect(pages).toBeGreaterThan(3); // it really was paged by the scan budget, not by the message count
    expect(Math.max(...reads.map((r) => r.span))).toBeLessThanOrEqual(4);

    reads.length = 0;
    await reader.read(id, { direction: "backward", limit: 2 }); // the latest page of a long conversation
    expect(reads.length).toBeGreaterThan(0);
    expect(Math.max(...reads.map((r) => r.span))).toBeLessThanOrEqual(256);
  });

  it("the head generation is found by probing, not by walking the chain", async () => {
    const b = boot({ config: { rotateEveryTurns: 1 } });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 9; i++) {
      await b.conv.sendTurn(id, `q${i}`);
      await messages(b, id, i * 2);
    }
    const reader = createConversationReader(b.eventStore);
    const head = await reader.headGeneration(id);
    expect(head).toBeGreaterThanOrEqual(8);
    expect(await reader.headGeneration(id, 3)).toBe(head); // a hint does not change the answer
    expect(await reader.headGeneration("no-such")).toBeUndefined();
  });

  it("rejects a malformed cursor instead of starting over", async () => {
    const b = boot();
    const { conversationId: id } = await b.conv.start();
    const reader = createConversationReader(b.eventStore);
    for (const bad of ["", "abc", "1", "1.", "-1.2", "1.2.3", "9999999999.1"]) {
      await expect(reader.read(id, { cursor: bad })).rejects.toBeInstanceOf(InvalidCursorError);
      await expect(reader.read(id, { cursor: bad, direction: "backward" })).rejects.toBeInstanceOf(
        InvalidCursorError
      );
    }
    expect(parseCursor(formatCursor({ g: 3, seq: 41 }))).toEqual({ g: 3, seq: 41 });
  });

  it("a cursor at the tip yields nothing, and a later page picks up exactly the new messages", async () => {
    const b = boot();
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "one");
    await messages(b, id, 2);
    const reader = createConversationReader(b.eventStore);
    const first = await reader.read(id, {});
    const tail = await reader.read(id, { cursor: first.nextCursor as string });
    expect(tail.entries).toEqual([]);
    await b.conv.sendTurn(id, "two");
    await messages(b, id, 4);
    const next = await reader.read(id, { cursor: first.nextCursor as string });
    expect(next.entries.map((m) => m.text)).toEqual(["two", "re: two"]);
  });

  it("a crafted cursor cannot make one call walk billions of generations (P1-a)", async () => {
    const b = boot({ config: { rotateEveryTurns: 2 } });
    const { conversationId: id } = await b.conv.start();
    for (let i = 1; i <= 3; i++) {
      await b.conv.sendTurn(id, `q${i}`);
      await messages(b, id, i * 2);
    }
    const calls = { n: 0 };
    const spy = new Proxy(b.eventStore, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if (
          typeof v === "function" &&
          (p === "readRange" || p === "head" || p === "readFrom" || p === "read")
        ) {
          return (...a: unknown[]) => {
            calls.n++;
            return (v as (...x: unknown[]) => unknown).apply(t, a);
          };
        }
        return v;
      },
    }) as EventStore;
    const reader = createConversationReader(spy);
    const bounded = await reader.read(id, {
      direction: "backward",
      cursor: "999999999.0",
      maxScan: 50,
    });
    expect(calls.n).toBeLessThan(60);
    // clamped to the real head: the newest messages still come back, none skipped
    expect(bounded.entries.map((m) => m.text).slice(0, 2)).toEqual(["re: q3", "q3"]);
    calls.n = 0;
    const far = await reader.read(id, { direction: "backward", cursor: "0.999999", limit: 100 });
    expect(far.entries.map((m) => m.text).slice(-2)).toEqual(["q1", "re: q1"].reverse());
    expect(far.entries.length).toBeGreaterThan(0);
    expect(calls.n).toBeLessThan(60);
  });

  it("a read stops when its caller goes away", async () => {
    const b = boot();
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "one");
    await messages(b, id, 2);
    const reader = createConversationReader(b.eventStore);
    const ctl = new AbortController();
    ctl.abort();
    const r = await reader.read(id, { direction: "backward", signal: ctl.signal });
    expect(r.entries).toEqual([]);
    expect(r.done).toBe(false);
  });
});
