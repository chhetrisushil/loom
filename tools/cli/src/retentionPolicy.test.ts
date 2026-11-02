import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelope } from "@loom/core";
import { SqliteContentStore, SqliteEventStore, SqliteSnapshotStore } from "@loom/plugin-sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "./args";
import { run } from "./cli";
import { loadRetentionPolicy, overridePolicy } from "./retentionPolicy";

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

    it("--ttl overrides it; a policy without a content section leaves the 30d default", async () => {
      const file = module(
        "c.cjs",
        `exports.retention = { terminalTtlMs: 1, content: { unpinnedAfterMs: ${7 * DAY} } };`
      );
      expect(await run(args("--policy", file, "--ttl", "3d"))).toBe(0);
      expect(out.join("\n")).toContain(`ttl ${3 * DAY}ms`);
      out.length = 0;
      const noContent = module("n.cjs", "exports.retention = { terminalTtlMs: 1 };");
      expect(await run(args("--policy", noContent))).toBe(0);
      expect(out.join("\n")).toContain(`ttl ${30 * DAY}ms`);
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
