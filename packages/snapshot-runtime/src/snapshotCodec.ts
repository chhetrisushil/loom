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
 * be able to allocate without bound (a 19 KB frame can declare 600 MiB). 256 MiB is far above any state a
 * resume could usefully read. A frame that DECLARES a larger content size is refused before a byte is
 * inflated; one that does not declare it is stopped at this ceiling.
 */
export const MAX_DECODED_STATE_BYTES = 256 * 1024 * 1024;

/**
 * The value a store writes into a legacy-format column (Postgres `snapshots.state`, `NOT NULL`) of a row
 * whose real state lives in a codec frame (`state_z`). It is NOT a state. It is chosen so that every
 * reader that predates the codec FAILS LOUDLY on it instead of reading a null or an empty state:
 * the runtime's seal guard reads a top-level string `__loomEnc` as an unopened sealed checkpoint
 * (`SealedStreamUnreadableError`), the content sweep counts it as a sealed snapshot and refuses
 * (`SealedSnapshotScanError`), the crypto store does not mistake it for its own cipher, and anything that
 * seeds a fold from it trips `assertSnapshotIdentity` (no `executionId`). A reader that knows the codec
 * decodes `state_z` first and treats this value WITHOUT a frame as corruption.
 */
export const SNAPSHOT_FRAME_SENTINEL: Readonly<{ __loomEnc: string }> = Object.freeze({
  __loomEnc: "loom.snapshot-frame/state_z",
});

/** Whether `value` is exactly {@link SNAPSHOT_FRAME_SENTINEL}. */
export function isSnapshotFrameSentinel(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === "__loomEnc" &&
    (value as { __loomEnc?: unknown }).__loomEnc === SNAPSHOT_FRAME_SENTINEL.__loomEnc
  );
}

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

/** A frame declares (or inflates to) more than {@link MAX_DECODED_STATE_BYTES}. Typed, so callers can tell it from corruption. */
export class SnapshotStateTooLargeError extends SnapshotDecodeError {
  constructor(declared: number | undefined) {
    super(
      declared === undefined
        ? `snapshot state inflates past the ${MAX_DECODED_STATE_BYTES}-byte decode ceiling`
        : `snapshot state declares ${declared} decoded bytes, over the ${MAX_DECODED_STATE_BYTES}-byte decode ceiling`
    );
    this.name = "SnapshotStateTooLargeError";
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

/**
 * Walk the header and block headers of the FIRST zstd frame of `buf` (O(blocks), no inflation) and
 * return where it ends, whether it carries the content checksum, and its declared content size.
 * Throws {@link SnapshotDecodeError} on anything that is not a well-formed frame.
 */
function zstdFrameInfo(buf: Buffer): { end: number; checksum: boolean; contentSize?: number } {
  const bad = (why: string): never => {
    throw new SnapshotDecodeError(`snapshot zstd frame is malformed: ${why}`);
  };
  if (buf.length < 6 || buf.readUInt32LE(0) !== 0xfd2fb528) return bad("bad magic");
  const d = buf[4] as number;
  const fcsFlag = d >> 6;
  const single = ((d >> 5) & 1) === 1;
  const checksum = ((d >> 2) & 1) === 1;
  if (((d >> 3) & 1) === 1) return bad("reserved bit set");
  let pos = 5 + (single ? 0 : 1) + ([0, 1, 2, 4] as const)[d & 3]!;
  const fcsBytes = fcsFlag === 0 ? (single ? 1 : 0) : ([0, 2, 4, 8] as const)[fcsFlag]!;
  let contentSize: number | undefined;
  if (pos + fcsBytes > buf.length) return bad("truncated header");
  if (fcsBytes === 1) contentSize = buf[pos];
  else if (fcsBytes === 2) contentSize = buf.readUInt16LE(pos) + 256;
  else if (fcsBytes === 4) contentSize = buf.readUInt32LE(pos);
  else if (fcsBytes === 8) contentSize = Number(buf.readBigUInt64LE(pos));
  pos += fcsBytes;
  for (;;) {
    if (pos + 3 > buf.length) return bad("truncated block header");
    const h = buf[pos]! | (buf[pos + 1]! << 8) | (buf[pos + 2]! << 16);
    const type = (h >> 1) & 3;
    if (type === 3) return bad("reserved block type");
    pos += 3 + (type === 1 ? 1 : h >>> 3);
    if (pos > buf.length) return bad("truncated block");
    if ((h & 1) === 1) break;
  }
  if (checksum) pos += 4;
  if (pos > buf.length) return bad("truncated checksum");
  return { end: pos, checksum, ...(contentSize !== undefined && { contentSize }) };
}

function zstdDecompress(buf: Buffer): Buffer {
  const info = zstdFrameInfo(buf);
  // We always write the content checksum, so a frame without one was not written by us.
  if (!info.checksum) throw new SnapshotDecodeError("snapshot zstd frame has no content checksum");
  // Exactly one frame: anything after it would be silently decoded (or ignored) by the library.
  if (info.end !== buf.length) {
    throw new SnapshotDecodeError(
      `snapshot zstd frame is followed by ${buf.length - info.end} trailing byte(s)`
    );
  }
  if (info.contentSize !== undefined && info.contentSize > MAX_DECODED_STATE_BYTES) {
    throw new SnapshotStateTooLargeError(info.contentSize);
  }
  try {
    return (zlib as unknown as ZstdZlib).zstdDecompressSync(buf, {
      maxOutputLength: MAX_DECODED_STATE_BYTES,
    });
  } catch (err) {
    if ((err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new SnapshotStateTooLargeError(undefined);
    }
    throw err;
  }
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
      if (err instanceof SnapshotDecodeError) throw err;
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
