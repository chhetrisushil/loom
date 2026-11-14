import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CliError } from "./args";
import { SQLITE_PLUGIN_MISSING, loadSqlitePlugin } from "./sqlitePlugin";

function missing(id: string): Error {
  return Object.assign(new Error(`Cannot find module '${id}'\nRequire stack:\n- /x/cli.js`), {
    code: "MODULE_NOT_FOUND",
  });
}

describe("@loomwork/plugin-sqlite is an optional peer of the CLI", () => {
  it("loads the plugin when it is installed", () => {
    expect(typeof loadSqlitePlugin().SqliteEventStore).toBe("function");
  });

  it("refuses with an install hint when the plugin itself is absent", () => {
    const load = (id: string): never => {
      throw missing(id);
    };
    expect(() => loadSqlitePlugin(load)).toThrow(CliError);
    expect(() => loadSqlitePlugin(load)).toThrow(SQLITE_PLUGIN_MISSING);
    expect(SQLITE_PLUGIN_MISSING).toContain("npm install @loomwork/plugin-sqlite");
  });

  it("surfaces a missing module INSIDE the plugin unchanged (a real fault, not an absent peer)", () => {
    const inner = missing("better-sqlite3");
    const load = (): never => {
      throw inner;
    };
    expect(() => loadSqlitePlugin(load)).toThrow(inner);
  });

  it("is a peer, not a dependency, and no CLI module imports it statically", () => {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, "../package.json"), "utf8"));
    expect(pkg.dependencies["@loomwork/plugin-sqlite"]).toBeUndefined();
    expect(pkg.peerDependencies["@loomwork/plugin-sqlite"]).toBeDefined();
    expect(pkg.peerDependenciesMeta["@loomwork/plugin-sqlite"]).toEqual({ optional: true });
    // A value import anywhere in src would load the native driver for every command again.
    const offenders = readdirSync(__dirname)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) =>
        /^import\s+(?!type\b)[^;]*from\s+"@loomwork\/plugin-sqlite"/m.test(
          readFileSync(path.join(__dirname, f), "utf8")
        )
      );
    expect(offenders).toEqual([]);
  });
});
