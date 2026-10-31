import assert from "node:assert";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  FRAME_JSON,
  FRAME_ZSTD,
  MAX_DECODED_STATE_BYTES,
  SNAPSHOT_FRAME_SENTINEL,
  SnapshotCodecUnavailableError,
  SnapshotDecodeError,
  SnapshotStateTooLargeError,
  decodeState,
  decodeStateMaybeLegacy,
  encodeState,
  isFramedState,
  isSnapshotFrameSentinel,
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

zstd("snapshot codec (ADR 0141)", () => {
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

  it("a frame WITHOUT the content checksum is refused (we always write it; one without was not ours)", () => {
    const c = zlib.constants as Record<string, number>;
    const json = Buffer.from(JSON.stringify({ a: "x".repeat(100) }));
    const noCk = (
      zlib as unknown as { zstdCompressSync(b: Buffer, o: object): Buffer }
    ).zstdCompressSync(json, { params: { [c.ZSTD_c_checksumFlag as number]: 0 } });
    expect(() => decodeState(Buffer.concat([Buffer.of(FRAME_ZSTD), noCk]))).toThrow(
      /no content checksum/
    );
  });

  it("trailing bytes after the frame are refused, as is a second concatenated frame", () => {
    const good = encodeState({ a: "y".repeat(100) }, "zstd");
    expect(() => decodeState(Buffer.concat([good, Buffer.from("zz")]))).toThrow(/trailing byte/);
    expect(() => decodeState(Buffer.concat([good, good.subarray(1)]))).toThrow(/trailing byte/);
  });

  it("a decompression bomb that DECLARES its size is refused from the header, before any inflation", () => {
    // A hand-built, structurally valid frame (13-byte header, one raw 1-byte block, checksum) that
    // declares 600 MiB of content: ~25 bytes on disk. Nothing may be allocated for it.
    const header = Buffer.alloc(5 + 1 + 8);
    header.writeUInt32LE(0xfd2fb528, 0);
    header[4] = 0xc4; // FCS flag 3 (8 bytes), multi-segment, content checksum on
    header[5] = 0x00; // window descriptor
    header.writeBigUInt64LE(BigInt(600 * 1024 * 1024), 6);
    const frame = Buffer.concat([
      Buffer.of(FRAME_ZSTD),
      header,
      Buffer.from([0x09, 0x00, 0x00, 0x20]), // last raw block, size 1
      Buffer.alloc(4),
    ]);
    expect(() => decodeState(frame)).toThrow(SnapshotStateTooLargeError);
    expect(() => decodeState(frame)).toThrow(/600\d* decoded bytes|decoded bytes/);
    expect(new SnapshotStateTooLargeError(1).message).toMatch(String(MAX_DECODED_STATE_BYTES));
  });

  it("a bomb that does NOT declare its size is stopped at the ceiling (typed, not a raw ERR_BUFFER_TOO_LARGE)", async () => {
    // Streamed, so the frame carries no content size: 257 MiB of spaces in 1 MiB writes (~10 KB stored).
    const stream = (
      zlib as unknown as {
        createZstdCompress(o?: object): NodeJS.ReadWriteStream;
      }
    ).createZstdCompress({ params: { [zlib.constants.ZSTD_c_checksumFlag as number]: 1 } });
    const chunks: Buffer[] = [];
    stream.on("data", (d: Buffer) => chunks.push(d));
    const done = new Promise<void>((res, rej) => {
      stream.on("end", () => res());
      stream.on("error", rej);
    });
    const mib = Buffer.alloc(1024 * 1024, 0x20);
    for (let i = 0; i < MAX_DECODED_STATE_BYTES / mib.length + 1; i++) stream.write(mib);
    stream.end();
    await done;
    // the stream closes with a second, empty frame: keep only the first
    const all = Buffer.concat(chunks);
    const second = all.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), 4);
    const frame = Buffer.concat([Buffer.of(FRAME_ZSTD), all.subarray(0, second)]);
    expect(frame.length).toBeLessThan(1024 * 1024);
    expect(() => decodeState(frame)).toThrow(SnapshotStateTooLargeError);
  }, 60_000);

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

describe("SNAPSHOT_FRAME_SENTINEL (ADR 0141 D5)", () => {
  it("is exactly one top-level string __loomEnc, and only that value is recognised", () => {
    expect(isSnapshotFrameSentinel(SNAPSHOT_FRAME_SENTINEL)).toBe(true);
    expect(isSnapshotFrameSentinel({ ...SNAPSHOT_FRAME_SENTINEL })).toBe(true);
    expect(isSnapshotFrameSentinel({ ...SNAPSHOT_FRAME_SENTINEL, extra: 1 })).toBe(false);
    expect(isSnapshotFrameSentinel({ __loomEnc: "loom/aes-256-gcm" })).toBe(false);
    expect(isSnapshotFrameSentinel(null)).toBe(false);
    expect(isSnapshotFrameSentinel([SNAPSHOT_FRAME_SENTINEL])).toBe(false);
    expect(typeof SNAPSHOT_FRAME_SENTINEL.__loomEnc).toBe("string");
  });
});
