import { describe, expect, it } from "vitest";
import { evt } from "./foldedFixtures";
import { foldView, sensitivePathsFor } from "./sensitiveInput";
import { GUARD_WALK_BUDGET, SensitiveStateError } from "./sensitiveState";

const sealedField = { __loomEnc: "loom/aes-256-gcm", iv: "iviviviv", ct: "ctctctct" };
const seal = (covers: string[]) => ({ seal: { v: 1, cipher: "loom/aes-256-gcm", covers } });

describe("sensitivePathsFor (ADR 0132 D11)", () => {
  it("unions the declared paths with the event's own seal marker, for that event type only", () => {
    const e = {
      ...evt("x", 0, "STEP_COMPLETED", {}),
      metadata: seal(["STEP_COMPLETED.output.ssn", "OTHER.a"]),
    };
    expect(sensitivePathsFor(e, { STEP_COMPLETED: ["email", "output.ssn"], OTHER: ["z"] })).toEqual(
      ["email", "output.ssn"]
    );
  });

  it("is empty when nothing is declared and the event carries no marker", () => {
    expect(sensitivePathsFor(evt("x", 0, "STEP_COMPLETED"), {})).toEqual([]);
  });
});

describe("foldView — what a handler is allowed to see", () => {
  it("masks declared paths, keeps presence, leaves the original event untouched", () => {
    const e = evt("x", 0, "STEP_COMPLETED", { step: "ocr", email: "alice@example.com" });
    const { event } = foldView("m", e, { STEP_COMPLETED: ["email"] });
    expect(event.payload).toEqual({ step: "ocr", email: "[redacted]" });
    expect(e.payload).toEqual({ step: "ocr", email: "alice@example.com" });
  });

  it("resolves array wildcards", () => {
    const e = evt("x", 0, "E", {
      people: [
        { ssn: "111-22-3333", id: "a" },
        { ssn: "444-55-6666", id: "b" },
      ],
    });
    const { event, lifted } = foldView("m", e, { E: ["people[].ssn"] });
    expect(event.payload).toEqual({
      people: [
        { ssn: "[redacted]", id: "a" },
        { ssn: "[redacted]", id: "b" },
      ],
    });
    expect([...lifted.strings].sort()).toEqual(["111-22-3333", "444-55-6666"]);
  });

  it("lifts only values long enough to mean something, from the original event", () => {
    const { lifted } = foldView(
      "m",
      evt("x", 0, "E", { a: "ok", b: "long-enough", n: 7, big: 9876543, f: 1234567.5 }),
      { E: ["a", "b", "n", "big", "f"] }
    );
    expect([...lifted.strings]).toEqual(["long-enough"]);
    expect([...lifted.numbers]).toEqual([9876543]);
  });

  it("lifts through isLiftable only: negative integers count, short ones do not", () => {
    const { lifted } = foldView("m", evt("x", 0, "E", { a: -1234567, b: -12 }), {
      E: ["a", "b"],
    });
    expect([...lifted.numbers]).toEqual([-1234567]);
  });

  it("masks a cipher envelope wherever it sits, even with nothing declared, and lifts nothing from ciphertext", () => {
    const { event, lifted } = foldView(
      "m",
      evt("x", 0, "E", { step: "ocr", deep: { f: [sealedField] } }),
      {}
    );
    expect(event.payload).toEqual({ step: "ocr", deep: { f: ["[redacted]"] } });
    expect(lifted.strings.size).toBe(0);
  });

  it("masks an envelope that sits ON a sensitive path (a raw at-rest read) and lifts nothing from it", () => {
    const { event, lifted } = foldView("m", evt("x", 0, "E", { email: sealedField }), {
      E: ["email"],
    });
    expect(event.payload).toEqual({ email: "[redacted]" });
    expect(lifted.strings.size).toBe(0);
  });

  it("masks a { $shredded } placeholder on a sensitive path like any other value", () => {
    const { event } = foldView("m", evt("x", 0, "E", { email: { $shredded: true } }), {
      E: ["email"],
    });
    expect(event.payload).toEqual({ email: "[redacted]" });
  });

  it("hands every call a fresh copy, even with nothing to hide, so a mutating handler leaks nowhere", () => {
    const e = evt("x", 0, "E", { a: 1, nested: { list: [1, 2] } });
    const first = foldView("m", e, {}).event;
    const second = foldView("n", e, {}).event;
    expect(first).toEqual(e);
    expect(first).not.toBe(e);
    expect(first.payload).not.toBe(e.payload);
    (first.payload as { a: number; nested: { list: number[] } }).a = 99;
    (first.payload as { nested: { list: number[] } }).nested.list.push(3);
    (first as { eventType: string }).eventType = "HACKED";
    expect(second.payload).toEqual({ a: 1, nested: { list: [1, 2] } });
    expect(e.payload).toEqual({ a: 1, nested: { list: [1, 2] } });
    expect(e.eventType).toBe("E");
  });

  it("a masked view shares no structure with the original either", () => {
    const e = evt("x", 0, "E", { email: "alice@example.com", keep: { n: [1] } });
    const { event } = foldView("m", e, { E: ["email"] });
    (event.payload as { keep: { n: number[] } }).keep.n.push(2);
    expect(e.payload).toEqual({ email: "alice@example.com", keep: { n: [1] } });
  });

  it("fails closed on a payload too large to verify", () => {
    const e = evt("x", 0, "E", { big: new Array(GUARD_WALK_BUDGET + 1).fill(0) });
    expect(() => foldView("m", e, {})).toThrow(SensitiveStateError);
  });

  it("does not throw on an event with no payload object", () => {
    expect(foldView("m", evt("x", 0, "E", null), { E: ["a"] }).event.payload).toBeNull();
  });
});
