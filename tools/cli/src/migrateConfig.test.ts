import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GROUPED_OPTIONS } from "@loom/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "./cli";
import { analyzeConfig, cmdMigrateConfig, unifiedDiff } from "./migrateConfig";

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
      /no `defineConfig/
    );
  });

  it("leaves a clean config byte-identical (no refusal)", () => {
    const src = wrap("  security: { strict: true },\n  stores: s,\n");
    expect(analyzeConfig(src)).toEqual({ moved: [], conflicts: [], refusal: undefined, text: src });
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
