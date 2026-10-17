import * as fs from "node:fs";
import { GROUPED_OPTIONS } from "@loom/app";
import { UsageError } from "./args";

/**
 * `loom migrate-config` — rewrite the flat `defineConfig` option spellings (which now throw)
 * into their namespaces. The old→new mapping is `GROUPED_OPTIONS` in `@loom/app`, the same
 * table the flat-key error is built from; there is no second copy here.
 *
 * It is a text-span edit driven by a small tokenizer (strings, templates, comments, regex
 * literals are skipped when matching brackets), not a re-print: everything outside the moved
 * entries is byte-for-byte what the file had, and a moved entry keeps its leading comments.
 * It never executes the config. Whatever it cannot move safely it REFUSES with what to change
 * by hand (a spread, a computed key, a non-literal config or namespace, entries sharing a line).
 */

/** flat option → the group that owns it now. */
const GROUP_OF: ReadonlyMap<string, string> = new Map(
  GROUPED_OPTIONS.flatMap(([group, options]) =>
    (options as readonly string[]).map((o) => [o, group] as const)
  )
);

interface Tok {
  kind: "comment" | "string" | "template" | "regex" | "punct" | "word";
  start: number;
  end: number;
  text: string;
}

const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "delete",
  "void",
  "throw",
  "new",
  "else",
  "do",
  "yield",
  "await",
]);

function regexAllowed(prev: Tok | undefined): boolean {
  if (prev === undefined) return true;
  if (prev.kind === "punct") return ![")", "]", "}"].includes(prev.text);
  if (prev.kind === "word") return REGEX_AFTER_WORD.has(prev.text);
  return false;
}

function skipTemplate(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") i += 2;
    else if (c === "`") return i + 1;
    else if (c === "$" && src[i + 1] === "{") i = scan(src, i + 2, true).end + 1;
    else i++;
  }
  return src.length;
}

/** Tokenize from `from`; when `nested`, stop at the `}` that closes a template substitution. */
function scan(src: string, from: number, nested: boolean): { toks: Tok[]; end: number } {
  const toks: Tok[] = [];
  const push = (kind: Tok["kind"], start: number, end: number) =>
    toks.push({ kind, start, end, text: src.slice(start, end) });
  const lastSig = (): Tok | undefined => {
    for (let k = toks.length - 1; k >= 0; k--) if (toks[k]?.kind !== "comment") return toks[k];
    return undefined;
  };
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      const end = nl < 0 ? src.length : nl;
      push("comment", i, end);
      i = end;
    } else if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close < 0 ? src.length : close + 2;
      push("comment", i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      const end = Math.min(src[j] === c ? j + 1 : j, src.length);
      push("string", i, end);
      i = end;
    } else if (c === "`") {
      const end = skipTemplate(src, i + 1);
      push("template", i, end);
      i = end;
    } else if (c === "/" && regexAllowed(lastSig())) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        const d = src[j];
        if (d === "\\") j++;
        else if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j++;
      }
      j = src[j] === "/" ? j + 1 : j;
      while (j < src.length && /[a-z]/i.test(src[j] as string)) j++;
      push("regex", i, j);
      i = j;
    } else if (/[\w$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j] as string)) j++;
      push("word", i, j);
      i = j;
    } else if (c === "." && src.startsWith("...", i)) {
      push("punct", i, i + 3);
      i += 3;
    } else {
      if (nested && c === "{") depth++;
      if (nested && c === "}") {
        if (depth === 0) return { toks, end: i };
        depth--;
      }
      push("punct", i, i + 1);
      i++;
    }
  }
  return { toks, end: src.length };
}

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

function matchClose(toks: Tok[], open: number): number {
  let depth = 0;
  for (let k = open; k < toks.length; k++) {
    const t = toks[k] as Tok;
    if (t.kind !== "punct") continue;
    if (OPEN.has(t.text)) depth++;
    else if (CLOSE.has(t.text) && --depth === 0) return k;
  }
  return -1;
}

interface Entry {
  /** Index into `toks` of the first / last significant (non-comment) token. */
  first: number;
  last: number;
  /** Index of the separating comma, or -1. */
  comma: number;
  kind: "prop" | "shorthand" | "method" | "spread" | "computed" | "unknown";
  key: string | undefined;
  /** Index of the first value token of a `key: value` entry. */
  valueFirst: number;
}

function parseObject(toks: Tok[], open: number, close: number): Entry[] {
  const entries: Entry[] = [];
  let depth = 0;
  let sig: number[] = [];
  const flush = (comma: number) => {
    if (sig.length > 0) entries.push(classify(toks, sig, comma));
    sig = [];
  };
  for (let k = open + 1; k < close; k++) {
    const t = toks[k] as Tok;
    if (t.kind === "comment") continue;
    if (t.kind === "punct" && OPEN.has(t.text)) depth++;
    else if (t.kind === "punct" && CLOSE.has(t.text)) depth--;
    if (depth === 0 && t.kind === "punct" && t.text === ",") flush(k);
    else sig.push(k);
  }
  flush(-1);
  return entries;
}

function classify(toks: Tok[], sig: number[], comma: number): Entry {
  const at = (p: number) => toks[sig[p] as number];
  const base = {
    first: sig[0] as number,
    last: sig[sig.length - 1] as number,
    comma,
    key: undefined as string | undefined,
    valueFirst: -1,
  };
  if (at(0)?.text === "...") return { ...base, kind: "spread" };
  let p = 0;
  while (
    at(p) !== undefined &&
    (at(p)?.text === "*" ||
      (at(p)?.kind === "word" &&
        ["async", "get", "set"].includes(at(p)?.text as string) &&
        at(p + 1) !== undefined &&
        ![":", "(", ","].includes(at(p + 1)?.text as string)))
  )
    p++;
  const keyTok = at(p);
  if (keyTok === undefined || keyTok.text === "[") return { ...base, kind: "computed" };
  if (keyTok.kind !== "word" && keyTok.kind !== "string") return { ...base, kind: "unknown" };
  const key = keyTok.kind === "string" ? keyTok.text.slice(1, -1) : keyTok.text;
  const next = at(p + 1);
  if (next === undefined) return { ...base, kind: "shorthand", key };
  if (next.text === ":" && sig.length > p + 2)
    return { ...base, kind: "prop", key, valueFirst: sig[p + 2] as number };
  if (next.text === "(") return { ...base, kind: "method", key };
  return { ...base, kind: "unknown", key };
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

export interface FileAnalysis {
  /** Flat keys moved, in source order. */
  moved: { key: string; group: string }[];
  /** Keys that already exist in their namespace — nothing is written while any exist. */
  conflicts: string[];
  /** Why the file cannot be rewritten safely, with what to change by hand. */
  refusal: string | undefined;
  /** The rewritten source (equal to the input when there is nothing to do). */
  text: string;
}

const MAPPING_HINT = `the groups (${GROUPED_OPTIONS.map(([g]) => g).join(", ")}; see docs/usage-cli.md, loom migrate-config)`;

function refuse(text: string, why: string): FileAnalysis {
  return { moved: [], conflicts: [], refusal: why, text };
}

const sameLine = (src: string, a: number, b: number) => !src.slice(a, b).includes("\n");
const lineStart = (src: string, pos: number) => src.lastIndexOf("\n", pos - 1) + 1;
const lineEnd = (src: string, pos: number) => {
  const nl = src.indexOf("\n", pos);
  return nl < 0 ? src.length : nl;
};
const isBlank = (s: string) => /^\s*$/.test(s);
const leadingWs = (s: string) => /^[ \t]*/.exec(s)?.[0] ?? "";
const indentOf = (src: string, pos: number) => leadingWs(src.slice(lineStart(src, pos)));

/** The extents of an entry inside a multi-line object. */
interface Extent {
  /** Start of the entry's first line (leading comments included). */
  from: number;
  /** End of the entry's text including its comma and same-line trailing comments. */
  to: number;
  /** Source of the entry up to its last token, and the comments after its comma. */
  head: string;
  tail: string;
  ownLines: boolean;
  hasLineComment: boolean;
}

function extentOf(src: string, toks: Tok[], e: Entry): Extent {
  let lead = (toks[e.first] as Tok).start;
  let hasLineComment = false;
  for (let j = e.first - 1; j >= 0 && toks[j]?.kind === "comment"; j--) {
    const c = toks[j] as Tok;
    const prev = toks[j - 1];
    if ((src.slice(c.end, lead).match(/\n/g) ?? []).length > 1) break;
    if (prev !== undefined && sameLine(src, prev.end, c.start)) break;
    lead = c.start;
    if (c.text.startsWith("//")) hasLineComment = true;
  }
  const lastTok = toks[e.last] as Tok;
  let to = e.comma >= 0 ? (toks[e.comma] as Tok).end : lastTok.end;
  const afterComma = to;
  const after = e.comma >= 0 ? e.comma : e.last;
  for (
    let j = after + 1;
    toks[j]?.kind === "comment" && sameLine(src, to, (toks[j] as Tok).start);
    j++
  ) {
    to = (toks[j] as Tok).end;
    if ((toks[j] as Tok).text.startsWith("//")) hasLineComment = true;
  }
  const from = lineStart(src, lead);
  const ownLines = isBlank(src.slice(from, lead)) && isBlank(src.slice(to, lineEnd(src, to)));
  const begin = ownLines ? from : lead;
  return {
    from: begin,
    to,
    head: src.slice(begin, lastTok.end),
    tail: src.slice(afterComma, to),
    ownLines,
    hasLineComment,
  };
}

function reindent(text: string, from: string, to: string): string {
  return text
    .split("\n")
    .map((l) => (l.startsWith(from) ? to + l.slice(from.length) : l))
    .join("\n");
}

/**
 * Plan every `defineConfig({...})` rewrite in `src`. Pure: no I/O. The caller re-analyzes the
 * result and requires a fixed point before anything is written.
 */
export function analyzeConfig(src: string): FileAnalysis {
  if (!src.includes("@loom/app")) {
    return refuse(src, "no import of `@loom/app` — this does not look like a loom config");
  }
  const { toks } = scan(src, 0, false);
  const edits: Edit[] = [];
  const moved: FileAnalysis["moved"] = [];
  const conflicts: string[] = [];
  let calls = 0;

  for (let k = 0; k < toks.length; k++) {
    const t = toks[k] as Tok;
    if (t.kind !== "word" || t.text !== "defineConfig") continue;
    let open = k + 1;
    while (toks[open]?.kind === "comment") open++;
    let p = k - 1;
    while (p >= 0 && toks[p]?.kind === "comment") p--;
    if (toks[open]?.text !== "(" || toks[p]?.text === "function") continue;
    calls++;
    let arg = open + 1;
    while (toks[arg]?.kind === "comment") arg++;
    const closeIdx = toks[arg]?.text === "{" ? matchClose(toks, arg) : -1;
    if (closeIdx < 0) {
      return refuse(
        src,
        `defineConfig(...) is not given an object literal (${toks[arg]?.text ?? "nothing"}); move any flat options into ${MAPPING_HINT} by hand`
      );
    }
    const r = planCall(src, toks, arg, closeIdx, edits, moved, conflicts);
    if (r !== undefined) return refuse(src, r);
    k = closeIdx;
  }
  if (calls === 0) return refuse(src, "no `defineConfig({...})` call found");
  if (conflicts.length > 0) return { moved: [], conflicts, refusal: undefined, text: src };
  edits.sort((a, b) => b.start - a.start || b.end - b.start - (a.end - a.start));
  let text = src;
  for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  return { moved, conflicts, refusal: undefined, text };
}

interface Target {
  open: number;
  close: number;
  entries: Entry[];
}

function planCall(
  src: string,
  toks: Tok[],
  open: number,
  close: number,
  edits: Edit[],
  moved: FileAnalysis["moved"],
  conflicts: string[]
): string | undefined {
  const entries = parseObject(toks, open, close);
  for (const e of entries) {
    const at = (toks[e.first] as Tok).start;
    if (e.kind === "spread") {
      const shown = src.slice(at, (toks[e.last] as Tok).end).slice(0, 40);
      return `the defineConfig object spreads \`${shown}\`, which may carry flat keys this tool cannot see; list the options directly (or move the flat keys into ${MAPPING_HINT}) and re-run`;
    }
    if (e.kind === "computed" || e.kind === "unknown") {
      return `the defineConfig object has an entry this tool cannot read at offset ${at} (${e.kind === "computed" ? "a computed key" : "an unrecognised form"}); change it to a plain \`key: value\` by hand and re-run`;
    }
  }
  const flat = entries.filter((e) => e.key !== undefined && GROUP_OF.has(e.key));
  if (flat.length === 0) return undefined;

  const byGroup = new Map<string, Entry[]>();
  for (const e of flat) {
    const g = GROUP_OF.get(e.key as string) as string;
    byGroup.set(g, [...(byGroup.get(g) ?? []), e]);
  }

  const inline = sameLine(src, (toks[open] as Tok).start, (toks[close] as Tok).start);
  if (inline && toks.slice(open, close).some((x) => x.kind === "comment")) {
    return "the defineConfig object is on one line and contains comments; put each option on its own line and re-run";
  }

  const targets = new Map<string, Target>();
  for (const [group, list] of byGroup) {
    const ns = entries.find((e) => e.key === group);
    if (ns === undefined) continue;
    const valueOk =
      ns.kind === "prop" &&
      toks[ns.valueFirst]?.text === "{" &&
      matchClose(toks, ns.valueFirst) === ns.last;
    if (!valueOk) {
      return `\`${group}\` is not an object literal, so \`${list.map((e) => e.key).join(", ")}\` cannot be merged into it; move ${list.length === 1 ? "that key" : "those keys"} into it by hand`;
    }
    targets.set(group, {
      open: ns.valueFirst,
      close: ns.last,
      entries: parseObject(toks, ns.valueFirst, ns.last),
    });
  }
  for (const [group, list] of byGroup) {
    for (const e of list) {
      if (targets.get(group)?.entries.some((x) => x.key === e.key))
        conflicts.push(`\`${e.key}\` is set both flat and in \`${group}\`; keep one and re-run`);
    }
  }
  if (conflicts.length > 0) return undefined;

  const text = (e: Entry) => src.slice((toks[e.first] as Tok).start, (toks[e.last] as Tok).end);
  for (const e of flat) {
    moved.push({ key: e.key as string, group: GROUP_OF.get(e.key as string) as string });
  }

  if (inline) {
    // Rebuild the one-line object (no comments in it, checked above).
    const parts: string[] = [];
    const placed = new Set<string>();
    for (const e of entries) {
      const g = e.key !== undefined ? GROUP_OF.get(e.key) : undefined;
      if (g !== undefined) {
        if (!targets.has(g) && !placed.has(g)) {
          placed.add(g);
          parts.push(`${g}: { ${(byGroup.get(g) ?? []).map(text).join(", ")} }`);
        }
        continue;
      }
      const tgt = e.key !== undefined ? targets.get(e.key) : undefined;
      if (tgt === undefined) {
        parts.push(text(e));
        continue;
      }
      if (!sameLine(src, (toks[tgt.open] as Tok).start, (toks[tgt.close] as Tok).start))
        return `\`${e.key}\` spans several lines inside a one-line config; put each option on its own line and re-run`;
      if (toks.slice(tgt.open, tgt.close).some((x) => x.kind === "comment"))
        return `\`${e.key}\` contains comments inside a one-line config; put each option on its own line and re-run`;
      const inner = [...tgt.entries.map(text), ...(byGroup.get(e.key as string) ?? []).map(text)];
      parts.push(`${e.key}: { ${inner.join(", ")} }`);
    }
    edits.push({
      start: (toks[open] as Tok).start,
      end: (toks[close] as Tok).end,
      text: `{ ${parts.join(", ")} }`,
    });
    return undefined;
  }

  // Multi-line config: line-based edits.
  const extents = new Map<Entry, Extent>();
  for (const e of flat) {
    const x = extentOf(src, toks, e);
    if (!x.ownLines)
      return `\`${e.key}\` shares a line with another entry; put each option on its own line (a formatter does this) and re-run`;
    extents.set(e, x);
  }
  const confIndent = indentOf(src, (toks[(entries[0] as Entry).first] as Tok).start);
  const headerIndent = indentOf(src, (toks[open] as Tok).start);
  const unit =
    confIndent.startsWith(headerIndent) && confIndent.length > headerIndent.length
      ? confIndent.slice(headerIndent.length)
      : "  ";
  const rendered = (e: Entry, toIndent: string): string => {
    const x = extents.get(e) as Extent;
    return `${reindent(x.head, leadingWs(x.head), toIndent)},${x.tail}`;
  };
  for (const e of flat) {
    const x = extents.get(e) as Extent;
    edits.push({ start: x.from, end: Math.min(lineEnd(src, x.to) + 1, src.length), text: "" });
  }
  for (const [group, list] of byGroup) {
    const t = targets.get(group);
    if (t === undefined) {
      const first = extents.get(list[0] as Entry) as Extent;
      const fromIndent = leadingWs(first.head);
      const body = list.map((e) => rendered(e, fromIndent + unit)).join("\n");
      edits.push({
        start: first.from,
        end: first.from,
        text: `${fromIndent}${group}: {\n${body}\n${fromIndent}},\n`,
      });
      continue;
    }
    const tOpen = toks[t.open] as Tok;
    const tClose = toks[t.close] as Tok;
    const lastE = t.entries[t.entries.length - 1];
    if (sameLine(src, tOpen.start, tClose.start)) {
      if (toks.slice(t.open, t.close).some((x) => x.kind === "comment"))
        return `\`${group}\` is a one-line object with comments; put its options on their own lines and re-run`;
      if (list.some((e) => (extents.get(e) as Extent).hasLineComment))
        return `\`${group}\` is a one-line object and a moved option carries a // comment; put the options on their own lines and re-run`;
      const joined = list.map(text).join(", ");
      if (lastE === undefined)
        edits.push({ start: tOpen.end, end: tOpen.end, text: ` ${joined} ` });
      else {
        const at = (toks[lastE.last] as Tok).end;
        edits.push({ start: at, end: at, text: `, ${joined}` });
      }
      continue;
    }
    if (!isBlank(src.slice(lineStart(src, tClose.start), tClose.start)))
      return `\`${group}\` closes on the same line as its last option; put \`}\` on its own line and re-run`;
    const closeIndent = indentOf(src, tClose.start);
    const innerIndent =
      lastE !== undefined ? indentOf(src, (toks[lastE.first] as Tok).start) : closeIndent + unit;
    if (lastE !== undefined && lastE.comma < 0) {
      const at = (toks[lastE.last] as Tok).end;
      edits.push({ start: at, end: at, text: "," });
    }
    const at = lineStart(src, tClose.start);
    edits.push({
      start: at,
      end: at,
      text: `${list.map((e) => rendered(e, innerIndent)).join("\n")}\n`,
    });
  }
  return undefined;
}

// ── Diff ─────────────────────────────────────────────────────────────────────

/** A unified diff (3 lines of context) of `a` → `b`; empty when they are equal. */
export function unifiedDiff(a: string, b: string, label: string): string {
  if (a === b) return "";
  const x = a.split("\n");
  const y = b.split("\n");
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (
    suf < x.length - pre &&
    suf < y.length - pre &&
    x[x.length - 1 - suf] === y[y.length - 1 - suf]
  )
    suf++;
  const xm = x.slice(pre, x.length - suf);
  const ym = y.slice(pre, y.length - suf);
  type Op = [" " | "-" | "+", string];
  const ops: Op[] = x.slice(0, pre).map((l): Op => [" ", l]);
  if (xm.length * ym.length > 4_000_000) {
    ops.push(...xm.map((l): Op => ["-", l]), ...ym.map((l): Op => ["+", l]));
  } else {
    // LCS over the differing middle (a config is small; a huge middle falls back above).
    const n = xm.length;
    const m = ym.length;
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * w + j] =
          xm[i] === ym[j]
            ? (dp[(i + 1) * w + j + 1] as number) + 1
            : Math.max(dp[(i + 1) * w + j] as number, dp[i * w + j + 1] as number);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (xm[i] === ym[j]) {
        ops.push([" ", xm[i] as string]);
        i++;
        j++;
      } else if ((dp[(i + 1) * w + j] as number) >= (dp[i * w + j + 1] as number)) {
        ops.push(["-", xm[i++] as string]);
      } else ops.push(["+", ym[j++] as string]);
    }
    while (i < n) ops.push(["-", xm[i++] as string]);
    while (j < m) ops.push(["+", ym[j++] as string]);
  }
  ops.push(...x.slice(x.length - suf).map((l): Op => [" ", l]));

  const CTX = 3;
  const changed = ops.flatMap((o, i) => (o[0] === " " ? [] : [i]));
  const lines = [`--- a/${label}`, `+++ b/${label}`];
  let h = 0;
  while (h < changed.length) {
    let endC = h;
    while (
      endC + 1 < changed.length &&
      (changed[endC + 1] as number) - (changed[endC] as number) <= 2 * CTX
    )
      endC++;
    const from = Math.max(0, (changed[h] as number) - CTX);
    const to = Math.min(ops.length, (changed[endC] as number) + CTX + 1);
    const slice = ops.slice(from, to);
    const before = ops.slice(0, from);
    const oldStart = before.filter((o) => o[0] !== "+").length + 1;
    const newStart = before.filter((o) => o[0] !== "-").length + 1;
    const oldLen = slice.filter((o) => o[0] !== "+").length;
    const newLen = slice.filter((o) => o[0] !== "-").length;
    lines.push(`@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`);
    for (const [k, l] of slice) lines.push(k + l);
    h = endC + 1;
  }
  return lines.join("\n");
}

// ── Command ──────────────────────────────────────────────────────────────────

export interface MigrateFileResult {
  path: string;
  changed: boolean;
  moved: { key: string; group: string }[];
  conflicts: string[];
  refusal: string | null;
  diff: string;
}

export interface MigrateResult {
  apply: boolean;
  files: MigrateFileResult[];
  /** True when a file was refused or has a conflict (exit 2). */
  refused: boolean;
}

/** Plan (and with `apply`, write) the migration of each file. */
export function cmdMigrateConfig(opts: {
  files: readonly string[];
  apply: boolean;
}): MigrateResult {
  const files: MigrateFileResult[] = [];
  for (const path of opts.files) {
    let src: string;
    try {
      src = fs.readFileSync(path, "utf8");
    } catch (e) {
      throw new UsageError(`cannot read ${path}: ${(e as Error).message}`);
    }
    const a = analyzeConfig(src);
    let refusal = a.refusal ?? null;
    if (refusal === null && a.conflicts.length === 0 && a.text !== src) {
      // The rewrite must itself be clean: nothing left to move, nothing refused.
      const again = analyzeConfig(a.text);
      if (again.refusal !== undefined || again.moved.length > 0 || again.text !== a.text) {
        refusal = `internal check failed: the rewritten file would still not be clean (${again.refusal ?? "flat keys remain"}); no change made — migrate this config by hand`;
      }
    }
    const changed = refusal === null && a.conflicts.length === 0 && a.text !== src;
    if (changed && opts.apply) fs.writeFileSync(path, a.text);
    files.push({
      path,
      changed,
      moved: refusal === null ? a.moved : [],
      conflicts: a.conflicts,
      refusal,
      diff: changed ? unifiedDiff(src, a.text, path) : "",
    });
  }
  return {
    apply: opts.apply,
    files,
    refused: files.some((f) => f.refusal !== null || f.conflicts.length > 0),
  };
}

/** The text report for {@link cmdMigrateConfig}. */
export function formatMigrate(r: MigrateResult): string {
  const out: string[] = [];
  for (const f of r.files) {
    if (f.changed) {
      out.push(f.diff);
      out.push(
        `${r.apply ? "migrated" : "would migrate"} ${f.path}: ${f.moved.map((m) => `${m.key} -> ${m.group}.${m.key}`).join(", ")}`
      );
    } else if (f.refusal === null && f.conflicts.length === 0) {
      out.push(`${f.path}: nothing to migrate`);
    }
    for (const c of f.conflicts) out.push(`${f.path}: conflict: ${c}`);
    if (f.refusal !== null) out.push(`${f.path}: refused: ${f.refusal}`);
  }
  const n = r.files.filter((f) => f.changed).length;
  if (!r.apply && n > 0)
    out.push(`dry run: ${n} file(s) would change; re-run with --apply to write`);
  return out.join("\n");
}
