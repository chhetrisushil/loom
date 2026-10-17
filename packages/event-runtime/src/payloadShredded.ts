/**
 * The realm-safe brand of the erasure outcome (ADR 0039, amendment 2026-10-17 (b)). A crypto-shredded
 * payload is recognised by THIS symbol, never by the error's `name` alone: any store decorator, third
 * party store or app code can throw an `Error` that merely NAMES itself `PayloadShreddedError`, and on
 * the authorization path "proven erasure" means "unknown owner", which `unknownOwner: "allow"` admits.
 *
 * `Symbol.for` (the global registry) makes the brand survive duplicated package copies (dual CJS/ESM
 * builds, two installs), where `instanceof` does not. A store that cannot extend the crypto plugin's
 * class sets the brand on its own error with {@link brandPayloadShredded}.
 */
export const PAYLOAD_SHREDDED_BRAND: unique symbol = Symbol.for("loom.payloadShredded") as never;

/**
 * Mark `err` as the erasure outcome (non-enumerable, so serialization and logging are unchanged) and
 * return it. Idempotent. The error's `name` and message are untouched.
 */
export function brandPayloadShredded<T extends object>(err: T): T {
  Object.defineProperty(err, PAYLOAD_SHREDDED_BRAND, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return err;
}

/**
 * True when `err` carries the {@link PAYLOAD_SHREDDED_BRAND}. The ONE definition every consumer uses.
 * A plain object or `Error` that only has `name === "PayloadShreddedError"` is NOT shredded, and a
 * value that crossed a process boundary (JSON) has lost the brand: such a boundary must re-establish
 * trust explicitly (e.g. by checking the log's own `PAYLOAD_SHREDDED` tombstone).
 */
export function isPayloadShredded(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<symbol, unknown>)[PAYLOAD_SHREDDED_BRAND] === true
  );
}
