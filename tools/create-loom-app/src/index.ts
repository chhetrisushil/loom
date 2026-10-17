#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { appFiles, isValidPackageName, packageNameFrom } from "@loom/scaffold";

/**
 * The file map for a new Loom app (folder convention, wired via defineConfig).
 * Templates live in `@loom/scaffold`, shared with `loom new`. Re-exported here as
 * `scaffoldFiles` for backwards compatibility.
 */
export const scaffoldFiles = appFiles;

const USAGE = `usage: create-loom-app <directory> [--loom-path <loom checkout>] [--name <package>] [--force]

  <directory>    new app folder; refused when it already has files (unless --force)
  --loom-path    your built loom checkout. @loom/* is not published, so an app created
                 OUTSIDE the loom pnpm workspace links to it (link: + pnpm overrides).
                 Not needed inside the workspace (apps/<name> gets workspace:*).
  --name         npm package name, may be scoped (default: the folder name, which must be a valid one)
  --force        scaffold into a non-empty folder: overwrites only the files this generates,
                 never deletes anything`;

/** A refusal: nothing has been written; exit code 2 (bad usage / refused, distinct from a crash). */
class Refusal extends Error {}

// ── Where is the target? ─────────────────────────────────────────────────────

/**
 * Glob (pnpm-workspace `packages:` syntax: `*` = one segment, `**` = any depth) → RegExp.
 * `**` also matches zero segments: `**\/foo` matches top-level `foo`, `packages/**` matches
 * `packages` itself.
 */
export function globToRegExp(glob: string): RegExp {
  const segs = glob.replace(/^\.\//, "").replace(/\/+$/, "").split("/");
  let re = "";
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === "**") {
      // zero or more whole segments
      re += last ? (i === 0 ? ".*" : "(?:/.*)?") : "(?:.*/)?";
      return;
    }
    const part = seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
    const prevGlobstar = i > 0 && segs[i - 1] === "**";
    re += (i === 0 || prevGlobstar ? "" : "/") + part;
  });
  return new RegExp(`^${re}$`);
}

function unquote(raw: string): string {
  const t = raw.trim();
  const m = /^(?:'([^']*)'|"([^"]*)"|([^\s#'"]+))\s*(?:#.*)?$/.exec(t);
  if (!m) throw new Refusal(`cannot parse pnpm-workspace.yaml entry ${JSON.stringify(raw)}`);
  return (m[1] ?? m[2] ?? m[3]) as string;
}

/**
 * The `packages:` globs of a pnpm-workspace.yaml (the only key we need; no YAML dependency).
 * `undefined` = no `packages:` key (pnpm then treats every directory as a package). Anything we
 * cannot read with confidence throws a {@link Refusal} rather than guessing "not a member".
 */
export function workspaceGlobs(yaml: string): string[] | undefined {
  const lines = yaml.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^packages\s*:/.test(l));
  if (idx < 0) return undefined;
  const fail = (): never => {
    throw new Refusal(
      "cannot confidently parse the `packages:` list of the enclosing pnpm-workspace.yaml; refusing to guess whether the target is a workspace member. Scaffold outside that workspace."
    );
  };
  const rest = (lines[idx] as string).replace(/^packages\s*:/, "").trim();
  if (rest !== "" && !rest.startsWith("#")) {
    // Inline / flow form, possibly spanning lines: packages: ['a/*', "b"]
    if (!rest.startsWith("[")) return fail();
    let text = rest;
    for (let j = idx + 1; !text.includes("]") && j < lines.length; j++) text += ` ${lines[j]}`;
    const m = /^\[([^\]]*)\]\s*(?:#.*)?$/.exec(text);
    if (!m) return fail();
    const items = (m[1] as string)
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== "");
    return items.map(unquote);
  }
  const out: string[] = [];
  for (let j = idx + 1; j < lines.length; j++) {
    const line = lines[j] as string;
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) break; // next top-level key
    const m = /^\s*-\s*(.*)$/.exec(line);
    if (!m) return fail();
    out.push(unquote(m[1] as string));
  }
  if (out.length === 0) return fail();
  return out;
}

export interface WorkspaceContext {
  /** The nearest pnpm workspace that lists the target as a member, if any. */
  root: string | undefined;
  /** Whether that workspace is the loom checkout itself (so `workspace:*` resolves). */
  isLoom: boolean;
}

function readName(manifest: string): string | undefined {
  try {
    return (JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string }).name;
  } catch {
    return undefined;
  }
}

/**
 * Walk up from `target` for a `pnpm-workspace.yaml` whose globs include it. Inside the loom
 * checkout, `@loom/*` as `workspace:*` resolves; anywhere else it cannot.
 */
export function findWorkspace(target: string): WorkspaceContext {
  const abs = path.resolve(target);
  for (let dir = abs; ; dir = path.dirname(dir)) {
    const file = path.join(dir, "pnpm-workspace.yaml");
    if (fs.existsSync(file)) {
      const rel = path.relative(dir, abs).split(path.sep).join("/");
      const globs = workspaceGlobs(fs.readFileSync(file, "utf8"));
      const member =
        rel === "" ||
        globs === undefined ||
        (globs.some((g) => !g.startsWith("!") && globToRegExp(g).test(rel)) &&
          !globs.some((g) => g.startsWith("!") && globToRegExp(g.slice(1)).test(rel)));
      if (member) {
        const isLoom =
          readName(path.join(dir, "packages", "core", "package.json")) === "@loom/core";
        return { root: dir, isLoom };
      }
    }
    if (path.dirname(dir) === dir) return { root: undefined, isLoom: false };
  }
}

// ── A loom checkout to link to ───────────────────────────────────────────────

/** Every `@loom/*` package in a loom checkout: name → absolute directory. */
export function loomPackages(loomRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const tier of ["packages", "plugins", "tools"]) {
    const base = path.join(loomRoot, tier);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      const name = readName(path.join(dir, "package.json"));
      if (name?.startsWith("@loom/")) out.set(name, dir);
    }
  }
  return out;
}

/** `path.resolve` + `realpath` of the deepest existing ancestor, so `/var` vs `/private/var` can't skew a relative link. */
function realResolve(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  while (!fs.existsSync(cur) && path.dirname(cur) !== cur) {
    tail.unshift(path.basename(cur));
    cur = path.dirname(cur);
  }
  return path.join(fs.realpathSync(cur), ...tail);
}

/** Resolve and validate `--loom-path`: a loom checkout whose packages are built. */
function resolveLoomPath(raw: string, cwd: string): string {
  const root = realResolve(path.resolve(cwd, raw));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Refusal(`--loom-path "${raw}" is not a directory (resolved ${root})`);
  }
  if (
    !fs.existsSync(path.join(root, "pnpm-workspace.yaml")) ||
    readName(path.join(root, "packages", "core", "package.json")) !== "@loom/core"
  ) {
    throw new Refusal(
      `--loom-path "${raw}" is not a loom checkout (no pnpm-workspace.yaml with packages/core = @loom/core). Clone git@github.com:chhetrisushil/loom.git and point at its root.`
    );
  }
  const pkgs = loomPackages(root);
  const unbuilt = ["@loom/core", "@loom/app", "@loom/cli", "@loom/testing"].filter((n) => {
    const dir = pkgs.get(n);
    return dir === undefined || !fs.existsSync(path.join(dir, "dist"));
  });
  if (unbuilt.length > 0) {
    throw new Refusal(
      `the loom checkout at ${root} is not built (no dist/ in ${unbuilt.join(", ")}). Run \`pnpm install && pnpm build\` there first.`
    );
  }
  return root;
}

/**
 * Rewrite the scaffolded `package.json` for an app outside the loom workspace: `@loom/*`
 * dependencies become `*`, and `pnpm.overrides` redirects EVERY loom package to a `link:` into
 * the checkout. All of them, not just the app's direct ones: a `link:` dependency does not bring
 * its own `workspace:*` dependencies, so each transitive one must be mapped too — the same wiring
 * `loom-examples` uses. (Everything, so a later `loom new sentinel` only adds `"…": "*"`.)
 */
export function linkPackageJson(json: string, appRoot: string, loomRoot: string): string {
  const pkg = JSON.parse(json) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    [k: string]: unknown;
  };
  for (const table of [pkg.dependencies, pkg.devDependencies]) {
    for (const name of Object.keys(table)) if (name.startsWith("@loom/")) table[name] = "*";
  }
  const overrides: Record<string, string> = {};
  for (const [name, dir] of [...loomPackages(loomRoot)].sort(([a], [b]) => a.localeCompare(b))) {
    const rel = path.relative(appRoot, dir).split(path.sep).join("/");
    overrides[name] = `link:${rel}`;
  }
  pkg.pnpm = { overrides };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

interface Args {
  target?: string;
  loomPath?: string;
  name?: string;
  force: boolean;
  help: boolean;
}

/** Quote a path for the printed `cd` hint when the shell would split or expand it. */
function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const valued = (flag: string): string => {
      if (a !== flag) return a.slice(flag.length + 1); // --flag=value
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) {
        throw new Error(`create-loom-app: ${flag} needs a value\n${USAGE}`);
      }
      return v;
    };
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--force") args.force = true;
    else if (a === "--loom-path" || a.startsWith("--loom-path="))
      args.loomPath = valued("--loom-path");
    else if (a === "--name" || a.startsWith("--name=")) args.name = valued("--name");
    else if (a.startsWith("-")) {
      // A flag is not a directory name. Without this, `create-loom-app --help` scaffolds eleven
      // files into a folder literally called `--help` and reports success.
      throw new Error(`create-loom-app: "${a}" is not a directory name\n${USAGE}`);
    } else if (args.target === undefined) args.target = a;
    else throw new Error(`create-loom-app: unexpected extra argument "${a}"\n${USAGE}`);
  }
  return args;
}

/** Runs the CLI; returns the exit code. Every Refusal happens before the first write. */
/** Refuse when any component of `dest` below `root` (the target itself included) is a symbolic link. */
export function assertNoLinkBelow(root: string, dest: string): void {
  const rel = path.relative(path.resolve(root), path.resolve(dest));
  let cur = path.resolve(root);
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      return; // nothing deeper exists
    }
    if (st.isSymbolicLink()) {
      throw new Refusal(
        `refusing to write through the symbolic link "${path.relative(root, cur)}" - replace it with a real file or directory, or scaffold into a clean directory`
      );
    }
  }
}

export function run(argv: string[], cwd: string): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.target === undefined) {
    console.error(USAGE);
    return 2;
  }
  const target = args.target;
  try {
    const root = realResolve(path.resolve(cwd, target));

    // The package name: a valid npm name, or refuse with the name we would have used. Taken from
    // the folder as TYPED, not its realpath — a symlinked target is named after the link.
    const dirName = path.basename(path.resolve(cwd, target));
    const pkgName = args.name ?? dirName;
    if (!isValidPackageName(pkgName)) {
      const hint = packageNameFrom(args.name ?? dirName);
      throw new Refusal(
        `"${pkgName}" is not a valid npm package name (lowercase letters, digits, - . _ ~, optionally @scope/; no spaces).${
          hint
            ? ` Try \`--name ${hint}\` or a folder called ${hint}.`
            : " Pass a valid one with --name."
        }`
      );
    }

    // Never write into someone's project by accident.
    let existing = 0;
    if (fs.existsSync(root)) {
      if (!fs.statSync(root).isDirectory())
        throw new Refusal(`${root} exists and is not a directory`);
      const entries = fs.readdirSync(root);
      if (entries.length > 0 && !args.force) {
        const shown = entries.slice(0, 5).join(", ") + (entries.length > 5 ? ", …" : "");
        throw new Refusal(
          `${target === "." ? "the current directory" : `"${target}"`} is not empty (${shown}). Pick a new directory, or pass --force to scaffold into it (that overwrites only the files this generates and never deletes anything).`
        );
      }
      existing = entries.length;
    }

    // Inside the loom workspace `workspace:*` resolves; anywhere else it cannot (unpublished).
    const ws = findWorkspace(root);
    let loomRoot: string | undefined;
    if (ws.root !== undefined && !ws.isLoom) {
      throw new Refusal(
        `"${target}" is a member of the pnpm workspace at ${ws.root}, which is not a loom checkout. pnpm reads \`overrides\` only from a workspace root, so a linked app cannot live there — scaffold outside that workspace.`
      );
    }
    if (!ws.isLoom) {
      if (args.loomPath === undefined) {
        throw new Refusal(
          `@loom/* packages are not published to npm yet, so an app outside the loom workspace must link to a built loom checkout.\n  create-loom-app ${shellQuote(target)} --loom-path <path to your loom checkout>\n(build it first: \`pnpm install && pnpm build\` there). Or scaffold inside it, e.g. <loom>/apps/<name>, which needs no flag.`
        );
      }
      loomRoot = resolveLoomPath(args.loomPath, cwd);
    }

    const files = appFiles(pkgName);
    if (loomRoot !== undefined) {
      files["package.json"] = linkPackageJson(files["package.json"] as string, root, loomRoot);
    }

    // `--force` into an existing directory: a planted `package.json -> ~/.x` (or a linked `src/`) must not be
    // written through. Check EVERY target first so a refusal leaves the directory untouched.
    for (const rel of Object.keys(files)) assertNoLinkBelow(root, path.join(root, rel));
    let overwritten = 0;
    for (const [rel, content] of Object.entries(files)) {
      const dest = path.join(root, rel);
      if (fs.existsSync(dest)) overwritten++;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      assertNoLinkBelow(root, dest);
      const tmp = `${dest}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, content, { flag: "wx" });
        fs.renameSync(tmp, dest); // replaces the entry; never follows a link at the final component
      } catch (e) {
        fs.rmSync(tmp, { force: true });
        throw e;
      }
    }
    console.log(`Scaffolded ${Object.keys(files).length} files into ${target}/`);
    if (args.force && existing > 0) {
      console.log(
        `--force: overwrote ${overwritten} existing generated file(s); every other file in the directory was left untouched (nothing is ever deleted).`
      );
    }
    console.log(
      loomRoot !== undefined
        ? `Linked @loom/* to ${loomRoot} (link: + pnpm overrides in package.json).`
        : "Inside the loom workspace: @loom/* is workspace:* (run `pnpm install` from the repo root or this app)."
    );
    const cd = target === "." ? "" : `cd ${shellQuote(target)} && `;
    console.log(`Next: ${cd}pnpm install && pnpm test && pnpm start`);
    return 0;
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    console.error(`create-loom-app: ${err.message}`);
    return 2;
  }
}

// Run only when invoked as a CLI (not when imported by tests).
// `require.main === module`, not a filename check: `npm create loom-app` and any global
// install invoke this through a symlink named `create-loom-app`, where argv[1] never ends
// in "index.js" — the scaffolder would exit 0 having created nothing.
if (require.main === module) {
  process.exitCode = run(process.argv.slice(2), process.cwd());
}
