import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cmdCensus } from "./census";
import { cmdRetentionRun } from "./retention";
import { resolveStores } from "./stores";

// ── S3 — a diagnostic runs on the storage the APP wired ──────────────────────
//
// The point of `--config` is that the CLI knows no backends. The cheapest proof of that is a
// config wired to stores that are not SQLite at all: if anything in the path assumed the
// shape the commands were written against, this cannot pass.
//
// The temp module lives INSIDE the repo so `import "@loom/app"` resolves through the
// workspace's node_modules, the same way a built app in a deployment resolves its deps.

const SCRATCH = join(__dirname, "..", ".tmp-config-test");

function writeConfig(name: string, body: string): string {
  const file = join(SCRATCH, name);
  writeFileSync(file, body);
  return file;
}

/** A config module whose storage is in-memory, seeded with two stuck executions. */
const IN_MEMORY_APP = `
import { defineConfig } from "@loom/app";
import { InMemoryAsyncEventStore } from "@loom/event-runtime/memory";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";

const eventStore = new InMemoryAsyncEventStore();
const started = (id, ageMs) => ({
  id: id + "-0", executionId: id, workflowId: "wf", eventType: "EXECUTION_STARTED",
  sequence: 0, timestamp: Date.now() - ageMs, payload: { input: {} },
});
await eventStore.append(started("stuck-a", 7 * 3600000));
await eventStore.append(started("stuck-b", 7 * 3600000));

export default defineConfig({
  storage: { kind: "custom", eventStore, snapshotStore: new InMemoryAsyncSnapshotStore() },
});
`;

describe("S3 — resolving stores from a composition", () => {
  beforeEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
  });
  afterEach(() => rmSync(SCRATCH, { recursive: true, force: true }));

  it("takes a census over stores that are not SQLite", async () => {
    const out = await cmdCensus({ config: writeConfig("app.mjs", IN_MEMORY_APP) });
    expect(out).toContain("2 execution(s) scanned, 2 in flight");
    expect(out).toContain("in flight ≥ 6h");
  });

  it("says a config wires no lease store — not that coverage is zero", async () => {
    const out = await cmdCensus({ config: writeConfig("app2.mjs", IN_MEMORY_APP) });
    // The fix for this is in the app (`timers.leases`), not at the prompt — so the message
    // must not be the one about a missing flag.
    expect(out).toContain("timers.leases");
    expect(out).not.toContain("--leases");
    expect(out).not.toContain("lease held");
  });

  it("surfaces the lease store the app wired, and starts nothing by importing it", async () => {
    const withLeases = writeConfig(
      "app3.mjs",
      `${IN_MEMORY_APP.replace(
        "export default defineConfig({",
        `import { InMemoryLeaseStore, InMemoryTimerStore } from "@loom/event-runtime";
export const timerStore = new InMemoryTimerStore();
export default defineConfig({
  timers: { store: timerStore, pollMs: 1, leases: { store: new InMemoryLeaseStore(), owner: "node-a" } },`
      )}`
    );
    const stores = await resolveStores({ config: withLeases });
    expect(stores.leaseStore).toBeDefined();
    expect(stores.timerStore).toBeDefined();
    expect(stores.origin).toBe("config");

    // Importing a deployment's config must not begin polling it. `pollMs: 1` means a started
    // service would have polled many times over by now.
    const polls: number[] = [];
    const timers = stores.timerStore as { due: (now: number) => Promise<unknown[]> };
    const original = timers.due.bind(timers);
    timers.due = async (now: number) => {
      polls.push(now);
      return await original(now);
    };
    await new Promise((r) => setTimeout(r, 30));
    expect(polls).toEqual([]);
    await stores.close();
  });

  it("refuses without either flag rather than guessing a default database", async () => {
    await expect(resolveStores({})).rejects.toThrow(/--config|--db/);
  });

  it("sweeps retention over the same non-SQLite stores", async () => {
    const out = await cmdRetentionRun({
      config: writeConfig("app4.mjs", IN_MEMORY_APP),
      ttlMs: 0,
      apply: false,
    });
    expect(out).toContain("DRY RUN");
    expect(out).toContain("2 execution(s)");
    // R5.3 is off because this app wires no branchRegistry — and the warning must say THAT,
    // not name a flag the operator would then pass to no effect.
    expect(out).toContain("this app wires no branchRegistry");
    expect(out).not.toContain("--branches");
  });
});

// ADR 0055 D6 — under --config, `loom sweep content --orphans` scans the archive the app wired
// (`durability.retention.archive`), so an archived run's evidence is not an orphan.
describe("sweep content --orphans honours the config's retention archive", () => {
  beforeEach(() => {
    rmSync(SCRATCH, { recursive: true, force: true });
    mkdirSync(SCRATCH, { recursive: true });
  });
  afterEach(() => rmSync(SCRATCH, { recursive: true, force: true }));

  it("keeps a blob cited only by an archived run, and needs no --no-archive", async () => {
    const { SqliteContentStore } = await import("@loom/plugin-sqlite");
    const { cmdSweepContent } = await import("./sweepContent");
    const contentDb = join(SCRATCH, "content.db");
    const old = Date.now() - 60 * 24 * 3_600_000;
    const content = new SqliteContentStore(contentDb, { now: () => old });
    const evidence = await content.put(new TextEncoder().encode("archived finding's evidence"));
    const orphan = await content.put(new TextEncoder().encode("cited by nothing"));
    await content.close();
    const config = writeConfig(
      "archived.mjs",
      `
import { defineConfig } from "@loom/app";
import { InMemoryAsyncEventStore } from "@loom/event-runtime/memory";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";

const archiveEvents = new InMemoryAsyncEventStore();
await archiveEvents.append({
  id: "a-0", executionId: "month-1", workflowId: "wf", eventType: "EXECUTION_STARTED",
  sequence: 0, timestamp: ${old}, payload: { input: {} },
});
await archiveEvents.append({
  id: "a-1", executionId: "month-1", workflowId: "wf", eventType: "FINDING_RECORDED",
  sequence: 1, timestamp: ${old}, payload: { evidence: [{ __loomContent: "${evidence.__loomContent}" }] },
});
export default defineConfig({
  storage: { kind: "custom", eventStore: new InMemoryAsyncEventStore(), snapshotStore: new InMemoryAsyncSnapshotStore() },
  durability: { retention: { archive: { eventStore: archiveEvents, snapshotStore: new InMemoryAsyncSnapshotStore() } } },
});
`
    );
    const out = await cmdSweepContent({
      config,
      content: contentDb,
      ttlMs: 30 * 24 * 3_600_000,
      apply: true,
      orphans: true,
      snapshotsTouchContent: true,
    });
    expect(out).toContain("reclaimed orphans (1)");
    expect(out).toContain(orphan.__loomContent);
    expect(out).not.toMatch(/no --archive-db/);
    const check = new SqliteContentStore(contentDb);
    expect(await check.get(evidence)).not.toBeNull();
    expect(await check.get(orphan)).toBeNull();
    await check.close();
  });
});
