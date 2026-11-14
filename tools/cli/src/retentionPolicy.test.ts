import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@loomwork/core";
import { SqliteContentStore, SqliteEventStore, SqliteSnapshotStore } from "@loomwork/plugin-sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "./args";
import { run } from "./cli";
import { loadRetentionPolicy, overridePolicy, parseTtlFlag } from "./retentionPolicy";
import { loadLoomApp } from "./stores";

// ADR 0145 - `--policy <module>` on `loom retention run` and `loom sweep content`.

const DAY = 86_400_000;
const old = Date.now() - 90 * DAY;

function ev(sequence: number, eventType: string, payload: unknown): EventEnvelope {
  return {
    id: `done-${sequence}`,
    executionId: "done",
    workflowId: "wf",
    eventType,
    sequence,
    timestamp: old + sequence,
    payload,
  } as EventEnvelope;
}

describe("loom --policy (ADR 0145)", () => {
  let dir: string;
  let db: string;
  let snap: string;
  let contentDb: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "loom-policy-"));
    db = join(dir, "events.db");
    snap = join(dir, "snap.db");
    contentDb = join(dir, "content.db");
    const events = new SqliteEventStore(db);
    await events.append(ev(0, "EXECUTION_STARTED", { input: {} }));
    await events.append(ev(1, "EXECUTION_COMPLETED", { output: {} }));
    await events.close();
    await new SqliteSnapshotStore(snap).close();
    await new SqliteContentStore(contentDb).close();
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

  const module = (name: string, source: string): string => {
    const file = join(dir, name);
    writeFileSync(file, source);
    return file;
  };
  async function logLength(): Promise<number> {
    const events = new SqliteEventStore(db);
    const n = (await events.read("done")).length;
    await events.close();
    return n;
  }

  describe("loadRetentionPolicy", () => {
    it("reads the named export `retention` (CommonJS)", async () => {
      const file = module(
        "named.cjs",
        "exports.retention = { terminalTtlMs: 5, content: { unpinnedAfterMs: 9 } };"
      );
      expect(await loadRetentionPolicy(file)).toEqual({
        terminalTtlMs: 5,
        content: { unpinnedAfterMs: 9 },
      });
    });

    it("reads the default export, and prefers `retention` when both exist", async () => {
      const onlyDefault = module(
        "default.cjs",
        "module.exports = { default: { terminalTtlMs: 7 } };"
      );
      expect(await loadRetentionPolicy(onlyDefault)).toEqual({ terminalTtlMs: 7 });
      const both = module(
        "both.cjs",
        "exports.retention = { terminalTtlMs: 1 }; exports.default = { terminalTtlMs: 2 };"
      );
      expect(await loadRetentionPolicy(both)).toEqual({ terminalTtlMs: 1 });
    });

    it("reads an ES module's named and default exports", async () => {
      const named = module("named.mjs", "export const retention = { terminalTtlMs: 11 };");
      expect(await loadRetentionPolicy(named)).toEqual({ terminalTtlMs: 11 });
      const dflt = module("default.mjs", "export default { terminalTtlMs: 13 };");
      expect(await loadRetentionPolicy(dflt)).toEqual({ terminalTtlMs: 13 });
    });

    it("re-validates a plain literal that never went through retentionPolicy()", async () => {
      const file = module("bad.cjs", "exports.retention = { terminalTtlMs: -1 };");
      await expect(loadRetentionPolicy(file)).rejects.toThrow(UsageError);
      const typo = module("typo.cjs", "exports.retention = { terminalTtlMs: 1, snapshot: {} };");
      await expect(loadRetentionPolicy(typo)).rejects.toThrow(/unknown key "snapshot"/);
    });

    it("an explicit `retention = null` is refused, not skipped to the default export", async () => {
      const file = module(
        "null.cjs",
        "exports.retention = null; exports.default = { terminalTtlMs: 3 };"
      );
      await expect(loadRetentionPolicy(file)).rejects.toThrow(UsageError);
      await expect(loadRetentionPolicy(file)).rejects.toThrow(/must be an object/);
      const undef = module(
        "undef.cjs",
        "exports.retention = undefined; exports.default = { terminalTtlMs: 3 };"
      );
      await expect(loadRetentionPolicy(undef)).rejects.toThrow(/retention export is undefined/);
    });

    it("a CommonJS `module.exports = { terminalTtlMs }` is the default export", async () => {
      const file = module("cjs-default.cjs", "module.exports = { terminalTtlMs: 17 };");
      expect(await loadRetentionPolicy(file)).toEqual({ terminalTtlMs: 17 });
    });

    it("a default export that is an app/config is refused with a message to export `retention`", async () => {
      const file = module("app.cjs", "module.exports = { default: { stores: {}, flows: [] } };");
      await expect(loadRetentionPolicy(file)).rejects.toThrow(UsageError);
      await expect(loadRetentionPolicy(file)).rejects.toThrow(
        /default export is not a retention policy.*export `retention`/
      );
      const esm = module("app.mjs", "export default { stores: {}, tools: [] };");
      await expect(loadRetentionPolicy(esm)).rejects.toThrow(/export `retention`/);
    });

    it("an object `{ retention }` as the default export is unwrapped", async () => {
      const file = module(
        "wrapped.cjs",
        "module.exports = { default: { retention: { terminalTtlMs: 4 } } };"
      );
      expect(await loadRetentionPolicy(file)).toEqual({ terminalTtlMs: 4 });
    });

    it("returns the frozen validated snapshot, never the module's raw object (getter TOCTOU)", async () => {
      const file = module(
        "getter.cjs",
        `let n = 0;
         exports.retention = {
           get terminalTtlMs() { return n++ === 0 ? 5 : -1; },
         };`
      );
      const p = await loadRetentionPolicy(file);
      expect(p).toEqual({ terminalTtlMs: 5 });
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(p, "terminalTtlMs")?.get).toBeUndefined();
    });

    it("loads under the SAME env guards as --config: no autostart, quiet, restored, serialised", async () => {
      const file = module(
        "both.cjs",
        `(globalThis.__seen ??= []).push([process.env.LOOM_NO_AUTOSTART, process.env.LOOM_QUIET]);
         exports.retention = { terminalTtlMs: 2 };
         exports.default = { stores: {} };`
      );
      const g = globalThis as { __seen?: unknown[] };
      g.__seen = [];
      Reflect.deleteProperty(process.env, "LOOM_NO_AUTOSTART");
      Reflect.deleteProperty(process.env, "LOOM_QUIET");
      const [policy] = await Promise.all([loadRetentionPolicy(file), loadLoomApp(file)]);
      expect(policy).toEqual({ terminalTtlMs: 2 });
      // The module evaluated once (first load wins the cache), and it saw the guards.
      expect(g.__seen).toEqual([["1", "1"]]);
      expect(process.env.LOOM_NO_AUTOSTART).toBeUndefined();
      expect(process.env.LOOM_QUIET).toBeUndefined();
      Reflect.deleteProperty(g, "__seen");
    });

    it("a module with no policy export is a usage error naming the fix", async () => {
      const file = module("empty.cjs", "exports.other = 1;");
      await expect(loadRetentionPolicy(file)).rejects.toThrow(UsageError);
      await expect(loadRetentionPolicy(file)).rejects.toThrow(/export const retention/);
    });
  });

  describe("overridePolicy", () => {
    it("--ttl replaces the field and the result is re-validated", () => {
      expect(overridePolicy({ terminalTtlMs: 5 }, { terminalTtlMs: 0 })).toEqual({
        terminalTtlMs: 0,
      });
      const p = { terminalTtlMs: 5, content: { unpinnedAfterMs: 9 } };
      expect(() => overridePolicy(p, { terminalTtlMs: 10 })).toThrow(/must be >= terminalTtlMs/);
      expect(overridePolicy(p, { unpinnedAfterMs: 5 })).toEqual({
        terminalTtlMs: 5,
        content: { unpinnedAfterMs: 5 },
      });
      expect(() => overridePolicy(p, { unpinnedAfterMs: 4 })).toThrow(UsageError);
    });
  });

  describe("parseTtlFlag", () => {
    it("parses durations and refuses a non-finite or oversized value", () => {
      expect(parseTtlFlag("2d")).toBe(2 * DAY);
      expect(parseTtlFlag("0")).toBe(0);
      expect(() => parseTtlFlag("9".repeat(400))).toThrow(UsageError);
      expect(() => parseTtlFlag("9".repeat(400))).toThrow(/too large/);
    });
  });

  describe("loom retention run --policy", () => {
    const args = (...extra: string[]) => ["retention", "run", "--db", db, "--snap", snap, ...extra];

    it("takes the TTL from the policy: a long TTL keeps, a zero TTL reclaims", async () => {
      const long = module("long.cjs", `exports.retention = { terminalTtlMs: ${365 * DAY} };`);
      expect(await run(args("--policy", long, "--apply"))).toBe(0);
      expect(out.join("\n")).toContain(`ttl ${365 * DAY}ms`);
      expect(out.join("\n")).toContain("kept");
      expect(await logLength()).toBe(2);

      const zero = module("zero.cjs", "exports.retention = { terminalTtlMs: 0 };");
      expect(await run(args("--policy", zero, "--apply"))).toBe(0);
      expect(await logLength()).toBe(0);
    });

    it("--ttl overrides the policy's field", async () => {
      const long = module("long.cjs", `exports.retention = { terminalTtlMs: ${365 * DAY} };`);
      expect(await run(args("--policy", long, "--ttl", "0", "--apply"))).toBe(0);
      expect(out.join("\n")).toContain("ttl 0ms");
      expect(await logLength()).toBe(0);
    });

    it("an override that breaks a rule is refused (exit 2) and reclaims nothing", async () => {
      const file = module(
        "content.cjs",
        `exports.retention = { terminalTtlMs: 1, content: { unpinnedAfterMs: ${30 * DAY} } };`
      );
      expect(await run(args("--policy", file, "--ttl", "90d", "--apply"))).toBe(2);
      expect(err.join("\n")).toContain("must be >= terminalTtlMs");
      expect(await logLength()).toBe(2);
    });

    it("a 400-digit --ttl is a usage error (exit 2) with and without --policy, and reclaims nothing", async () => {
      const huge = "9".repeat(400);
      expect(await run(args("--ttl", huge, "--apply"))).toBe(2);
      expect(err.join("\n")).toContain("too large");
      err.length = 0;
      const file = module("p.cjs", "exports.retention = { terminalTtlMs: 0 };");
      expect(await run(args("--policy", file, "--ttl", huge, "--apply"))).toBe(2);
      expect(err.join("\n")).toContain("too large");
      expect(await logLength()).toBe(2);
    });

    it("an invalid policy module is refused and reclaims nothing", async () => {
      const file = module("bad.cjs", "exports.retention = { terminalTtlMs: 1.5 };");
      expect(await run(args("--policy", file, "--apply"))).toBe(2);
      expect(err.join("\n")).toContain("terminalTtlMs must be a finite integer");
      expect(await logLength()).toBe(2);
    });

    it("a snapshots section is validated but not applied by this command, and says so", async () => {
      const file = module(
        "snaps.cjs",
        "exports.retention = { terminalTtlMs: 0, snapshots: { keepLatest: 2 } };"
      );
      expect(await run(args("--policy", file))).toBe(0);
      expect(out.join("\n")).toContain("snapshots.keepLatest is not applied by `retention run`");
    });

    it("without --policy the output carries no policy note (absence changes nothing)", async () => {
      expect(await run(args("--ttl", "0"))).toBe(0);
      expect(out.join("\n")).not.toContain("snapshots.keepLatest");
    });

    it("neither --ttl nor --policy is still refused (exit 2) and reclaims nothing", async () => {
      expect(await run(args("--apply"))).toBe(2);
      expect(err.join("\n")).toContain("--ttl");
      expect(await logLength()).toBe(2);
    });
  });

  describe("loom sweep content --policy", () => {
    const args = (...extra: string[]) => [
      "sweep",
      "content",
      "--db",
      db,
      "--snap",
      snap,
      "--content",
      contentDb,
      ...extra,
    ];

    it("takes the TTL from policy.content.unpinnedAfterMs", async () => {
      const file = module(
        "c.cjs",
        `exports.retention = { terminalTtlMs: 1, content: { unpinnedAfterMs: ${7 * DAY} } };`
      );
      expect(await run(args("--policy", file))).toBe(0);
      expect(out.join("\n")).toContain(`ttl ${7 * DAY}ms`);
    });

    it("--ttl overrides it", async () => {
      const file = module(
        "c.cjs",
        `exports.retention = { terminalTtlMs: 1, content: { unpinnedAfterMs: ${7 * DAY} } };`
      );
      expect(await run(args("--policy", file, "--ttl", "3d"))).toBe(0);
      expect(out.join("\n")).toContain(`ttl ${3 * DAY}ms`);
    });

    it("a policy with no content section is refused (exit 2) unless --ttl is given", async () => {
      const noContent = module("n.cjs", "exports.retention = { terminalTtlMs: 1 };");
      expect(await run(args("--policy", noContent))).toBe(2);
      expect(err.join("\n")).toContain("no `content` section");
      expect(err.join("\n")).toContain("--ttl");
      expect(out.join("\n")).not.toContain("content sweep");
      out.length = 0;
      // --ttl supplies the content TTL (3d >= the policy's 1ms log TTL), so the sweep runs with it.
      expect(await run(args("--policy", noContent, "--ttl", "3d"))).toBe(0);
      expect(out.join("\n")).toContain(`ttl ${3 * DAY}ms`);
    });

    it("a 400-digit --ttl with --policy is a usage error", async () => {
      const file = module(
        "c.cjs",
        `exports.retention = { terminalTtlMs: 1, content: { unpinnedAfterMs: ${7 * DAY} } };`
      );
      expect(await run(args("--policy", file, "--ttl", "9".repeat(400)))).toBe(2);
    });

    it("without --policy the default is unchanged", async () => {
      expect(await run(args())).toBe(0);
      expect(out.join("\n")).toContain(`ttl ${30 * DAY}ms`);
    });

    it("an invalid override is refused: --ttl shorter than the policy's log TTL", async () => {
      const file = module(
        "c.cjs",
        `exports.retention = { terminalTtlMs: ${10 * DAY}, content: { unpinnedAfterMs: ${20 * DAY} } };`
      );
      expect(await run(args("--policy", file, "--ttl", "5d"))).toBe(2);
      expect(err.join("\n")).toContain("must be >= terminalTtlMs");
    });
  });
});
