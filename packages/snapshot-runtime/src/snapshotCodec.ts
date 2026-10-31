import zlib from "node:zlib";
import type { ExecutionState } from "@loom/core";

/**
 * ADR 0140 - the snapshot STATE codec.
 *
 * A snapshot is a cache over the log: whatever is stored must decode to the IDENTICAL folded state.
 * The codec therefore stores `JSON.stringify(state)` (the same text SQLite has always held), either
 * verbatim or zstd-compressed, behind ONE format byte. Nothing here is lossy (unlike msgpack/CBOR it
 * keeps `__proto__` keys, lone surrogates and key order, because it is JSON and nothing else).
 *
 * Frame = `[format byte][payload]`:
 *
 * | byte | payload                              |
 * | ---- | ------------------------------------ |
 * | 0x01 | UTF-8 JSON, uncompressed (a state too small or too random for zstd to help) |
 * | 0x02 | zstd (level 3, checksummed) of UTF-8 JSON |
 *
 * Both are control characters, which can never start a JSON text, so a reader that may meet a
 * pre-codec plain-JSON plaintext (the sealed path) tells the two apart by the first byte alone
 * ({@link decodeStateMaybeLegacy}). An unknown byte is a LOUD error, never a guess.
 */
export type SnapshotCodecName = "none" | "zstd";

/** Format byte: UTF-8 JSON, stored uncompressed. */
export const FRAME_JSON = 0x01;
/** Format byte: zstd-compressed UTF-8 JSON. */
export const FRAME_ZSTD = 0x02;

const ZSTD_LEVEL = 3;
/**
 * A decompression ceiling. A snapshot row is trusted storage, but a corrupted or tampered one must not
 * be able to allocate without bound. 1 GiB is far above any state a resume could usefully read.
 */
export const MAX_DECODED_STATE_BYTES = 1024 * 1024 * 1024;

/** The opt-in was requested on a runtime whose Node has no `zlib.zstd*` (needs >= 22.15). */
export class SnapshotCodecUnavailableError extends Error {
  constructor(codec: string) {
    super(
      `snapshot codec "${codec}" needs Node >= 22.15 (zlib.zstdCompressSync); this is Node ${process.versions.node}. Leave the codec off (the default) or upgrade Node. Existing snapshots are unaffected.`
    );
    this.name = "SnapshotCodecUnavailableError";
  }
}

/** A stored state whose format byte this build does not know, or whose payload does not decode. */
export class SnapshotDecodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SnapshotDecodeError";
  }
}

interface ZstdZlib {
  zstdCompressSync(b: Buffer, o: object): Buffer;
  zstdDecompressSync(b: Buffer, o: object): Buffer;
}

/** Whether this Node can write AND read zstd frames. */
export function zstdAvailable(): boolean {
  const z = zlib as unknown as Record<string, unknown>;
  return typeof z.zstdCompressSync === "function" && typeof z.zstdDecompressSync === "function";
}

/** Throw {@link SnapshotCodecUnavailableError} unless `codec` can be written here. `"none"` always can. */
export function assertSnapshotCodecAvailable(codec: SnapshotCodecName): void {
  if (codec === "zstd" && !zstdAvailable()) throw new SnapshotCodecUnavailableError("zstd");
}

/** Validate a user-supplied codec name (a JS caller can pass anything). */
export function parseSnapshotCodec(value: unknown): SnapshotCodecName {
  if (value === undefined || value === "none") return "none";
  if (value === "zstd") return "zstd";
  throw new TypeError(`snapshot codec must be "none" or "zstd" (got ${JSON.stringify(value)})`);
}

function zstdCompress(raw: Buffer): Buffer {
  const c = zlib.constants as unknown as Record<string, number>;
  return (zlib as unknown as ZstdZlib).zstdCompressSync(raw, {
    params: {
      [c.ZSTD_c_compressionLevel as number]: ZSTD_LEVEL,
      // A 4-byte content checksum: a bit-flipped row fails loudly instead of decoding to wrong state.
      [c.ZSTD_c_checksumFlag as number]: 1,
    },
  });
}

function zstdDecompress(buf: Buffer): Buffer {
  return (zlib as unknown as ZstdZlib).zstdDecompressSync(buf, {
    maxOutputLength: MAX_DECODED_STATE_BYTES,
  });
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Encode `state` as a frame. With `"zstd"` the state is compressed, unless that does not make it smaller
 * (then the JSON is framed verbatim: a frame is never larger than the text plus one byte).
 */
export function encodeState(state: unknown, codec: SnapshotCodecName): Buffer {
  const json = Buffer.from(JSON.stringify(state), "utf-8");
  if (codec === "zstd") {
    assertSnapshotCodecAvailable("zstd");
    const z = zstdCompress(json);
    if (z.length < json.length) return Buffer.concat([Buffer.of(FRAME_ZSTD), z]);
  }
  return Buffer.concat([Buffer.of(FRAME_JSON), json]);
}

/** Whether `bytes` starts with a known frame byte. */
export function isFramedState(bytes: Uint8Array): boolean {
  const b = bytes[0];
  return b === FRAME_JSON || b === FRAME_ZSTD;
}

/** Decode a frame written by {@link encodeState}. Strict: an unknown format byte throws. */
export function decodeState(bytes: Uint8Array): ExecutionState {
  return decodeFrame(bytes) as ExecutionState;
}

function decodeFrame(bytes: Uint8Array): unknown {
  const buf = asBuffer(bytes);
  const fmt = buf[0];
  if (fmt === FRAME_JSON || fmt === FRAME_ZSTD) {
    if (fmt === FRAME_ZSTD) assertSnapshotCodecAvailable("zstd");
    try {
      const body = buf.subarray(1);
      return JSON.parse((fmt === FRAME_ZSTD ? zstdDecompress(body) : body).toString("utf-8"));
    } catch (err) {
      throw new SnapshotDecodeError(
        `snapshot state (format 0x${fmt.toString(16).padStart(2, "0")}) does not decode: ${(err as Error).message}`,
        { cause: err }
      );
    }
  }
  throw new SnapshotDecodeError(
    fmt === undefined
      ? "snapshot state is empty"
      : `snapshot state has unknown format byte 0x${fmt.toString(16).padStart(2, "0")} (this build knows 0x01 and 0x02); it was written by a newer loom`
  );
}

/**
 * Decode `bytes` that are EITHER a frame OR a legacy bare UTF-8 JSON text (what a sealed envelope held
 * before the codec existed). Safe because a frame starts with a control byte no JSON text can start with.
 */
export function decodeStateMaybeLegacy(bytes: Uint8Array): unknown {
  if (isFramedState(bytes)) return decodeFrame(bytes);
  return JSON.parse(asBuffer(bytes).toString("utf-8"));
}
