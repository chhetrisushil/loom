// ── Escaping for every place a generator interpolates a spec- or model-derived string ──
//
// The ChangeSpec is produced by a MODEL (appgen-model) or by free-form user text
// (parseIntent), so every string in it is untrusted. Generated TypeScript lives in the
// user's project, which makes any unescaped interpolation a code-injection channel
// (a newline ends a `//` comment, `*/` ends a block comment, `"` ends a string literal,
// `${` opens a template substitution). These helpers are the ONLY sanctioned way to put
// such text into generated source; defence is at the sink, whatever the validators did.

/**
 * Every character that must never reach generated source or a plan field raw: C0/DEL/C1
 * controls (Cc), ALL format characters (Cf: soft hyphen, zero-width and bidi marks and
 * overrides and isolates, BOM, interlinear annotation FFF9-FFFB, the Unicode "tag"
 * characters U+E0000-E007F used for ASCII smuggling, musical-notation formatting
 * U+1D173-1D17A), line and paragraph separators (Zl, Zp), lone surrogates (Cs), the
 * combining grapheme joiner U+034F (a Mn that renders as nothing) and the unassigned
 * U+2065 inside the bidi block. The `u` flag is what makes the astral ranges match.
 */
const UNSAFE_SOURCE = "[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Cs}\\u034f\\u2065]";
const UNSAFE_CHARS = new RegExp(UNSAFE_SOURCE, "gu");
const UNSAFE_ONE = new RegExp(UNSAFE_SOURCE, "u");

/** Does `s` contain any character that must never reach generated source or a plan field? */
export function hasUnsafeChars(s: string): boolean {
  return UNSAFE_ONE.test(s);
}

/** `\uXXXX` for a BMP code point, a `\uD8xx\uDCxx` surrogate pair for an astral one. */
function unicodeEscape(c: string): string {
  const cp = c.codePointAt(0) ?? 0;
  const u = (n: number): string => `\\u${n.toString(16).padStart(4, "0")}`;
  if (cp <= 0xffff) return u(cp);
  const v = cp - 0x10000;
  return u(0xd800 + (v >> 10)) + u(0xdc00 + (v & 0x3ff));
}

/** Text for a single-line `// ...` comment: every unsafe character becomes a space. */
export function commentText(s: string): string {
  return s.replace(UNSAFE_CHARS, " ");
}

/** Text for a block comment: single-line as above, and a comment delimiter can never appear. */
export function blockCommentText(s: string): string {
  return commentText(s).replace(/\*\//g, "* /").replace(/\/\*/g, "/ *");
}

/**
 * A complete, quoted TypeScript string literal. `JSON.stringify` escapes quotes,
 * backslashes, C0 controls and lone surrogates; every other unsafe character (U+2028/2029,
 * bidi, zero-width, tag characters, ...) is escaped explicitly - astral ones as a surrogate
 * pair - so the literal is inert and reads the same in every editor.
 */
export function tsStringLiteral(s: string): string {
  return JSON.stringify(s).replace(UNSAFE_CHARS, unicodeEscape);
}

/** The CONTENT (no surrounding backticks) of a template literal: `\`, backtick and `${` escaped. */
export function templateLiteralText(s: string): string {
  return tsStringLiteral(s)
    .slice(1, -1)
    .replace(/\\"/g, '"')
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

/** One line of markdown prose: no line breaks, and markup/HTML metacharacters neutralised. */
export function markdownText(s: string): string {
  return commentText(s)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_{}[\]<>#|!&~]/g, (c) => `\\${c}`);
}
