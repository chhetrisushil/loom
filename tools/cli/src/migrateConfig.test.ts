import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROUPED_OPTIONS } from "@loom/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./cli";
import { analyzeConfig, checkPreserved, cmdMigrateConfig, unifiedDiff } from "./migrateConfig";

const wrap = (body: string) =>
  `import { defineConfig } from "@loom/app";\n\nexport default defineConfig({\n${body}});\n`;

describe("migrate-config: the mapping is @loom/app's own table", () => {
  it("moves every flat option to the group GROUPED_OPTIONS names, idempotently", () => {
    for (const [group, options] of GROUPED_OPTIONS) {
      for (const option of options) {
        const a = analyzeConfig(wrap(`  ${option}: 1,\n`));
        expect(a.refusal, option).toBeUndefined();
        expect(a.moved, option).toEqual([{ key: option, group }]);
        expect(a.text, option).toBe(wrap(`  ${group}: {\n    ${option}: 1,\n  },\n`));
        const again = analyzeConfig(a.text);
        expect(again.moved).toEqual([]);
        expect(again.text).toBe(a.text);
      }
    }
  });
});

describe("migrate-config: rewriting", () => {
  it("groups several flat keys, keeping order and the neighbours untouched", () => {
    const a = analyzeConfig(
      wrap(
        "  name: 'x',\n  strict: true,\n  telemetry,\n  killSwitch: new Foo({ a: [1, 2] }),\n  stores: s,\n"
      )
    );
    expect(a.text).toBe(
      wrap(
        "  name: 'x',\n  security: {\n    strict: true,\n    killSwitch: new Foo({ a: [1, 2] }),\n  },\n  observability: {\n    telemetry,\n  },\n  stores: s,\n"
      )
    );
  });

  it("merges into an existing multi-line namespace, adding a missing trailing comma", () => {
    const a = analyzeConfig(wrap("  strict: true,\n  security: {\n    authorizer: a\n  },\n"));
    expect(a.conflicts).toEqual([]);
    expect(a.text).toBe(wrap("  security: {\n    authorizer: a,\n    strict: true,\n  },\n"));
  });

  it("merges into an inline namespace and an empty one", () => {
    expect(analyzeConfig(wrap("  strict: true,\n  security: { crypto },\n")).text).toBe(
      wrap("  security: { crypto, strict: true },\n")
    );
    expect(analyzeConfig(wrap("  strict: true,\n  security: {},\n")).text).toBe(
      wrap("  security: { strict: true },\n")
    );
    expect(analyzeConfig(wrap("  strict: true,\n  security: {\n  },\n")).text).toBe(
      wrap("  security: {\n    strict: true,\n  },\n")
    );
  });

  it("handles a one-line config, merging and creating namespaces", () => {
    const head = `import { defineConfig } from "@loom/app";\n`;
    const src = `${head}export default defineConfig({ name: "a", strict: true, onWarn, security: { crypto } });\n`;
    expect(analyzeConfig(src).text).toBe(
      `${head}export default defineConfig({ name: "a", observability: { onWarn }, security: { crypto, strict: true } });\n`
    );
  });

  it("preserves comments: leading ones travel with the entry, others stay put", () => {
    const body = [
      "  // the app name",
      "  name: 'x', // trailing",
      "",
      "  // detached note",
      "",
      "  // hardening",
      "  /* really */",
      "  strict: true, // keep",
      "  // about stores",
      "  stores: s,",
    ].join("\n");
    const a = analyzeConfig(wrap(`${body}\n`));
    expect(a.text).toBe(
      wrap(
        `${[
          "  // the app name",
          "  name: 'x', // trailing",
          "",
          "  // detached note",
          "",
          "  security: {",
          "    // hardening",
          "    /* really */",
          "    strict: true, // keep",
          "  },",
          "  // about stores",
          "  stores: s,",
        ].join("\n")}\n`
      )
    );
  });

  it("reindents a multi-line value and ignores brackets inside strings, templates, regexes", () => {
    const a = analyzeConfig(wrap("  policies: [\n    `}${'{'}`,\n    /[}]/,\n    \"}\",\n  ],\n"));
    expect(a.text).toBe(
      wrap(
        "  security: {\n    policies: [\n      `}${'{'}`,\n      /[}]/,\n      \"}\",\n    ],\n  },\n"
      )
    );
  });

  it("treats a quoted key like a bare one", () => {
    expect(analyzeConfig(wrap('  "strict": true,\n')).moved).toEqual([
      { key: "strict", group: "security" },
    ]);
  });
});

describe("migrate-config: conflicts and refusals", () => {
  it("reports a key set both flat and in its namespace, and rewrites nothing", () => {
    const src = wrap("  strict: true,\n  security: { strict: false },\n  onWarn,\n");
    const a = analyzeConfig(src);
    expect(a.conflicts).toEqual([
      "`strict` is set both flat and in `security`; keep one and re-run",
    ]);
    expect(a.text).toBe(src);
    expect(a.moved).toEqual([]);
  });

  it("refuses a spread", () => {
    const a = analyzeConfig(wrap("  ...base,\n  strict: true,\n"));
    expect(a.refusal).toMatch(/spreads `\.\.\.base`/);
  });

  it("refuses a computed key, a non-literal config and a non-literal namespace", () => {
    expect(analyzeConfig(wrap("  [k]: 1,\n")).refusal).toMatch(/computed key/);
    expect(
      analyzeConfig(
        `import { defineConfig } from "@loom/app";\nexport default defineConfig(cfg);\n`
      ).refusal
    ).toMatch(/not given an object literal \(cfg\)/);
    expect(analyzeConfig(wrap("  strict: true,\n  security: shared,\n")).refusal).toMatch(
      /`security` is not an object literal/
    );
  });

  it("refuses entries that share a line in a multi-line config", () => {
    expect(analyzeConfig(wrap("  name: 'x', strict: true,\n  stores: s,\n")).refusal).toMatch(
      /shares a line/
    );
  });

  it("refuses a file that is not a loom config or has no defineConfig call", () => {
    expect(
      analyzeConfig(`import { defineConfig } from "vite";\ndefineConfig({ strict: 1 });\n`).refusal
    ).toMatch(/@loom\/app/);
    expect(analyzeConfig(`import "@loom/app";\nexport const x = 1;\n`).refusal).toMatch(
      /no import of `defineConfig`/
    );
    expect(
      analyzeConfig(`import { defineConfig } from "@loom/app";\nexport const x = 1;\n`).refusal
    ).toMatch(/no `defineConfig/);
  });

  it("leaves a clean config byte-identical (no refusal)", () => {
    const src = wrap("  security: { strict: true },\n  stores: s,\n");
    expect(analyzeConfig(src)).toEqual({
      moved: [],
      conflicts: [],
      refusal: undefined,
      text: src,
      created: [],
    });
  });
});

describe("migrate-config: the diff", () => {
  it("is empty for equal text and a unified diff otherwise", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", "f")).toBe("");
    expect(unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "f")).toBe(
      "--- a/f\n+++ b/f\n@@ -1,4 +1,4 @@\n a\n-b\n+B\n c\n "
    );
  });
});

describe("loom migrate-config (command)", () => {
  let dir: string;
  let out: string[];
  let err: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-migrate-"));
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      err.push(a.join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  it("dry run prints a diff, exits 0 and writes nothing", async () => {
    const src = wrap("  strict: true,\n");
    const p = write("loom.config.ts", src);
    const mtime = statSync(p).mtimeMs;
    expect(await run(["migrate-config", p])).toBe(0);
    expect(readFileSync(p, "utf8")).toBe(src);
    expect(statSync(p).mtimeMs).toBe(mtime);
    const text = out.join("\n");
    expect(text).toContain("+  security: {");
    expect(text).toContain("would migrate");
    expect(text).toContain("re-run with --apply");
  });

  it("--apply writes, and a second run finds nothing to do", async () => {
    const p = write("loom.config.ts", wrap("  strict: true,\n  telemetry,\n"));
    expect(await run(["migrate-config", p, "--apply"])).toBe(0);
    expect(readFileSync(p, "utf8")).toBe(
      wrap("  security: {\n    strict: true,\n  },\n  observability: {\n    telemetry,\n  },\n")
    );
    out.length = 0;
    expect(await run(["migrate-config", p, "--apply"])).toBe(0);
    expect(out.join("\n")).toContain("nothing to migrate");
  });

  it("--config names the file, and --json carries the structured result", async () => {
    const p = write("c.ts", wrap("  now: () => 1,\n"));
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    expect(await run(["migrate-config", "--config", p, "--json"])).toBe(0);
    const doc = JSON.parse(stdout.join("")) as {
      apply: boolean;
      files: { changed: boolean; moved: unknown[] }[];
    };
    expect(doc.apply).toBe(false);
    expect(doc.files[0]?.changed).toBe(true);
    expect(doc.files[0]?.moved).toEqual([{ key: "now", group: "execution" }]);
  });

  it("a refusal exits 2 with what to change, and --apply writes nothing", async () => {
    const src = wrap("  ...base,\n  strict: true,\n");
    const p = write("loom.config.ts", src);
    expect(await run(["migrate-config", p, "--apply"])).toBe(2);
    expect(readFileSync(p, "utf8")).toBe(src);
    expect(out.join("\n")).toContain("refused: the defineConfig object spreads");
  });

  it("a conflict exits 2 and writes nothing", async () => {
    const src = wrap("  strict: true,\n  security: { strict: true },\n");
    const p = write("loom.config.ts", src);
    expect(await run(["migrate-config", p, "--apply"])).toBe(2);
    expect(readFileSync(p, "utf8")).toBe(src);
    expect(out.join("\n")).toContain("conflict:");
  });

  it("discovers ./loom.config.ts in the working directory", async () => {
    const sub = join(dir, "app");
    mkdirSync(sub);
    writeFileSync(join(sub, "loom.config.ts"), wrap("  strict: true,\n"));
    const cwd = process.cwd();
    process.chdir(sub);
    try {
      expect(await run(["migrate-config"])).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(err.join("\n")).toContain("using ./loom.config.ts");
    expect(out.join("\n")).toContain("would migrate");
  });

  it("no file and nothing to discover is a usage error (2); an unreadable file too", async () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await run(["migrate-config"])).toBe(2);
    } finally {
      process.chdir(cwd);
    }
    expect(await run(["migrate-config", join(dir, "missing.ts")])).toBe(2);
    expect(() => cmdMigrateConfig({ files: [join(dir, "missing.ts")], apply: false })).toThrow(
      /cannot read/
    );
  });
});

// ── Review fixes ─────────────────────────────────────────────────────────────

describe("migrate-config: values are never changed by the move (P1)", () => {
  const moveTemplate = (value: string) =>
    wrap(`  name: "x",\n  telemetry: {\n    a: ${value},\n  },\n`);

  it("P1: a multi-line template value is byte-identical after the move", () => {
    const value = "`l1\n  l2\n    l3`";
    const a = analyzeConfig(moveTemplate(value));
    expect(a.refusal).toBeUndefined();
    expect(a.text).toBe(
      wrap(`  name: "x",\n  observability: {\n    telemetry: {\n      a: ${value},\n    },\n  },\n`)
    );
    expect(checkPreserved(moveTemplate(value), a.text, a.created)).toBeUndefined();
    expect(analyzeConfig(a.text).text).toBe(a.text);
  });

  it("P1: a multi-line template with substitutions keeps its inner lines", () => {
    const value = "`l1 ${x}\n  l2 ${ {a: 1}.a }\n  l3`";
    const a = analyzeConfig(moveTemplate(value));
    expect(a.text).toContain(`a: ${value},`);
    expect(a.text).toContain("\n  l2 ${ {a: 1}.a }\n  l3`,");
  });

  it("P1: a backslash-continued string keeps its continuation line", () => {
    const value = '"l1\\\n  l2"';
    const a = analyzeConfig(moveTemplate(value));
    expect(a.refusal).toBeUndefined();
    expect(a.text).toContain(`a: ${value},`);
    expect(a.moved).toEqual([{ key: "telemetry", group: "observability" }]);
  });

  it("P1: a template into an EXISTING namespace is untouched too", () => {
    const src = wrap(
      "  telemetry: {\n    a: `x\n  y`,\n  },\n  observability: {\n    onWarn,\n  },\n"
    );
    const a = analyzeConfig(src);
    expect(a.text).toContain("a: `x\n  y`,");
  });

  it("P1: the preservation check refuses a corrupting rewrite (nothing written)", () => {
    const src = moveTemplate("`l1\n  l2`");
    const p = join(mkdtempSync(join(tmpdir(), "loom-migrate-c-")), "loom.config.ts");
    writeFileSync(p, src);
    try {
      const corrupt = (s: string) => {
        const a = analyzeConfig(s);
        return { ...a, text: a.text.replace("\n  l2`", "\n    l2`") };
      };
      const r = cmdMigrateConfig({ files: [p], apply: true }, { analyze: corrupt });
      expect(r.refused).toBe(true);
      expect(r.files[0]?.refusal).toMatch(/change the content of the config/);
      expect(r.files[0]?.changed).toBe(false);
      expect(readFileSync(p, "utf8")).toBe(src);
    } finally {
      rmSync(join(p, ".."), { recursive: true, force: true });
    }
  });

  it("the check also catches a lost or duplicated entry and unbalanced braces", () => {
    const src = wrap("  strict: true,\n  telemetry,\n");
    const a = analyzeConfig(src);
    expect(checkPreserved(src, a.text, a.created)).toBeUndefined();
    expect(checkPreserved(src, a.text.replace("    telemetry,\n", ""), a.created)).toMatch(
      /change the content/
    );
    expect(checkPreserved(src, a.text.replace("strict: true", "strict: false"), a.created)).toMatch(
      /change the content/
    );
    expect(checkPreserved(src, a.text, [])).toMatch(/change the content/);
  });
});

describe("migrate-config: file endings, BOM, bindings, generics (P3)", () => {
  it("a CRLF file stays CRLF: inserted and moved lines, no mixed endings", () => {
    const crlf = (s: string) => s.replace(/\n/g, "\r\n");
    const src = crlf(
      wrap(
        "  strict: true, // keep\n  telemetry,\n  killSwitch: f(\n    1,\n  ),\n  security: {\n    crypto,\n  },\n"
      )
    );
    const a = analyzeConfig(src);
    expect(a.refusal).toBeUndefined();
    expect(a.text).toBe(
      crlf(
        wrap(
          "  observability: {\n    telemetry,\n  },\n  security: {\n    crypto,\n    strict: true, // keep\n    killSwitch: f(\n      1,\n    ),\n  },\n"
        )
      )
    );
    expect(/(?<!\r)\n/.test(a.text)).toBe(false);
    expect(analyzeConfig(a.text).text).toBe(a.text);
  });

  it("an LF file gets no CR", () => {
    expect(analyzeConfig(wrap("  strict: true,\n")).text.includes("\r")).toBe(false);
  });

  it("a BOM is preserved", () => {
    const a = analyzeConfig(`\uFEFF${wrap("  strict: true,\n")}`);
    expect(a.refusal).toBeUndefined();
    expect(a.text).toBe(`\uFEFF${wrap("  security: {\n    strict: true,\n  },\n")}`);
  });

  it("rewrites the call through the local name of the @loom/app import", () => {
    const src = `import { defineConfig as dc } from "@loom/app";\nexport default dc({\n  strict: true,\n});\n`;
    expect(analyzeConfig(src).text).toBe(
      `import { defineConfig as dc } from "@loom/app";\nexport default dc({\n  security: {\n    strict: true,\n  },\n});\n`
    );
    const ns = `import * as app from "@loom/app";\nexport default app.defineConfig({\n  strict: true,\n});\n`;
    expect(analyzeConfig(ns).moved).toEqual([{ key: "strict", group: "security" }]);
  });

  it("does not rewrite a defineConfig from another module (a vite-style config)", () => {
    const vite = `import { defineConfig } from "vite";\nimport { loom } from "@loom/app";\nexport default defineConfig({\n  strict: true,\n  plugins: [loom()],\n});\n`;
    const a = analyzeConfig(vite);
    expect(a.refusal).toMatch(/no import of `defineConfig` from `@loom\/app`/);
    expect(a.text).toBe(vite);
    const both = `import { defineConfig as dc } from "@loom/app";\nimport { defineConfig } from "vite";\nconst v = defineConfig({\n  strict: true,\n});\nexport default dc({\n  strict: true,\n});\n`;
    const b = analyzeConfig(both);
    expect(b.moved).toEqual([{ key: "strict", group: "security" }]);
    expect(b.text).toContain("const v = defineConfig({\n  strict: true,\n});");
    expect(b.text).toContain("dc({\n  security: {\n    strict: true,");
    const typeOnly = `import type { defineConfig } from "@loom/app";\ndefineConfig({\n  strict: true,\n});\n`;
    expect(analyzeConfig(typeOnly).refusal).toMatch(/no import of `defineConfig`/);
  });

  it("a generic in a flat value does not split the entry at its comma", () => {
    const a = analyzeConfig(
      wrap(
        "  policies: new Map<string, number>(),\n  name: f<A, B>(1),\n  secrets: x as Map<string, Set<number>>,\n"
      )
    );
    expect(a.refusal).toBeUndefined();
    expect(a.text).toBe(
      wrap(
        "  security: {\n    policies: new Map<string, number>(),\n    secrets: x as Map<string, Set<number>>,\n  },\n  name: f<A, B>(1),\n"
      )
    );
    const one = analyzeConfig(
      `import { defineConfig } from "@loom/app";\ndefineConfig({ policies: new Map<string, number>(), name: "x" });\n`
    );
    expect(one.text).toContain("security: { policies: new Map<string, number>() }");
    // Two comparisons are two entries, not a type-argument list.
    const cmp = analyzeConfig(wrap("  strict: a<b,\n  name: c>d,\n"));
    expect(cmp.moved).toEqual([{ key: "strict", group: "security" }]);
  });
});

describe("migrate-config: writing the files (P2)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-migrate-w-"));
  });
  afterEach(() => {
    for (const d of [dir, join(dir, "ro")]) {
      try {
        chmodSync(d, 0o755);
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const put = (rel: string, body: string) => {
    const p = join(dir, rel);
    writeFileSync(p, body);
    return p;
  };
  const isRoot = process.getuid?.() === 0;

  it("refuses a symlinked config, naming the real path, and changes nothing", () => {
    const real = put("real.ts", wrap("  strict: true,\n"));
    const link = join(dir, "loom.config.ts");
    symlinkSync(real, link);
    const r = cmdMigrateConfig({ files: [link], apply: true });
    expect(r.refused).toBe(true);
    expect(r.files[0]?.refusal).toContain(realpathSync(real));
    expect(readFileSync(real, "utf8")).toBe(wrap("  strict: true,\n"));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("preserves the file mode and leaves no temp file", () => {
    const a = put("a.ts", wrap("  strict: true,\n"));
    chmodSync(a, 0o600);
    const b = put("b.ts", wrap("  strict: true,\n"));
    chmodSync(b, 0o755);
    const r = cmdMigrateConfig({ files: [a, b], apply: true });
    expect(r.refused).toBe(false);
    expect(r.files.map((f) => f.written)).toEqual([true, true]);
    expect(statSync(a).mode & 0o777).toBe(0o600);
    expect(statSync(b).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir).sort()).toEqual(["a.ts", "b.ts"]);
    expect(readFileSync(a, "utf8")).toBe(wrap("  security: {\n    strict: true,\n  },\n"));
  });

  it("is all-or-nothing: one refused file means no file is written", () => {
    const good = put("good.ts", wrap("  strict: true,\n"));
    const bad = put("bad.ts", wrap("  ...base,\n  strict: true,\n"));
    const r = cmdMigrateConfig({ files: [good, bad], apply: true });
    expect(r.refused).toBe(true);
    expect(r.blocked).toBe(true);
    expect(r.files.map((f) => f.written)).toEqual([false, false]);
    expect(readFileSync(good, "utf8")).toBe(wrap("  strict: true,\n"));
  });

  it.skipIf(isRoot)("a write failure leaves the original intact and is reported", () => {
    mkdirSync(join(dir, "ro"));
    const f = put("ro/loom.config.ts", wrap("  strict: true,\n"));
    chmodSync(join(dir, "ro"), 0o555);
    const r = cmdMigrateConfig({ files: [f], apply: true });
    chmodSync(join(dir, "ro"), 0o755);
    expect(r.refused).toBe(true);
    expect(r.writeError?.path).toBe(f);
    expect(r.writeError?.written).toEqual([]);
    expect(r.writeError?.unwritten).toEqual([f]);
    expect(readFileSync(f, "utf8")).toBe(wrap("  strict: true,\n"));
    expect(readdirSync(join(dir, "ro"))).toEqual(["loom.config.ts"]);
  });

  it.skipIf(isRoot)("a failure part-way reports exactly which files were written", () => {
    mkdirSync(join(dir, "ro"));
    const first = put("first.ts", wrap("  strict: true,\n"));
    const second = put("ro/second.ts", wrap("  strict: true,\n"));
    const third = put("third.ts", wrap("  strict: true,\n"));
    chmodSync(join(dir, "ro"), 0o555);
    const r = cmdMigrateConfig({ files: [first, second, third], apply: true });
    chmodSync(join(dir, "ro"), 0o755);
    expect(r.writeError?.written).toEqual([first]);
    expect(r.writeError?.unwritten).toEqual([second, third]);
    expect(readFileSync(first, "utf8")).toBe(wrap("  security: {\n    strict: true,\n  },\n"));
    expect(readFileSync(second, "utf8")).toBe(wrap("  strict: true,\n"));
    expect(readFileSync(third, "utf8")).toBe(wrap("  strict: true,\n"));
  });
});

describe("migrate-config: a large config is rewritten correctly (linear analysis)", () => {
  /** `n` flat multi-line entries cycling over every grouped option, plus unrelated ones between. */
  const big = (n: number) => {
    const options = GROUPED_OPTIONS.flatMap(([, list]) => [...(list as readonly string[])]);
    let body = "";
    for (let i = 0; i < n; i++) {
      const o = options[i % options.length] as string;
      body += `  // entry ${i}\n  ${o}: {\n    n: ${i},\n  },\n  custom${i}: ${i},\n`;
    }
    return { body, options };
  };

  it("moves every flat entry once, keeps the rest in order, is idempotent and content-preserving", () => {
    const n = 3000;
    const { body, options } = big(n);
    const src = wrap(body);
    const a = analyzeConfig(src);
    expect(a.refusal).toBeUndefined();
    expect(a.conflicts).toEqual([]);
    expect(a.moved).toHaveLength(n);
    expect(a.moved.map((m) => m.key).slice(0, options.length)).toEqual(options);
    // Unrelated entries stay at the top level, in their original order.
    const custom = [...a.text.matchAll(/^ {2}custom(\d+): /gm)].map((m) => Number(m[1]));
    expect(custom).toEqual(Array.from({ length: n }, (_, i) => i));
    // No moved entry is left at the top level.
    expect(a.text).not.toMatch(new RegExp(`^ {2}(${options.join("|")}): `, "m"));
    expect(checkPreserved(src, a.text, a.created)).toBeUndefined();
    const again = analyzeConfig(a.text);
    expect(again.moved).toEqual([]);
    expect(again.text).toBe(a.text);
  });
});
