// ── Escaping for every place appgen interpolates a spec- or model-derived string ──
//
// The ChangeSpec is produced by a MODEL (appgen-model) or by free-form user text
// (parseIntent), so every string in it is untrusted. Generated TypeScript lives in the
// user's project, which makes any unescaped interpolation a code-injection channel
// (a newline ends a `//` comment, `*/` ends a block comment, `"` ends a string literal,
// `${` opens a template substitution). These helpers are the ONLY sanctioned way to put
// such text into generated source; defence is at the sink, whatever the validators did.

/**
 * Line terminators (CR, LF, U+2028, U+2029), the remaining C0/DEL/C1 controls, and the
 * bidirectional-override / invisible characters used for "Trojan Source" spoofing.
 */
const UNSAFE_SOURCE =
  "[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff]";
const UNSAFE_CHARS = new RegExp(UNSAFE_SOURCE, "g");

/** Does `s` contain any character that must never reach generated source or a plan field? */
export function hasUnsafeChars(s: string): boolean {
  return new RegExp(UNSAFE_SOURCE).test(s);
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
 * backslashes and control characters (and, on Node >= 12, lone surrogates); U+2028/2029
 * and the invisible/bidi characters are escaped explicitly so the literal is inert and
 * reads the same in every editor.
 */
export function tsStringLiteral(s: string): string {
  return JSON.stringify(s).replace(
    UNSAFE_CHARS,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
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
  return commentText(s).replace(/[\\`*_{}[\]<>#|!]/g, (c) => `\\${c}`);
}

const SAFE_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Capability / step ids become identifiers, string literals and file paths. They are
 * kebab-case by contract (the validators say so); the generator re-checks because it is
 * a public API and the last line of defence.
 */
export function assertSafeId(kind: string, id: string): string {
  if (typeof id !== "string" || !SAFE_ID.test(id)) {
    throw new Error(
      `appgen: ${kind} id ${JSON.stringify(id)} must be kebab-case (a-z, 0-9, "-") before code generation`
    );
  }
  return id;
}
