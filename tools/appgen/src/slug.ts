import { fnv1a32 } from "./hash";

/**
 * Turn a free-form phrase into a NEW id: always matches `NEW_ID`
 * (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), never empty. Deterministic, no model.
 *
 * Rule: lowercase; every run of characters outside `a-z0-9` becomes ONE dash; leading and
 * trailing dashes are dropped (so no double or trailing dash). Then
 *   - a result that starts with a digit gets the word `item-` in front
 *     ("2fa login" -> `item-2fa-login`, "123" -> `item-123`);
 *   - input with NO ascii letter or digit at all (punctuation, unicode-only) becomes
 *     `capability-<8 hex>`, the hex being a hash of the NFC-normalised original text, so two different
 *     such inputs do not collapse onto one id. Blank input stays `app`.
 * Ids that were already valid are returned unchanged, so nothing that worked before moves.
 */
export function newIdSlug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s === "") {
    if (text.trim() === "") return "app";
    return `capability-${fnv1a32(text.normalize("NFC")).toString(16).padStart(8, "0")}`;
  }
  return /^[0-9]/.test(s) ? `item-${s}` : s;
}

/**
 * The legacy slug (digit-leading ids allowed, `app` when empty): used only to LOOK UP an
 * id that may already exist in a scanned app, where the loose `EXISTING_ID` shape applies.
 */
export function existingIdSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}
