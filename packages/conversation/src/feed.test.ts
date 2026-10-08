import { describe, expect, it } from "vitest";
import { boot, messages, until } from "./__fixtures__/harness";
import { type FeedItem, createConversationReader, followConversation } from "./index";

async function take(
  gen: AsyncGenerator<FeedItem>,
  n: number,
  ctl: AbortController
): Promise<FeedItem[]> {
  const out: FeedItem[] = [];
  for await (const item of gen) {
    out.push(item);
    if (out.length >= n) break;
  }
  ctl.abort();
  return out;
}

describe("followConversation", () => {
  it("replays from a cursor, then follows new messages across rotations, and ends on close", async () => {
    const b = boot({ config: { rotateEveryTurns: 2 } });
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "q1");
    await messages(b, id, 2);
    const reader = createConversationReader(b.eventStore);
    const ctl = new AbortController();
    const seen: string[] = [];
    let closed = false;
    const done = (async () => {
      for await (const item of followConversation({ reader, eventStore: b.eventStore }, id, {
        signal: ctl.signal,
        pollMs: 60_000, // prove the NOTIFICATION wakes it, not the poll
      })) {
        if (item.type === "message") seen.push(item.entry.text);
        else closed = true;
      }
    })();
    for (let i = 2; i <= 5; i++) {
      await b.conv.sendTurn(id, `q${i}`);
      await messages(b, id, i * 2);
    }
    await until(() => seen.length === 10, "the follower to catch up");
    expect(seen).toEqual(
      Array.from({ length: 5 }, (_, i) => [`q${i + 1}`, `re: q${i + 1}`]).flat()
    );
    expect((await b.conv.status(id)).generation).toBeGreaterThanOrEqual(2);
    await b.conv.close(id);
    await done;
    expect(closed).toBe(true);
  });

  it("resumes from the cursor of the last message it saw: nothing repeated, nothing skipped", async () => {
    const b = boot();
    const { conversationId: id } = await b.conv.start();
    await b.conv.sendTurn(id, "one");
    await messages(b, id, 2);
    const reader = createConversationReader(b.eventStore);
    const ctl1 = new AbortController();
    const first = await take(
      followConversation({ reader, eventStore: b.eventStore }, id, { signal: ctl1.signal }),
      1,
      ctl1
    );
    const lastSeen = (first[0] as Extract<FeedItem, { type: "message" }>).entry.cursor; // saw only the user message
    await b.conv.sendTurn(id, "two");
    await messages(b, id, 4);
    const ctl2 = new AbortController();
    const resumed = await take(
      followConversation({ reader, eventStore: b.eventStore }, id, {
        cursor: lastSeen,
        signal: ctl2.signal,
      }),
      3,
      ctl2
    );
    expect(resumed.map((i) => (i.type === "message" ? i.entry.text : "closed"))).toEqual([
      "re: one",
      "two",
      "re: two",
    ]);
  });

  it("stops promptly on abort and leaves no subscription behind", async () => {
    const b = boot();
    const { conversationId: id } = await b.conv.start();
    const reader = createConversationReader(b.eventStore);
    let subscribed = 0;
    let unsubscribed = 0;
    const store = new Proxy(b.eventStore, {
      get(t, p, r) {
        if (p === "subscribe") {
          return async (...a: Parameters<typeof t.subscribe>) => {
            subscribed++;
            const off = await t.subscribe(...a);
            return () => {
              unsubscribed++;
              off();
            };
          };
        }
        return Reflect.get(t, p, r);
      },
    });
    const ctl = new AbortController();
    const run = (async () => {
      for await (const _ of followConversation({ reader, eventStore: store }, id, {
        signal: ctl.signal,
        pollMs: 60_000,
      })) {
        void _;
      }
    })();
    await until(() => subscribed >= 2, "subscriptions");
    ctl.abort();
    await run;
    expect(unsubscribed).toBe(subscribed);
  });
});
