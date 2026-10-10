// ── The only way this package builds elements ─────────────────────────────────
//
// Every element the renderer creates goes through `h`. It has no `innerHTML`, no
// `insertAdjacentHTML`, no `outerHTML` and no `document.write` anywhere: a string child is a
// TEXT NODE, so a data string containing `<img onerror=…>` is displayed, never parsed. Tag and
// attribute names are written by renderer authors (code), so an unlisted one THROWS — a bug —
// while attribute VALUES come from data, so the one value that can execute (`href`/`src`) is
// checked and dropped when it is not a safe URL.

/** Tags a renderer may create. No `script`, `iframe`, `object`, `embed`, `style`, `link`, `base`, `meta`. */
const TAGS: ReadonlySet<string> = new Set([
  "div",
  "span",
  "section",
  "h1",
  "h2",
  "h3",
  "p",
  "pre",
  "code",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "button",
  "progress",
  "a",
  "strong",
  "em",
  "small",
  "time",
]);

/** Attributes a renderer may set, beyond `data-*` and `aria-*`. No `on*`, no `style`, no `srcdoc`. */
const ATTRS: ReadonlySet<string> = new Set([
  "class",
  "role",
  "title",
  "type",
  "max",
  "min",
  "value",
  "scope",
  "colspan",
  "rowspan",
  "lang",
  "dir",
  "hidden",
  "disabled",
  "href",
  "rel",
]);

const URL_ATTRS: ReadonlySet<string> = new Set(["href"]);
const SAFE_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto", "tel"]);

/**
 * `url` itself when it is safe to put in an `href`, else `undefined`. Safe is: a relative
 * reference (no scheme) or a scheme in `http`, `https`, `mailto`, `tel`. Whitespace and control
 * characters are stripped before the scheme is read, because a browser ignores them inside it
 * (`java\tscript:`), so `javascript:`, `data:`, `vbscript:` and every disguise of them fail.
 */
export function safeUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const squashed = [...url].filter((ch) => !isInvisible(ch.codePointAt(0) as number)).join("");
  // A browser reads `\` as `/` in a special-scheme URL, so `/\evil.com` is `//evil.com`.
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(squashed);
  if (scheme === null)
    return squashed.replaceAll("\\", "/").startsWith("//") ? undefined : url.trim();
  return SAFE_SCHEMES.has((scheme[1] as string).toLowerCase()) ? url.trim() : undefined;
}

// C0/C1 controls, space and its Unicode lookalikes, zero-width and bidi marks, line/paragraph
// separators, BOM: all ignorable inside a URL scheme by some browser.
const isInvisible = (c: number): boolean =>
  c <= 0x20 ||
  (c >= 0x7f && c <= 0xa0) ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200f) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff;

const isAllowedAttr = (name: string): boolean =>
  ATTRS.has(name) || /^data-[a-z0-9-]+$/.test(name) || /^aria-[a-z]+$/.test(name);

export type Attrs = Record<string, string | number | boolean | undefined>;
export type Child = Node | string | number | undefined | null | false;

/** Create an element. String children are text nodes; unlisted tag/attribute names throw. */
export function h(
  doc: Document,
  tag: string,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElement {
  if (!TAGS.has(tag)) throw new TypeError(`renderer-dom: element "${tag}" is not allowed`);
  const el = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (!isAllowedAttr(name))
      throw new TypeError(`renderer-dom: attribute "${name}" is not allowed`);
    if (URL_ATTRS.has(name)) {
      const safe = safeUrl(String(value));
      if (safe !== undefined) el.setAttribute(name, safe);
      continue;
    }
    el.setAttribute(name, value === true ? "" : String(value));
  }
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue;
    el.append(typeof c === "string" || typeof c === "number" ? doc.createTextNode(String(c)) : c);
  }
  return el;
}

/** A value shown as text: strings as-is, scalars stringified, objects as JSON, null/undefined as `""`. */
export function display(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return "[unserializable]";
    }
  }
  return String(value);
}

/** `value` when it is a short lowercase token (a class/attribute suffix), else `fallback`. Data never authors a style hook. */
export function token(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/i.test(value)
    ? value.toLowerCase()
    : fallback;
}
