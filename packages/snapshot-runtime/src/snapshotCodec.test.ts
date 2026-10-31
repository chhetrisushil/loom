import assert from "node:assert";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  FRAME_JSON,
  FRAME_ZSTD,
  SnapshotCodecUnavailableError,
  SnapshotDecodeError,
  decodeState,
  decodeStateMaybeLegacy,
  encodeState,
  isFramedState,
  parseSnapshotCodec,
  zstdAvailable,
} from "./snapshotCodec";

// zstd needs Node >= 22.15; CI also runs Node 20, where the opt-in is refused and these are skipped.
const zstd = describe.skipIf(!zstdAvailable());

/** The states the codec must reproduce byte-for-byte as JSON text (and deep-equal). */
function adversarialStates(): Record<string, unknown> {
  const proto = JSON.parse('{"__proto__":{"polluted":true},"a":1,"constructor":{"x":1}}');
  let deep: unknown = { leaf: true };
  for (let i = 0; i < 400; i++) deep = { n: deep, i };
  const words = "the customer ticket refund order invoice payment failed retry approval".split(" ");
  const big = {
    steps: Object.fromEntries(
      Array.from({ length: 2000 }, (_, i) => [
        `step-${i}`,
        {
          text: Array.from({ length: 40 }, (_, j) => words[(i * 7 + j * 3) % words.length]).join(
            " "
          ),
          i,
        },
      ])
    ),
  };
  return {
    plain: { executionId: "e", status: "RUNNING", variables: { a: [1, 2, { b: null }], s: "x" } },
    claimChecked: {
      variables: {
        out: { $ref: `sha256:${"ab".repeat(32)}`, size: 12345, mediaType: "text/plain" },
      },
    },
    protoKey: proto,
    loneSurrogates: { hi: "a\ud800b", lo: "c\udc00d", pair: "😀", nul: "x\u0000y" },
    unicode: { k: "héllo 世界   ", é: 1 },
    keyOrder: { z: 1, a: 2, m: { y: 1, b: 2 }, 10: "ten", 2: "two" },
    numbers: { n: [0, 1e21, 1.5e-7, Number.MAX_SAFE_INTEGER] },
    deep,
    big,
    empty: {},
  };
}

zstd("snapshot codec (ADR 0140)", () => {
  for (const [name, state] of Object.entries(adversarialStates())) {
    for (const codec of ["none", "zstd"] as const) {
      it(`${codec}: ${name} round-trips deep-equal and byte-identical as JSON`, () => {
        const frame = encodeState(state, codec);
        expect(isFramedState(frame)).toBe(true);
        const back = decodeState(frame);
        assert.deepStrictEqual(back, state); // vitest mishandles an own __proto__ key
        expect(JSON.stringify(back)).toBe(JSON.stringify(state));
      });
    }
  }

  it("a __proto__ key is an OWN key after decode and does not pollute", () => {
    const state = JSON.parse('{"__proto__":{"polluted":true}}');
    const back = decodeState(encodeState(state, "zstd")) as unknown as Record<string, unknown>;
    expect(Object.hasOwn(back, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("compresses a repetitive state with the zstd frame byte, and is smaller than the JSON", () => {
    const big = adversarialStates().big;
    const frame = encodeState(big, "zstd");
    expect(frame[0]).toBe(FRAME_ZSTD);
    expect(frame.length).toBeLessThan(JSON.stringify(big).length / 4);
  });

  it("frames verbatim JSON (never larger than text + 1 byte) when zstd does not help", () => {
    const tiny = { a: 1 };
    const frame = encodeState(tiny, "zstd");
    expect(frame[0]).toBe(FRAME_JSON);
    expect(frame.length).toBe(JSON.stringify(tiny).length + 1);
    expect(decodeState(frame)).toStrictEqual(tiny);
  });

  it('"none" is the verbatim JSON frame', () => {
    const frame = encodeState({ a: 1 }, "none");
    expect(frame[0]).toBe(FRAME_JSON);
    expect(frame.subarray(1).toString("utf-8")).toBe('{"a":1}');
  });

  it("an unknown format byte is a loud error, never a guess", () => {
    const frame = Buffer.concat([Buffer.of(0x7f), Buffer.from("{}")]);
    expect(() => decodeState(frame)).toThrow(SnapshotDecodeError);
    expect(() => decodeState(frame)).toThrow(/unknown format byte 0x7f/);
    expect(() => decodeState(new Uint8Array(0))).toThrow(/empty/);
  });

  it("a bit-flipped zstd payload fails (checksum), not decodes to a wrong state", () => {
    const frame = Buffer.from(encodeState(adversarialStates().big, "zstd"));
    const mid = Math.floor(frame.length / 2);
    frame[mid] = (frame[mid] ?? 0) ^ 0xff;
    expect(() => decodeState(frame)).toThrow(SnapshotDecodeError);
  });

  it("a truncated zstd payload fails", () => {
    const frame = encodeState(adversarialStates().big, "zstd");
    expect(() => decodeState(frame.subarray(0, frame.length - 9))).toThrow(SnapshotDecodeError);
  });

  it("decodeStateMaybeLegacy reads a bare JSON text AND a frame (the sealed-envelope dispatch)", () => {
    const state = { v: [1, { a: "b" }] };
    expect(decodeStateMaybeLegacy(Buffer.from(JSON.stringify(state)))).toStrictEqual(state);
    expect(decodeStateMaybeLegacy(encodeState(state, "zstd"))).toStrictEqual(state);
    // every JSON text starts with a byte that is not a frame byte
    for (const text of ['{"a":1}', "[1]", '"s"', "1", "-1", "true", "false", "null", ' {"a":1}']) {
      expect(isFramedState(Buffer.from(text))).toBe(false);
    }
  });

  it("parseSnapshotCodec accepts only none/zstd", () => {
    expect(parseSnapshotCodec(undefined)).toBe("none");
    expect(parseSnapshotCodec("zstd")).toBe("zstd");
    expect(() => parseSnapshotCodec("lz4")).toThrow(TypeError);
  });

  it("the stored bytes are standard zstd (readable by any zstd tool)", () => {
    const state = adversarialStates().big;
    const frame = encodeState(state, "zstd");
    const raw = (zlib as unknown as { zstdDecompressSync(b: Buffer): Buffer }).zstdDecompressSync(
      frame.subarray(1)
    );
    expect(raw.toString("utf-8")).toBe(JSON.stringify(state));
  });
});

describe("snapshot codec availability", () => {
  it("SnapshotCodecUnavailableError names the Node requirement", () => {
    expect(new SnapshotCodecUnavailableError("zstd").message).toMatch(/Node >= 22\.15/);
  });
});
