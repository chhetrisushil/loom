import * as fs from "node:fs";
import * as path from "node:path";
import { listSeams, pluginFiles } from "@loom/scaffold";
import { KERNEL_PACKAGES, SPI_PACKAGES } from "@loom/spec";
import { safeWriteFile } from "./safeWrite";

/**
 * `loom plugin new <seam> <name> [--first-party] [--dir .]` — scaffold a plugin
 * package for a seam. Writes a package.json, tsconfig, a preset/SPI stub, a
 * conformance-wired test, and a README. Never overwrites an existing file.
 */
export function cmdPluginNew(
  seam: string,
  name: string,
  opts: { firstParty: boolean; dir: string }
): { dir: string; written: string[]; skipped: string[] } {
  const files = pluginFiles(seam, name, { firstParty: opts.firstParty });
  const written: string[] = [];
  const skipped: string[] = [];
  let root = "";
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(opts.dir, rel);
    if (root === "")
      root = path.join(
        opts.dir,
        rel
          .split("/")
          .slice(0, opts.firstParty ? 2 : 1)
          .join("/")
      );
    if (fs.existsSync(dest)) {
      skipped.push(dest);
      continue;
    }
    safeWriteFile(opts.dir, dest, content);
    written.push(dest);
  }
  return { dir: root, written, skipped };
}

/** `loom plugin seams` — list the seams a plugin can target. */
export function cmdPluginSeams(): string {
  return listSeams();
}

export interface PluginFinding {
  level: "ok" | "warn" | "error";
  message: string;
}

interface PluginManifest {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  repository?: unknown;
  keywords?: string[];
  main?: string;
  types?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** The replay fold engine — a plugin depending on it can extend the fold (forbidden). */
const FOLD_ENGINE = "@loom/replay-vm";
/** @loom/* SPI + kernel packages a third-party plugin should peer-depend on, not bundle. */
const SPI_KERNEL = new Set<string>([...KERNEL_PACKAGES, ...SPI_PACKAGES]);

interface Tok {
  /** `id` identifier / keyword / number, `str` a string or template (value = a plain string's text), `p` one punctuation char. */
  k: "id" | "str" | "p";
  v: string;
}

/** After one of these a `/` starts a regex literal (an expression position); after a value it divides. */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "void",
  "delete",
  "throw",
  "new",
  "await",
  "yield",
]);

const isIdChar = (c: string): boolean => /[\w$]/.test(c) || c > "\u007f";

/** Keywords after which a touching quote opens a string (`from"x"`), not a JSX apostrophe. */
const STRING_AFTER_WORD = new Set([
  ...REGEX_AFTER_WORD,
  "from",
  "import",
  "export",
  "default",
  "require",
]);

/** Is the identifier run ending just before `quote` a keyword that takes a string next? */
function followsKeyword(src: string, quote: number): boolean {
  let j = quote;
  while (j > 0 && isIdChar(src[j - 1] as string)) j--;
  return STRING_AFTER_WORD.has(src.slice(j, quote));
}

/**
 * Do the tokens so far end inside an opening JSX tag (`<div className="x"` just before its `>`)?
 * Walks back (bounded, stopping at `;`) to a `<` that starts an expression, i.e. is not a
 * comparison or the generic of `f<T>`, and is followed by a tag name or `>` (a fragment).
 */
function inJsxTag(toks: Tok[]): boolean {
  for (let k = toks.length - 1, steps = 0; k >= 0 && steps < 64; k--, steps++) {
    const t = toks[k] as Tok;
    if (t.k === "p" && t.v === ";") return false;
    if (t.k !== "p" || t.v !== "<") continue;
    const before = toks[k - 1];
    const after = toks[k + 1];
    const exprStart =
      before === undefined ||
      (before.k === "p"
        ? before.v !== ")" && before.v !== "]"
        : before.k === "id" && REGEX_AFTER_WORD.has(before.v));
    if (exprStart && (after?.k === "id" || (after?.k === "p" && after.v === ">"))) return true;
  }
  return false;
}

/**
 * A small LINEAR tokenizer, not a parser: identifiers, strings (text kept), single punctuation
 * characters. Comments, regex literals and template text are dropped, but a template's `${ … }`
 * body is scanned as code (so a call inside it still counts) and a regex containing a quote or a
 * backtick cannot open a phantom string. With `jsx` (a `.tsx` / `.jsx` file) the heuristic also
 * knows that `/>` and `</` are tag punctuation, not a regex start, and that an apostrophe inside
 * a word (`it's`), an unterminated quote, or a backtick straight after `>` is JSX text, not the
 * opening of a string or template that would swallow the rest of the line (or file).
 */
function tokenize(src: string, jsx = false): Tok[] {
  const toks: Tok[] = [];
  const n = src.length;
  let i = 0;
  let depth = 0; // `{` nesting, for matching the `}` that closes a template's `${`
  const tmpl: number[] = []; // depths at which a `${` is open

  const regexAllowed = (): boolean => {
    const t = toks[toks.length - 1];
    if (t === undefined) return true;
    if (t.k === "str") return false;
    if (t.k === "id") return REGEX_AFTER_WORD.has(t.v);
    return t.v !== ")" && t.v !== "]";
  };

  /** From inside a template, consume text up to the closing backtick or an opening `${`. */
  const templateText = (): void => {
    while (i < n) {
      const c = src[i] as string;
      if (c === "\\") i += 2;
      else if (c === "`") {
        i++;
        toks.push({ k: "str", v: "" });
        return;
      } else if (c === "$" && src[i + 1] === "{") {
        i += 2;
        tmpl.push(depth++);
        toks.push({ k: "p", v: "{" });
        return;
      } else i++;
    }
  };

  while (i < n) {
    const c = src[i] as string;
    const nx = src[i + 1];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (c === "/" && nx === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && nx === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
    } else if (
      jsx &&
      (c === '"' || c === "'") &&
      i > 0 &&
      isIdChar(src[i - 1] as string) &&
      !followsKeyword(src, i)
    ) {
      // `it's` in JSX text: an apostrophe, never a string opener (valid code has no `a'b'`) —
      // except right after a keyword (`from"@loom/conformance"`, `case"a"`), which IS code.
      i++;
    } else if (jsx && c === "`" && src[i - 1] === ">" && src[i - 2] !== "=" && inJsxTag(toks)) {
      i++; // a backtick opening JSX text (not `=>` + template, nor `a>` + template)
    } else if (c === '"' || c === "'") {
      let v = "";
      const open = i;
      i++;
      while (i < n && src[i] !== c) {
        const ch = src[i] as string;
        if (ch === "\\" && i + 1 < n) {
          v += src[i + 1];
          i += 2;
          continue;
        }
        if (ch === "\n") break; // unterminated: resync at the line end
        v += ch;
        i++;
      }
      if (jsx && !(i < n && src[i] === c)) {
        i = open + 1; // unterminated on its line: JSX text, so resume right after the quote
        continue;
      }
      if (i < n && src[i] === c) i++;
      toks.push({ k: "str", v });
    } else if (c === "`") {
      i++;
      templateText();
    } else if (
      c === "/" &&
      regexAllowed() &&
      !(jsx && (nx === ">" || toks[toks.length - 1]?.v === "<"))
    ) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        const ch = src[j] as string;
        if (ch === "\\") j++;
        else if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        j++;
      }
      if (j < n && src[j] === "/") {
        i = j + 1;
        toks.push({ k: "str", v: "" }); // a value: what follows is a division / flags
      } else {
        toks.push({ k: "p", v: "/" }); // not a regex after all
        i++;
      }
    } else if (isIdChar(c)) {
      let j = i + 1;
      while (j < n && isIdChar(src[j] as string)) j++;
      toks.push({ k: "id", v: src.slice(i, j) });
      i = j;
    } else {
      i++;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (tmpl.length > 0 && tmpl[tmpl.length - 1] === depth) {
          tmpl.pop();
          templateText();
          continue;
        }
      }
      toks.push({ k: "p", v: c });
    }
  }
  return toks;
}

/**
 * The most tokens a destructuring pattern is walked back over to find its `{`. The walk also stops
 * at a statement boundary and at the previous `require` / `import` (a pattern holds neither), so a
 * run of unmatched `}` costs a few tokens each, not the cap; the cap is only the backstop. 20k
 * covers a pattern of thousands of renamed names (4 tokens each); a longer one is not recognised.
 */
const WALK_CAP = 20_000;

const isKit = (spec: string): boolean =>
  spec === "@loom/conformance" || spec.startsWith("@loom/conformance/");
const RUN_CONFORMANCE = /^run\w*Conformance$/;

/**
 * The bindings a source takes from `@loom/conformance` (or a subpath): `callable` names that count
 * when called, `ns` names whose `run*Conformance` member counts. Real (non-type) imports,
 * `import * as ns`, default imports, `require(...)` and dynamic `import(...)` only.
 */
function kitBindings(toks: Tok[]): { callable: Set<string>; ns: Set<string>; inline: boolean } {
  const callable = new Set<string>();
  const ns = new Set<string>();
  let inline = false; // `(await import("@loom/conformance")).runX(` / `require(...).runX(`
  const at = (j: number): Tok | undefined => toks[j];
  const isP = (j: number, v: string): boolean => at(j)?.k === "p" && at(j)?.v === v;

  /** The names bound by `const|let|var <target> = [await] <call at j>`. */
  const declaredBy = (j: number): void => {
    let m = j - 1;
    if (at(m)?.k === "id" && at(m)?.v === "await") m--;
    if (!isP(m, "=")) return;
    m--;
    const t = at(m);
    if (t?.k === "id") {
      ns.add(t.v);
      return;
    }
    if (isP(m, "}")) {
      // `{ a, b: c }` — walk back to the matching `{`, binding the local name of each element.
      // Bounded: stop at a statement boundary (`;` or a declaration keyword, which a pattern
      // cannot contain) or after WALK_CAP tokens, so a run of unmatched `}` cannot make this
      // quadratic. A pattern longer than the cap is not recognised (a false negative).
      let d = 0;
      const end = m;
      const stop = Math.max(-1, m - WALK_CAP);
      for (; m > stop; m--) {
        const w = at(m) as Tok;
        if (w.k === "p" && w.v === "}") d++;
        else if (w.k === "p" && w.v === "{" && --d === 0) break;
        else if (w.k === "p" && w.v === ";") {
          m = -1;
          break;
        } else if (
          w.k === "id" &&
          (w.v === "const" ||
            w.v === "let" ||
            w.v === "var" ||
            w.v === "require" ||
            w.v === "import")
        ) {
          m = -1;
          break;
        }
      }
      if (m <= stop || !isP(m, "{")) return;
      const els: Tok[][] = [[]];
      for (let q = m + 1; q < end; q++) {
        const e = at(q) as Tok;
        if (e.k === "p" && e.v === ",") els.push([]);
        else els[els.length - 1]?.push(e);
      }
      for (const el of els) {
        const names = el.filter((e) => e.k === "id");
        const colon = el.findIndex((e) => e.k === "p" && e.v === ":");
        const local = colon === -1 ? names[0] : el.slice(colon).find((e) => e.k === "id");
        if (local !== undefined) callable.add(local.v);
      }
    }
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok;
    if (t.k !== "id") continue;
    if ((t.v === "require" || t.v === "import") && isP(i + 1, "(")) {
      const spec = at(i + 2);
      if (spec?.k === "str" && isKit(spec.v) && isP(i + 3, ")")) {
        declaredBy(i);
        let j = i + 4;
        if (isP(j, ")")) j++; // `(await import(...))`
        const m = isP(j, ".") ? at(j + 1) : undefined;
        if (m?.k === "id" && RUN_CONFORMANCE.test(m.v) && isP(j + 2, "(")) inline = true;
      }
      continue;
    }
    if (t.v !== "import") continue;
    let j = i + 1;
    if (at(j)?.k === "str") continue; // side-effect import: binds nothing
    if (at(j)?.v === "type") {
      const after = at(j + 1);
      if (
        after !== undefined &&
        (after.v === "{" || after.v === "*" || (after.k === "id" && after.v !== "from"))
      )
        continue; // `import type …`
    }
    // Clause: only identifiers, `,` `{` `}` `*` until `from "<spec>"`; anything else is not an import.
    const clause: Tok[] = [];
    for (; j < toks.length; j++) {
      const c = toks[j] as Tok;
      if (c.k === "id" && c.v === "from" && at(j + 1)?.k === "str") break;
      if (c.k === "id" && c.v === "import") break;
      if (c.k === "p" && !"{},*".includes(c.v)) break;
      if (c.k === "str") break;
      clause.push(c);
    }
    const spec = at(j + 1);
    if (!(at(j)?.v === "from" && spec?.k === "str" && isKit(spec.v))) continue;
    // Split `default, * as ns, { a, b as c, type D }`.
    let braces = false;
    for (let q = 0; q < clause.length; q++) {
      const c = clause[q] as Tok;
      if (c.k === "p") {
        if (c.v === "{") braces = true;
        else if (c.v === "}") braces = false;
        continue;
      }
      if (c.v === "type" && braces && clause[q + 1]?.k === "id" && clause[q + 1]?.v !== "as") {
        q++; // an inline type specifier binds nothing at runtime
        if (clause[q + 1]?.v === "as") q += 2;
        continue;
      }
      if (c.v === "as") continue;
      const next = clause[q + 1];
      if (next?.k === "id" && next.v === "as") {
        // `a as b` binds b; `* as ns` is a namespace.
        const local = clause[q + 2];
        if (local !== undefined && local.k === "id") (c.v === "*" ? ns : callable).add(local.v);
        q += 2;
        continue;
      }
      if (!braces) {
        ns.add(c.v); // default import
        callable.add(c.v);
      } else callable.add(c.v);
    }
    // `* as ns`: the `*` is punct and was skipped above, so bind its alias here.
    for (let q = 0; q + 2 < clause.length; q++)
      if (clause[q]?.v === "*" && clause[q + 1]?.v === "as" && clause[q + 2]?.k === "id")
        ns.add((clause[q + 2] as Tok).v);
  }
  return { callable, ns, inline };
}

/**
 * True when a test source really takes something from `@loom/conformance` (a real, non-type
 * import / require / dynamic import, any alias or subpath) and really CALLS it — directly, or as
 * `ns.run*Conformance(`. Comments, string contents and regex literals are not code; a template's
 * `${ … }` is. An unrelated `obj.runFooConformance()` or a local `function runX()` does not count.
 */
export function wiresConformance(source: string, opts: { jsx?: boolean } = {}): boolean {
  const toks = tokenize(source, opts.jsx === true);
  const { callable, ns, inline } = kitBindings(toks);
  if (inline) return true;
  if (callable.size === 0 && ns.size === 0) return false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Tok;
    if (t.k !== "id") continue;
    const prev = toks[i - 1];
    const dotted = prev?.k === "p" && prev.v === ".";
    if (
      callable.has(t.v) &&
      !dotted &&
      !(prev?.k === "id" && (prev.v === "function" || prev.v === "new"))
    ) {
      if (toks[i + 1]?.k === "p" && toks[i + 1]?.v === "(") return true;
    }
    if (ns.has(t.v) && !dotted) {
      let j = i + 1;
      if (toks[j]?.v === "?") j++;
      const m = toks[j + 1];
      if (
        toks[j]?.v === "." &&
        m?.k === "id" &&
        RUN_CONFORMANCE.test(m.v) &&
        toks[j + 2]?.v === "("
      )
        return true;
    }
  }
  return false;
}

/** A test file's text; `jsx` marks a `.tsx` / `.jsx` file (see {@link wiresConformance}). */
export interface TestSource {
  source: string;
  jsx?: boolean;
}

/**
 * Static contract check for a plugin (ADR 0043 / docs/plugins.md). Pure over the
 * manifest + the text of its test files, so it is unit-testable without disk.
 */
export function checkPlugin(
  pkg: PluginManifest,
  testSources: readonly (string | TestSource)[],
  opts: { publish?: boolean } = {}
): PluginFinding[] {
  const findings: PluginFinding[] = [];
  const name = pkg.name ?? "";
  const firstParty = name.startsWith("@loom/plugin-");
  const thirdParty = /^loom-plugin-/.test(name) || /^@[^/]+\/loom-plugin-/.test(name);

  // Naming convention.
  if (firstParty || thirdParty) {
    findings.push({
      level: "ok",
      message: `name "${name}" follows the ${firstParty ? "first" : "third"}-party convention`,
    });
  } else {
    findings.push({
      level: "warn",
      message: `name "${name}" is neither @loom/plugin-* (1P) nor loom-plugin-* (3P)`,
    });
  }

  // Fold isolation — the load-bearing contract rule: no reducer into the replay fold.
  const runtimeDeps = { ...pkg.dependencies, ...pkg.peerDependencies };
  if (FOLD_ENGINE in runtimeDeps) {
    findings.push({
      level: "error",
      message: `depends on ${FOLD_ENGINE} — plugins must not extend the replay fold; emit app events and fold them in a projection instead (ADR 0043)`,
    });
  } else {
    findings.push({ level: "ok", message: "does not depend on the replay fold engine" });
  }

  // Third-party specifics: discovery keyword + SPI packages as peers (one kernel copy).
  if (thirdParty) {
    if ((pkg.keywords ?? []).includes("loom-plugin")) {
      findings.push({ level: "ok", message: 'has the "loom-plugin" keyword' });
    } else {
      findings.push({
        level: "warn",
        message: 'missing the "loom-plugin" npm keyword (discovery)',
      });
    }
    const spiInDeps = Object.keys(pkg.dependencies ?? {}).filter((d) => SPI_KERNEL.has(d));
    if (spiInDeps.length > 0) {
      findings.push({
        level: "warn",
        message: `SPI package(s) in dependencies (${spiInDeps.join(", ")}) — a 3P plugin should peer-depend on @loom/* SPI so the app supplies one kernel copy`,
      });
    } else {
      findings.push({
        level: "ok",
        message: "SPI packages are peer dependencies (no duplicate kernel)",
      });
    }
  }

  // Conformance wiring — is any SPI impl proven with the published kit?
  // A real import AND a real `run*Conformance(` call: a comment or string that merely
  // mentions either (the scaffold ships the call commented out) proves nothing.
  if (
    testSources.some((t) =>
      typeof t === "string"
        ? wiresConformance(t)
        : wiresConformance(t.source, { jsx: t.jsx === true })
    )
  ) {
    findings.push({ level: "ok", message: "a test wires @loom/conformance" });
  } else {
    findings.push({
      level: "warn",
      message:
        "no test imports @loom/conformance AND calls a run*Conformance(...) — a comment or string does not count; prove your SPI impl with the conformance kit (if one exists for your seam)",
    });
  }

  // Reachability from ESM. A conditional export is matched in ORDER and stops at the
  // first hit, so `{ require, types }` — the shape this scaffold used to emit, and that
  // 49 packages in loom itself carried — resolves for require() and fails an `import`
  // with ERR_PACKAGE_PATH_NOT_EXPORTED. It is invisible to tsc, to a CJS test runner,
  // and to anything that never actually imports the package from ESM.
  const conditional = Object.entries(pkg.exports ?? {}).filter(
    (entry): entry is [string, Record<string, string>] =>
      typeof entry[1] === "object" && entry[1] !== null && !Array.isArray(entry[1])
  );
  const unreachable = conditional.filter(
    ([, conds]) => "require" in conds && !("default" in conds) && !("import" in conds)
  );
  const shadowed = conditional.filter(
    ([, conds]) => "default" in conds && Object.keys(conds).at(-1) !== "default"
  );
  if (conditional.length > 0) {
    if (unreachable.length > 0) {
      findings.push({
        level: "warn",
        message: `exports ${unreachable
          .map(([sub]) => `"${sub}"`)
          .join(
            ", "
          )} declare \`require\` with no \`default\`/\`import\` — an ESM consumer gets ERR_PACKAGE_PATH_NOT_EXPORTED`,
      });
    } else if (shadowed.length > 0) {
      findings.push({
        level: "warn",
        message: `exports ${shadowed
          .map(([sub]) => `"${sub}"`)
          .join(
            ", "
          )} put \`default\` before another condition — \`default\` matches everything, so anything after it is dead`,
      });
    } else {
      findings.push({ level: "ok", message: "exports resolve for both require() and import" });
    }
  }

  // Pre-publish readiness — npm-metadata hygiene a consumer relies on. Warn-only.
  if (opts.publish) {
    const need = (cond: boolean, ok: string, warn: string) =>
      findings.push(cond ? { level: "ok", message: ok } : { level: "warn", message: warn });
    need(
      pkg.version !== undefined && pkg.version !== "0.0.0",
      `version ${pkg.version}`,
      "version is 0.0.0 / unset — bump it before publishing"
    );
    need(
      typeof pkg.description === "string" && pkg.description.length > 0,
      "has a description",
      "no description — add one (shown in npm + `loom plugin search`)"
    );
    need(typeof pkg.license === "string", `license ${pkg.license}`, "no license field");
    need(
      pkg.repository !== undefined,
      "has a repository field",
      "no repository field (provenance)"
    );
    need(
      pkg.exports !== undefined || (pkg.main !== undefined && pkg.types !== undefined),
      "exposes an entry point + types",
      "no exports/main+types — consumers can't import it or get types"
    );
  }

  return findings;
}

function readTestSources(dir: string): TestSource[] {
  const srcDir = path.join(dir, "src");
  if (!fs.existsSync(srcDir)) return [];
  const out: TestSource[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.test\.[cm]?[jt]sx?$/.test(e.name))
        out.push({ source: fs.readFileSync(p, "utf8"), jsx: /x$/.test(e.name) });
    }
  };
  walk(srcDir);
  return out;
}

/**
 * `loom plugin check [--dir .]` — validate a plugin package against the contract.
 * Reads its package.json + test files. Non-zero exit if any `error` finding.
 */
export function cmdPluginCheck(
  dir: string,
  opts: { publish?: boolean } = {}
): { findings: PluginFinding[]; ok: boolean } {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    return {
      findings: [
        { level: "error", message: `no package.json at ${pkgPath} — not a plugin package` },
      ],
      ok: false,
    };
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PluginManifest;
  const findings = checkPlugin(pkg, readTestSources(dir), opts);
  return { findings, ok: !findings.some((f) => f.level === "error") };
}
