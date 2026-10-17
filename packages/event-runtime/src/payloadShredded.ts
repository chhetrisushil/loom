/**
 * The realm-safe brand of the erasure outcome (ADR 0039, amendment 2026-10-17 (c)). A crypto-shredded
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
 *
 * Brand BEFORE freezing: a frozen or otherwise non-extensible object cannot take the brand, and
 * throwing here would replace the erasure with a TypeError. For such an object this returns a branded
 * WRAPPER instead (a new `Error` with the same name, message, own fields and stack, `cause` = the
 * original), so the erasure is still recognised.
 */
export function brandPayloadShredded<T extends object>(err: T): T {
  if (!Object.isExtensible(err)) {
    const src = err as unknown as Record<string, unknown>;
    const wrapper = new Error(typeof src.message === "string" ? src.message : "", { cause: err });
    for (const key of Object.getOwnPropertyNames(src)) {
      if (key === "cause") continue;
      const d = Object.getOwnPropertyDescriptor(src, key);
      if (d !== undefined) Object.defineProperty(wrapper, key, { ...d, configurable: true });
    }
    if (!Object.prototype.hasOwnProperty.call(src, "name") && typeof src.name === "string") {
      Object.defineProperty(wrapper, "name", {
        value: src.name,
        configurable: true,
        writable: true,
      });
    }
    return brandPayloadShredded(wrapper) as unknown as T;
  }
  Object.defineProperty(err, PAYLOAD_SHREDDED_BRAND, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return err;
}

/**
 * True when `err` carries the {@link PAYLOAD_SHREDDED_BRAND} as an OWN property (an inherited brand,
 * e.g. from a shared prototype, does not count). The ONE definition every consumer uses.
 * A plain object or `Error` that only has `name === "PayloadShreddedError"` is NOT shredded, and a
 * value that crossed a process boundary (JSON) has lost the brand: such a boundary must re-establish
 * trust explicitly (e.g. by checking the log's own `PAYLOAD_SHREDDED` tombstone).
 */
export function isPayloadShredded(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    Object.prototype.hasOwnProperty.call(err, PAYLOAD_SHREDDED_BRAND) &&
    (err as Record<symbol, unknown>)[PAYLOAD_SHREDDED_BRAND] === true
  );
}
