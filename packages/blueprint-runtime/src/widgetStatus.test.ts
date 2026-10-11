import { describe, expect, it } from "vitest";
import type { BindingStatus, Widget } from "./types";
import { describeWidgetStatus } from "./widgetStatus";
import { MetricCard } from "./widgets";

const channel = MetricCard({
  id: "m",
  title: "CPU",
  binding: { projectionId: "p", path: "v", status: { path: "s" } },
});
const bare = MetricCard({ id: "b", title: "B", binding: { projectionId: "p", path: "v" } });
const st = (state: BindingStatus["state"], message?: string): BindingStatus => ({
  state,
  ...(message !== undefined && { finding: { code: "c", message } }),
});

describe("describeWidgetStatus: the canonical matrix", () => {
  const tag = (
    w: Widget,
    v: unknown,
    s?: BindingStatus,
    c?: Parameters<typeof describeWidgetStatus>[3]
  ) => describeWidgetStatus(w, v, s, c).tag;

  it("error > empty > contract > stale > pending/loading > ready", () => {
    const contract = () => ({ code: "x", message: "bad shape" });
    // error and empty outrank a failing contract and ignore a value beside them
    expect(tag(channel, 1, st("error"), contract)).toBe("error");
    expect(tag(channel, 1, st("empty"), contract)).toBe("empty");
    // a contract finding outranks stale, pending and ready
    expect(tag(channel, 1, st("stale"), contract)).toBe("error");
    expect(tag(channel, 1, st("pending"), contract)).toBe("error");
    expect(tag(channel, 1, st("ready"), contract)).toBe("error");
    expect(tag(channel, 1, undefined, contract)).toBe("error");
    // without one
    expect(tag(channel, 1, st("stale"))).toBe("stale");
    expect(tag(channel, undefined, st("stale"))).toBe("stale");
    expect(tag(channel, 1, st("pending"))).toBe("pending");
    expect(tag(channel, undefined, st("pending"))).toBe("loading");
    expect(tag(channel, 1, st("ready"))).toBe("ready");
    expect(tag(channel, undefined, st("ready"))).toBe("loading");
    // a status that has not landed behaves like ready / loading
    expect(tag(channel, 1, undefined)).toBe("ready");
    expect(tag(channel, undefined, undefined)).toBe("loading");
  });

  it("redacted outranks everything, reads nothing of the widget, and carries only a constant (IR 2.5.0)", () => {
    const secret = MetricCard({
      id: "r_1",
      title: "TOP SECRET TITLE",
      binding: { projectionId: "p", path: "v", status: { path: "s" } },
    });
    const red = {
      ...secret,
      source: { type: "redacted", version: "1", redacted: true, degradedFrom: "not-an-array" },
    } as unknown as Widget;
    let checked = 0;
    const d = describeWidgetStatus(red, "TOP SECRET VALUE", st("error", "SECRET FINDING"), () => {
      checked++;
      return { code: "x", message: "SECRET CHECK" };
    });
    expect(checked).toBe(0);
    expect(d).toEqual({
      tag: "redacted",
      message: "redacted",
      finding: undefined,
      hasValue: false,
      showBody: false,
      degradedChain: undefined,
    });
    expect(JSON.stringify(d)).not.toMatch(/SECRET/);
    // `redacted: false` is not redaction; the ordinary matrix applies.
    const notRed = {
      ...secret,
      source: { type: "T", version: "1", redacted: false },
    } as unknown as Widget;
    expect(describeWidgetStatus(notRed, 1, st("error"), undefined).tag).toBe("error");
  });

  it("the check runs only for a declared channel and never under error or empty", () => {
    let calls = 0;
    const check = () => {
      calls++;
      return undefined;
    };
    describeWidgetStatus(bare, 1, st("ready"), check);
    describeWidgetStatus(channel, 1, st("error"), check);
    describeWidgetStatus(channel, 1, st("empty"), check);
    expect(calls).toBe(0);
    describeWidgetStatus(channel, 1, st("ready"), check);
    expect(calls).toBe(1);
  });

  it("no channel is inert: the body shows whatever the status says", () => {
    const d = describeWidgetStatus(bare, undefined, st("error", "nope"));
    expect(d).toMatchObject({ tag: "inert", showBody: true });
  });

  it("messages: a contract finding wins, defaults apply, the raw finding stays raw", () => {
    const d = (s: BindingStatus | undefined, c?: () => { code: string; message: string }) =>
      describeWidgetStatus(channel, 1, s, c) as { message: string; finding?: string };
    expect(d(st("error", "down")).message).toBe("down");
    expect(d(st("error")).message).toBe("error");
    expect(d(st("empty")).message).toBe("no data");
    expect(d(st("stale")).message).toBe("stale");
    expect(d(st("stale")).finding).toBeUndefined();
    expect(d(st("ready", "ignored"), () => ({ code: "x", message: "contract" })).message).toBe(
      "contract"
    );
  });

  it("showBody: ready, pending, stale-with-value only", () => {
    const body = (v: unknown, s?: BindingStatus) => {
      const d = describeWidgetStatus(channel, v, s);
      return d.tag !== "invalid" && d.showBody;
    };
    expect(body(1, st("ready"))).toBe(true);
    expect(body(1, st("pending"))).toBe(true);
    expect(body(1, st("stale"))).toBe(true);
    expect(body(undefined, st("stale"))).toBe(false);
    expect(body(undefined, st("pending"))).toBe(false);
    expect(body(1, st("error"))).toBe(false);
    expect(body(1, st("empty"))).toBe(false);
  });

  it("degradedChain joins outermost first; empty is undefined", () => {
    const w = (degradedFrom: unknown) =>
      ({ ...channel, source: { type: "t", version: "1", degradedFrom } }) as Widget;
    const chain = (x: unknown) => {
      const d = describeWidgetStatus(w(x), 1, st("ready"));
      return d.tag === "invalid" ? "invalid" : d.degradedChain;
    };
    expect(
      chain([
        { type: "A", version: "1" },
        { type: "B", version: "2" },
      ])
    ).toBe("A@1 › B@2");
    expect(chain([])).toBeUndefined();
    expect(chain(undefined)).toBeUndefined();
  });

  it("a malformed degradedFrom is { tag: 'invalid' } and never throws", () => {
    const w = (degradedFrom: unknown) =>
      ({ ...channel, source: { type: "t", version: "1", degradedFrom } }) as Widget;
    for (const bad of ["oops", 7, {}, null, [null], ["x"], [{ type: "a", version: "1" }, 3]]) {
      expect(describeWidgetStatus(w(bad), 1, st("ready")).tag, JSON.stringify(bad)).toBe("invalid");
    }
    // ... also for a widget with no channel
    expect(
      describeWidgetStatus(
        { ...bare, source: { type: "t", version: "1", degradedFrom: "x" } } as unknown as Widget,
        1,
        undefined
      ).tag
    ).toBe("invalid");
  });
});
