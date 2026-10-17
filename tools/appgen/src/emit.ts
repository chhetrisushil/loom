// ── Escaping for every place appgen interpolates a spec- or model-derived string ──
//
// The ChangeSpec is produced by a MODEL (appgen-model) or by free-form user text
// (parseIntent), so every string in it is untrusted. Generated TypeScript lives in the
// user's project, which makes any unescaped interpolation a code-injection channel
// (a newline ends a `//` comment, `*/` ends a block comment, `"` ends a string literal,
// `${` opens a template substitution; bidi / zero-width / tag characters spoof what a
// reviewer reads). The helpers live in `@loom/scaffold` (the lowest package every
// generator shares, so `loom gen` uses the very same ones) and are re-exported here;
// they are the ONLY sanctioned way to put such text into generated source. Defence is at
// the sink, whatever the validators did.

export {
  blockCommentText,
  commentText,
  hasUnsafeChars,
  markdownText,
  templateLiteralText,
  tsStringLiteral,
} from "@loom/scaffold";

/**
 * The shape of a NEW capability / step id (a created flow or step). Both become generated
 * identifiers (`<camel>Step`, `<Pascal>Flow`) and file-path segments, so the id must start
 * with a letter (`1-run` -> `1RunStep` is not an identifier) and have no trailing/double
 * dash (`a-` and `a--b` collapse onto `a` and `a-b`).
 */
export const NEW_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** The looser shape an EXISTING flow/step id may have (apps predate the strict rule). */
export const EXISTING_ID = /^[a-z0-9][a-z0-9-]*$/;
export const NEW_ID_HINT = "start with a letter, no leading digit, no trailing or double dash";

/**
 * Capability / step ids become identifiers, string literals and file paths. The generator
 * only ever emits code for NEW flows and steps (existing ones are edited in place by path,
 * never re-rendered from their id), so the sink applies the strict new-id rule - the same
 * one the model validator applies to a `create` - and re-checks it because the generator is
 * a public API and the last line of defence. Legacy loose ids are still accepted wherever
 * they are only looked up (the validator and lockfile use {@link EXISTING_ID} for those).
 */
export function assertSafeId(kind: string, id: string): string {
  if (typeof id !== "string" || !NEW_ID.test(id)) {
    throw new Error(
      `appgen: ${kind} id ${JSON.stringify(id)} must be kebab-case (a-z, 0-9, "-"; ${NEW_ID_HINT}) before code generation`
    );
  }
  return id;
}
