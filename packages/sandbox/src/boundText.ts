/** Script-authored error text is bounded before it can reach the append-only log. */
export const SANDBOX_MESSAGE_LIMIT = 2048;
/** The same bound for a thrown value's `name`, which is equally script-authored. */
export const SANDBOX_NAME_LIMIT = 128;

/**
 * Bound script-authored text to at most `limit` UTF-16 units AND make it storable.
 *
 * Two hazards beyond length. A plain `slice` can cut a surrogate pair in half, leaving a
 * lone surrogate; and a script can produce lone surrogates (or NUL) itself. Both encode in
 * JSON as `\uD800`/`\u0000` escapes, which Postgres `jsonb` REJECTS — so the STEP_FAILED
 * append would fail on a durable store while passing in memory. A pair straddling the cut is
 * dropped whole; every remaining lone surrogate and NUL becomes U+FFFD.
 *
 * Linear in `limit`, not in the input: the input is sliced first, so a 10 MB string costs
 * no more than a 2 KB one.
 */
export function boundText(text: string, limit: number): string {
  let head = text.length > limit ? text.slice(0, limit) : text;
  // A high surrogate in the last slot had its low half cut off (or never had one) — drop it
  // rather than let the replacement below turn half a character into U+FFFD.
  if (text.length > limit) {
    const last = head.charCodeAt(head.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  }
  return head.replace(LONE_SURROGATE, "�").replaceAll("\u0000", "�");
}

/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
