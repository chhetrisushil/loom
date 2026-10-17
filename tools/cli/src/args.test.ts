import { describe, expect, it } from "vitest";
import { COMMANDS, UsageError, editDistance, parseArgs, suggest } from "./args";

describe("parseArgs (flag table on node:util)", () => {
  it("a boolean flag does not swallow the positional after it", () => {
    const p = parseArgs(["repair", "terminal-event", "--db", "x.db", "--apply", "exec-1"]);
    expect(p.positionals).toEqual(["terminal-event", "exec-1"]);
    expect(p.flags.apply).toBe("true");
    expect(p.flags.db).toBe("x.db");
    expect(parseArgs(["logs", "--db", "x", "--json", "e1"]).positionals).toEqual(["e1"]);
  });

  it("supports --flag=value and --", () => {
    const p = parseArgs(["debug", "--db=x.db", "--at=3", "--", "--weird-id"]);
    expect(p.flags.db).toBe("x.db");
    expect(p.flags.at).toBe("3");
    expect(p.positionals).toEqual(["--weird-id"]);
  });

  it("rejects an unknown flag and suggests the nearest", () => {
    expect(() => parseArgs(["recover", "--db", "x", "--aply"])).toThrow(
      /unknown flag --aply \(did you mean --apply\?\)/
    );
    expect(() => parseArgs(["recover", "--db", "x", "--zzzzzz"])).toThrow(/unknown flag --zzzzzz$/);
  });

  it("validates ints and durations where they are typed", () => {
    expect(() => parseArgs(["debug", "--at", "abc"])).toThrow(
      /--at expects a non-negative integer/
    );
    expect(() => parseArgs(["debug", "--at", "-1"])).toThrow(UsageError);
    expect(() => parseArgs(["retention", "run", "--ttl", "soon"])).toThrow(
      /--ttl expects a duration/
    );
    expect(parseArgs(["retention", "run", "--ttl", "30d"]).flags.ttl).toBe("30d");
    expect(parseArgs(["retention", "run", "--ttl", "500"]).flags.ttl).toBe("500");
  });

  it("a value flag with no value, or a boolean given one, is an error", () => {
    expect(() => parseArgs(["debug", "--db"])).toThrow(UsageError);
    expect(() => parseArgs(["recover", "--apply=yes"])).toThrow(UsageError);
  });

  it("holds only what was typed — no inherited members, no prototype pollution", () => {
    const { flags } = parseArgs(["debug", "--db", "x.db"]);
    for (const k of ["valueOf", "constructor", "toString", "hasOwnProperty"]) {
      expect(flags[k], k).toBeUndefined();
    }
    expect(() => parseArgs(["debug", "--__proto__", "x"])).toThrow(UsageError);
  });

  it("an unknown command parses loosely so the dispatcher can name it", () => {
    expect(parseArgs(["logz", "--db", "x"]).command).toBe("logz");
  });

  it("every declared kind is one of the known four (the table W3 will read)", () => {
    for (const [name, spec] of Object.entries(COMMANDS)) {
      for (const [flag, kind] of Object.entries(spec.flags)) {
        expect(["boolean", "string", "int", "duration"], `${name} --${flag}`).toContain(kind);
      }
    }
  });
});

describe("did-you-mean", () => {
  it("editDistance", () => {
    expect(editDistance("aply", "apply")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
  });
  it("suggest returns undefined when nothing is close", () => {
    expect(suggest("xyzxyzxyz", ["apply", "stale"])).toBeUndefined();
    expect(suggest("stael", ["apply", "stale"])).toBe("stale");
  });

  it("--help / -h are handled by the dispatcher before parsing (help.test.ts), not flags", () => {
    // parseArgs sees them only if a caller skips the dispatcher; they are then plain unknown flags.
    expect(() => parseArgs(["logs", "--help"])).toThrow(/unknown flag --help/);
  });

  it("a value-looking token gets the `--` hint; short flags only suggest within distance 1", () => {
    expect(() => parseArgs(["debug", "--db", "x", "-5"])).toThrow(/put -- before it/);
    expect(() => parseArgs(["recover", "-ab"])).toThrow(/put -- before it/);
    // `-l` is distance 4 from `--limit`'s 5 letters: no suggestion for a 1-char flag.
    expect(() => parseArgs(["recover", "-l"])).not.toThrow(/did you mean/);
    expect(() => parseArgs(["recover", "--aply"])).toThrow(/did you mean --apply/);
  });

  it("a value flag given twice is a usage error; a repeated boolean is harmless", () => {
    expect(() => parseArgs(["debug", "--db", "a", "--db", "b"])).toThrow(
      /--db given more than once/
    );
    expect(() => parseArgs(["debug", "--db=a", "--db", "b"])).toThrow(/given more than once/);
    expect(() => parseArgs(["repair", "--apply", "--apply"])).not.toThrow();
  });
});
