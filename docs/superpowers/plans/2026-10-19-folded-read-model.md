# Folded-State Read Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second model kind to `@loom/plugin-read-model` — a durable, per-execution folded-state projection (`registerFolded`, `getMany`, `getManyByKey`, `refresh`, `purgeFolded`) — with in-memory, SQLite and Postgres backends and a conformance kit, a sensitive-state guard (a folded model must not persist plaintext sensitive data) and a bounded live-path state cache.

**Architecture:** The fold is the existing `ProjectionDefinition` (`projection$`). One state row per `(modelId, executionId)` whose `sequence` IS the watermark, written by a monotonic compare-and-set so nodes converge without locks. A `FoldedModelEngine` (pure core, new file) owns registration, contiguity, per-execution serialization and reads; `ReadModelService` delegates to it and shares the existing `onEvent` seam and catch-up scan. Backends gain five OPTIONAL store methods (SPI 1.1.0 → 1.2.0). Fold input is a masked view of the event and every new state passes a pure persist-time check (D11); a per-node LRU of fold bases removes the read before each live apply while the store's CAS stays the authority (D15).

**Tech Stack:** TypeScript, vitest, better-sqlite3, node-postgres, pnpm/turbo, biome.

**Spec:** `docs/adr/0132-folded-state-read-model.md` (decisions D1–D15). Read it first; tasks cite decisions by number.

## Global Constraints

- No kernel change: `KERNEL_ABI` and `EVENT_SCHEMA` untouched; no `@loom/app`, `@loom/core` or event-type edits. Layering guard intact (plugins never imported by kernel packages).
- `READ_MODEL_STORE_SPI_VERSION` becomes `"1.2.0"`; the five new store methods are OPTIONAL (`beginFold?`, `applyFolded?`, `getFolded?`, `getFoldedByKey?`, `purgeFolded?`).
- A folded model is a cache of the log: rebuild == incremental; nothing reads it on replay.
- Fold `version` is REQUIRED (non-blank after trim); a changed version rebuilds the model automatically (D5). The version written to the store is `version` plus a digest of the declared sensitive map (D11).
- Sensitive-state guard (D11): handlers get a masked copy of the event; a state holding a cipher envelope or a value lifted from a sensitive path is refused with `SensitiveStateError` (never carries a value); `@loom/classify` becomes a dependency of `@loom/plugin-read-model` (masking only; the `__loomEnc` shape rule of ADR 0130 D2 is re-implemented locally, not imported from the crypto plugin); no off switch.
- State cache (D15): write-path only, default 1024 entries, `foldCache: false` disables; the store's CAS is the authority; `getMany` / `getManyByKey` / `refresh` never read it. Tests prove it with counted store reads, never timing.
- `getMany*` is capped at `MAX_GET_MANY = 1000` keys.
- Tests: wait on conditions (`service.drain()`, `until`), never fixed sleeps; no `performance.now()` in `*.test.ts`; Postgres suites gated on `LOOM_TEST_POSTGRES_URL` (never print its value); every package with tests keeps its `tsconfig.test.json` (`pnpm typecheck:tests`).
- **ONE draft PR PER TASK** (owner decision Q9): each task is <= 200 changed lines and <= 10 files and ships as its own DRAFT PR, stacked in task order (task N's branch is based on task N-1's, or on the task it depends on), merged in order with `gh pr merge --rebase` only; after each merge, rebase the next branch onto `main`. Never squash, never a merge commit.
- Use `command ls`, never bare `ls`, in shell steps.
- **Local verify (every task runs its package tests; the full line below before any PR is marked ready, and at the close-out):** `pnpm build && npx turbo test --force --concurrency=2 && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
|---|---|
| `plugins/read-model/src/types.ts` (modify) | Folded types, optional store methods, SPI 1.2.0, error classes, `assertManyKeys` |
| `plugins/read-model/src/FoldedModelEngine.ts` (create) | Registration, contiguity, serialization, fold, reads, refresh, purge — no I/O of its own |
| `plugins/read-model/src/sensitiveState.ts` (create) | Pure persist-time check: `assertStateClean`, `SensitiveStateError`, bounded walk, `Lifted` (D11) |
| `plugins/read-model/src/sensitiveInput.ts` (create) | Pure fold input: `sensitivePathsFor`, `foldView` (mask + lift) (D11) |
| `plugins/read-model/src/sensitiveConfig.ts` (create) | `sensitiveMapFromCovers`, `mergeSensitive`, `effectiveFoldVersion` (D5, D11) |
| `plugins/read-model/src/foldStateCache.ts` (create) | Pure bounded LRU of fold bases (D15) |
| `plugins/read-model/src/ReadModelService.ts` (modify) | `registerFolded`, live fan-out, shared catch-up scan, delegation, pins, rebuild, `sensitive` / `foldCache` options |
| `plugins/read-model/src/InMemoryReadModelStore.ts` (modify) | Reference folded methods |
| `plugins/read-model/src/foldedFixtures.ts` (create) | Test-only ingest-status projection + event helpers (excluded from `index.ts`) |
| `packages/conformance/src/foldedState.ts` (create) | `runFoldedStateConformance` |
| `plugins/sqlite/src/SqliteReadModelStore.ts` (modify) | SQLite folded methods |
| `plugins/postgres/src/foldedState.ts` (create) | Identifier validation, DDL builder, table ensure (pure + thin) |
| `plugins/postgres/src/PostgresReadModelStore.ts` (modify) | Options arg, folded methods |
| `docs/plugins.md`, `docs/compliance.md`, `docs/data-classification.md`, `docs/api-reference.org`, `docs/README.md` (modify) | User docs |

Task order: 1 → 2 → 3 → 4a → 4b → 5a → 5b → 5c → 6a → 6b → 6c → 7a → 7b → 8 → 9 → 10 → 11 → 12a → 12b → 13a → 13b. Task 5a, 5b and 6a depend only on Task 1 (pure modules) and may start as soon as it merges; 5c needs 4a/4b and 5a/5b; 6b needs 5c and 6a; 7a needs 6c; Task 9 needs 7b. Tasks 11, 12a and 12b depend only on Tasks 1–3 (the store SPI and the kit) and may run in parallel with 4a–10, each as its own stacked PR on Task 3.

---

### Task 1: Folded types and SPI 1.2.0 (D1, D6, D7)

**Files:**
- Modify: `plugins/read-model/src/types.ts`
- Modify: `plugins/read-model/src/index.ts`
- Create: `plugins/read-model/src/foldedTypes.test.ts`

**Interfaces:**
- Produces: `FoldedReadModelDefinition<S>` (with optional `sensitive`), `FoldedRecord`, `FoldBase`, `FoldedApply`, `FoldedApplyResult`, `FoldedSelector`, `FoldedState<S>`, `SensitiveMap`, `FoldCacheOptions`, `DEFAULT_FOLD_CACHE_ENTRIES`, `FoldedEngineOptions`, `MAX_GET_MANY`, `assertManyKeys(keys, what)`, `FoldedUnsupportedError`, `FoldGapError`, `FoldVersionMismatchError`, optional `ReadModelStore` methods, `READ_MODEL_STORE_SPI_VERSION = "1.2.0"`.

- [ ] **Step 1: Write the failing test** — `plugins/read-model/src/foldedTypes.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_FOLD_CACHE_ENTRIES, MAX_GET_MANY, READ_MODEL_STORE_SPI_VERSION, assertManyKeys } from "./types";

describe("folded SPI types (ADR 0132 D6/D7)", () => {
  it("bumps the SPI to 1.2.0", () => {
    expect(READ_MODEL_STORE_SPI_VERSION).toBe("1.2.0");
  });

  it("accepts an empty list and a full page of keys", () => {
    expect(() => assertManyKeys([], "getMany")).not.toThrow();
    expect(() => assertManyKeys(Array.from({ length: MAX_GET_MANY }, (_, i) => `k${i}`), "getMany")).not.toThrow();
  });

  it("refuses more than MAX_GET_MANY keys with a RangeError", () => {
    const keys = Array.from({ length: MAX_GET_MANY + 1 }, (_, i) => `k${i}`);
    expect(() => assertManyKeys(keys, "getMany")).toThrow(RangeError);
  });

  it("refuses blank keys: a computed-but-empty key must not match everything or nothing", () => {
    expect(() => assertManyKeys(["a", ""], "getManyByKey")).toThrow(TypeError);
  });

  it("defaults the per-node fold cache to 1024 entries (ADR 0132 D15)", () => {
    expect(DEFAULT_FOLD_CACHE_ENTRIES).toBe(1024);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `pnpm --filter @loom/plugin-read-model exec vitest run src/foldedTypes.test.ts`
Expected: FAIL (`MAX_GET_MANY` / `assertManyKeys` not exported).

- [ ] **Step 3: Implement** — in `types.ts`, change the first import to `import type { EventEnvelope, ProjectionDefinition } from "@loom/core";`, change the version constant to `"1.2.0"` and extend its doc comment with `- 1.2.0: five optional folded-state methods (ADR 0132); clear() also drops folded state.`, then append:

```ts
// ── ADR 0132 — folded-state read models ──────────────────────────────────────

/** A folded model: the `projection$` fold plus pure id-derived key/scope (D1, D2). */
export interface FoldedReadModelDefinition<TState = unknown> {
  /** id, version (REQUIRED here), initialState, handlers — straight from `projection$`. */
  projection: ProjectionDefinition<TState>;
  /** App key (e.g. documentId) derived from the executionId ONLY — never from event data. */
  keyOf?: (executionId: string) => string | undefined;
  /** Tenant/RLS scope derived from the executionId ONLY. */
  scopeOf?: (executionId: string) => string | undefined;
  /** Payload dot-paths a handler must never see (ADR 0132 D11); unioned with the service's `sensitive`. */
  sensitive?: SensitiveMap;
}

/** eventType -> payload dot-paths (`[]` wildcards allowed): the shape of `EncryptingEventStore`'s `sensitive` option. */
export type SensitiveMap = Readonly<Record<string, readonly string[]>>;

/** One stored folded state. `state === null` means "no handled event yet" or erased. */
export interface FoldedRecord {
  executionId: string;
  key: string | null;
  scope: string | null;
  /** The watermark: highest sequence folded into `state`. */
  sequence: number;
  state: unknown | null;
  erased: boolean;
}

/** What a fold starts from: a stored record, or a cached copy of one (ADR 0132 D15). */
export type FoldBase = Pick<FoldedRecord, "sequence" | "state" | "erased">;

export interface FoldedApply {
  modelId: string;
  executionId: string;
  upToSequence: number;
  state: unknown | null;
  key: string | null;
  scope: string | null;
  /** The writer's fold version; refused when the model header says otherwise. */
  foldVersion: string;
}

/** `stale` = an equal-or-lower sequence (idempotent re-apply or a lost race). */
export type FoldedApplyResult = "applied" | "stale" | "version-mismatch";

export type FoldedSelector = { executionId: string } | { key: string } | { scope: string };

/** What `getMany` / `getManyByKey` return per execution. */
export interface FoldedState<TState = unknown> {
  executionId: string;
  key: string | null;
  sequence: number;
  state: TState;
}

/** Hard ceiling on keys per batch read. */
export const MAX_GET_MANY = 1_000;

/** Validate a batch-read key list. Backends MUST route through this (SPI contract). */
export function assertManyKeys(keys: readonly string[], what: string): void {
  if (keys.length > MAX_GET_MANY) {
    throw new RangeError(`read-model ${what}: at most ${MAX_GET_MANY} keys per call (got ${keys.length})`);
  }
  for (const k of keys) {
    if (typeof k !== "string" || k === "") {
      throw new TypeError(`read-model ${what}: keys must be non-empty strings`);
    }
  }
}

/** Per-node state cache for the live apply path (ADR 0132 D15). */
export interface FoldCacheOptions {
  /** Max (model, execution) entries on this node. 0 disables. Default {@link DEFAULT_FOLD_CACHE_ENTRIES}. */
  maxEntries?: number;
}
export const DEFAULT_FOLD_CACHE_ENTRIES = 1_024;

/** Everything the engine needs beyond the store and `onError`. */
export interface FoldedEngineOptions {
  /** Fills a gap in the live tail (D4) — normally this node's own event store. */
  liveSource?: ReadModelEventSource;
  /** Service-wide sensitive paths (D11); unioned with each model's own. */
  sensitive?: SensitiveMap;
  /** `false` disables the state cache (D15). */
  cache?: FoldCacheOptions | false;
}

export class FoldedUnsupportedError extends Error {
  readonly name = "FoldedUnsupportedError";
  constructor(readonly modelId: string) {
    super(
      `read model "${modelId}": this backend does not implement the folded-state methods (ReadModelStore SPI ${READ_MODEL_STORE_SPI_VERSION}) — use InMemory/Sqlite/Postgres or implement beginFold/applyFolded/getFolded/getFoldedByKey/purgeFolded`
    );
  }
}

/** A gap in a live tail with no `liveSource` to fill it; the next catch-up heals it. */
export class FoldGapError extends Error {
  readonly name = "FoldGapError";
  constructor(
    readonly modelId: string,
    readonly executionId: string,
    readonly watermark: number,
    readonly sequence: number
  ) {
    super(
      `folded model "${modelId}": execution "${executionId}" is at ${watermark} but event ${sequence} arrived — run catchUp() or configure a liveSource`
    );
  }
}

/** This node's fold version is not the model's current one (a rolling deploy's old node). */
export class FoldVersionMismatchError extends Error {
  readonly name = "FoldVersionMismatchError";
  constructor(readonly modelId: string, readonly version: string) {
    super(`folded model "${modelId}": version "${version}" is not the store's current fold version — this node's apply was refused`);
  }
}
```

and add to the `ReadModelStore` interface, before `clear`:

```ts
  /**
   * OPTIONAL folded-state methods (SPI 1.2.0, ADR 0132). All five or none.
   * `beginFold`: create the model header, or — if `foldVersion` differs from the stored one —
   * delete the model's folded states and swap the header in ONE transaction (`rebuilt: true`).
   */
  beginFold?(modelId: string, foldVersion: string): Promise<{ rebuilt: boolean }>;
  /** Monotonic compare-and-set of one execution's state + watermark. See ADR 0132 D3. */
  applyFolded?(a: FoldedApply): Promise<FoldedApplyResult>;
  /** Records for the given executions (absent ones omitted), input order. Routes through `assertManyKeys`. */
  getFolded?(modelId: string, executionIds: readonly string[]): Promise<FoldedRecord[]>;
  /** Records whose `key` is in `keys`, ordered by executionId. Routes through `assertManyKeys`. */
  getFoldedByKey?(modelId: string, keys: readonly string[]): Promise<FoldedRecord[]>;
  /** Tombstone (`state = NULL, erased = true`, sequence KEPT); returns newly tombstoned count. */
  purgeFolded?(modelId: string, selector: FoldedSelector): Promise<number>;
```

Update the `clear` doc: "also drops the model's folded states and fold header". In `index.ts` add `MAX_GET_MANY, DEFAULT_FOLD_CACHE_ENTRIES, assertManyKeys, FoldedUnsupportedError, FoldGapError, FoldVersionMismatchError` to the value export list and `FoldedReadModelDefinition, FoldedRecord, FoldBase, FoldedApply, FoldedApplyResult, FoldedSelector, FoldedState, SensitiveMap, FoldCacheOptions, FoldedEngineOptions` to the type export list.

- [ ] **Step 4: Run, verify it passes**

Run: `pnpm --filter @loom/plugin-read-model exec vitest run src/foldedTypes.test.ts && pnpm --filter @loom/plugin-read-model build`
Expected: PASS, build clean.

- [ ] **Step 5: Commit**

```bash
git add plugins/read-model/src/types.ts plugins/read-model/src/index.ts plugins/read-model/src/foldedTypes.test.ts
git commit -m "feat(read-model): folded-state SPI types, SPI 1.2.0 (ADR 0132 D1/D6/D7)"
```
(append the Co-Authored-By trailer from Global Constraints)

---

### Task 2: Folded-state conformance kit (D3, D5, D6, D12)

**Files:**
- Create: `packages/conformance/src/foldedState.ts`
- Modify: `packages/conformance/src/index.ts` (one re-export line, near the other exports at the top)
- Modify: `plugins/read-model/src/conformance.test.ts`

**Interfaces:**
- Produces: `runFoldedStateConformance(factory: () => FoldedStateStoreLike, label?: string): void` and the structural `FoldedStateStoreLike`. Cases skip (not fail) for a store lacking the methods.

- [ ] **Step 1: Write the kit and wire it to the in-memory store (red)** — `packages/conformance/src/foldedState.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TestContext } from "vitest";

// ── Folded-state half of the ReadModelStore SPI (ADR 0132, SPI 1.2.0) ────────
// Structural, like runReadModelStoreConformance: no plugin dependency. Every case skips
// when the backend omits the (all-or-none) optional methods.

export interface FoldedRecordLike {
  executionId: string;
  key: string | null;
  scope: string | null;
  sequence: number;
  state: unknown | null;
  erased: boolean;
}
export interface FoldedApplyLike {
  modelId: string;
  executionId: string;
  upToSequence: number;
  state: unknown | null;
  key: string | null;
  scope: string | null;
  foldVersion: string;
}
type Selector = { executionId: string } | { key: string } | { scope: string };

export interface FoldedStateStoreLike {
  beginFold?(modelId: string, foldVersion: string): Promise<{ rebuilt: boolean }>;
  applyFolded?(a: FoldedApplyLike): Promise<"applied" | "stale" | "version-mismatch">;
  getFolded?(modelId: string, executionIds: readonly string[]): Promise<FoldedRecordLike[]>;
  getFoldedByKey?(modelId: string, keys: readonly string[]): Promise<FoldedRecordLike[]>;
  purgeFolded?(modelId: string, selector: Selector): Promise<number>;
  clear(modelId: string): Promise<void>;
}
type Full = Required<FoldedStateStoreLike>;

export function runFoldedStateConformance(
  factory: () => FoldedStateStoreLike,
  label = "ReadModelStore"
): void {
  const ap = (over: Partial<FoldedApplyLike> = {}): FoldedApplyLike => ({
    modelId: "m",
    executionId: "x-1",
    upToSequence: 1,
    state: { n: 1 },
    key: null,
    scope: null,
    foldVersion: "v1",
    ...over,
  });
  const open = async (ctx: TestContext): Promise<Full> => {
    const s = factory();
    if (
      s.beginFold === undefined ||
      s.applyFolded === undefined ||
      s.getFolded === undefined ||
      s.getFoldedByKey === undefined ||
      s.purgeFolded === undefined
    ) {
      return ctx.skip() as never;
    }
    await s.beginFold("m", "v1");
    return s as Full;
  };

  describe(`${label} conformance (folded state, ADR 0132)`, () => {
    it("beginFold: first/same version rebuild nothing; a new version drops only that model's states", async (ctx) => {
      const s = await open(ctx);
      expect(await s.beginFold("m", "v1")).toEqual({ rebuilt: false });
      await s.applyFolded(ap());
      await s.beginFold("other", "v1");
      await s.applyFolded(ap({ modelId: "other" }));
      expect(await s.beginFold("m", "v2")).toEqual({ rebuilt: true });
      expect(await s.getFolded("m", ["x-1"])).toEqual([]);
      expect(await s.getFolded("other", ["x-1"])).toHaveLength(1);
    });

    it("round-trips nested JSON state with key and scope; absent executions are omitted", async (ctx) => {
      const s = await open(ctx);
      const state = { status: "running", nested: { a: [1, null, "z"] } };
      expect(await s.applyFolded(ap({ key: "d1", scope: "u1", state }))).toBe("applied");
      expect(await s.getFolded("m", ["x-1", "missing"])).toEqual([
        { executionId: "x-1", key: "d1", scope: "u1", sequence: 1, state, erased: false },
      ]);
    });

    it("the watermark is monotonic: lower and equal sequences are stale and change nothing", async (ctx) => {
      const s = await open(ctx);
      expect(await s.applyFolded(ap({ upToSequence: 5, state: { n: 5 } }))).toBe("applied");
      expect(await s.applyFolded(ap({ upToSequence: 3, state: { n: 3 } }))).toBe("stale");
      expect(await s.applyFolded(ap({ upToSequence: 5, state: { n: 99 } }))).toBe("stale");
      expect((await s.getFolded("m", ["x-1"]))[0]).toMatchObject({ sequence: 5, state: { n: 5 } });
      expect(await s.applyFolded(ap({ upToSequence: 6, state: { n: 6 } }))).toBe("applied");
    });

    it("a watermark-only write (state null) round-trips as not-erased", async (ctx) => {
      const s = await open(ctx);
      await s.applyFolded(ap({ upToSequence: 4, state: null }));
      expect((await s.getFolded("m", ["x-1"]))[0]).toMatchObject({ sequence: 4, state: null, erased: false });
    });

    it("a later write that omits key/scope keeps the ones already stored", async (ctx) => {
      const s = await open(ctx);
      await s.applyFolded(ap({ key: "d1", scope: "u1" }));
      await s.applyFolded(ap({ upToSequence: 2, key: null, scope: null }));
      expect((await s.getFolded("m", ["x-1"]))[0]).toMatchObject({ key: "d1", scope: "u1", sequence: 2 });
    });

    it("refuses a writer whose fold version is not the header's, before and after a rebuild", async (ctx) => {
      const s = await open(ctx);
      expect(await s.applyFolded(ap({ foldVersion: "v0" }))).toBe("version-mismatch");
      expect(await s.getFolded("m", ["x-1"])).toEqual([]);
      await s.beginFold("m", "v2");
      expect(await s.applyFolded(ap({ foldVersion: "v1" }))).toBe("version-mismatch");
      expect(await s.applyFolded(ap({ foldVersion: "v2" }))).toBe("applied");
    });

    it("getFoldedByKey returns every execution sharing a key, ordered, isolated per model", async (ctx) => {
      const s = await open(ctx);
      await s.beginFold("other", "v1");
      await s.applyFolded(ap({ executionId: "x-2", key: "d1" }));
      await s.applyFolded(ap({ executionId: "x-1", key: "d1" }));
      await s.applyFolded(ap({ executionId: "x-3", key: "d2" }));
      await s.applyFolded(ap({ executionId: "x-4" })); // no key
      await s.applyFolded(ap({ modelId: "other", executionId: "x-9", key: "d1" }));
      const got = await s.getFoldedByKey("m", ["d1", "nope"]);
      expect(got.map((r) => r.executionId)).toEqual(["x-1", "x-2"]);
    });

    it("purgeFolded tombstones: state gone, sequence kept, later writes advance but never resurrect", async (ctx) => {
      const s = await open(ctx);
      await s.applyFolded(ap({ key: "d1", scope: "u1", upToSequence: 3 }));
      expect(await s.purgeFolded("m", { executionId: "x-1" })).toBe(1);
      expect(await s.purgeFolded("m", { executionId: "x-1" })).toBe(0); // retry finds nothing new
      expect((await s.getFolded("m", ["x-1"]))[0]).toMatchObject({ state: null, erased: true, sequence: 3 });
      expect(await s.applyFolded(ap({ upToSequence: 7, state: { n: 7 } }))).toBe("applied");
      expect((await s.getFolded("m", ["x-1"]))[0]).toMatchObject({ state: null, erased: true, sequence: 7 });
    });

    it("purgeFolded by key and by scope touches only matches, in that model only", async (ctx) => {
      const s = await open(ctx);
      await s.beginFold("other", "v1");
      await s.applyFolded(ap({ executionId: "x-1", key: "d1", scope: "u1" }));
      await s.applyFolded(ap({ executionId: "x-2", key: "d2", scope: "u1" }));
      await s.applyFolded(ap({ executionId: "x-3", key: "d3", scope: "u2" }));
      await s.applyFolded(ap({ modelId: "other", executionId: "x-1", key: "d1", scope: "u1" }));
      expect(await s.purgeFolded("m", { key: "d1" })).toBe(1);
      expect(await s.purgeFolded("m", { scope: "u1" })).toBe(1); // x-2 only; x-1 already erased
      const left = await s.getFolded("m", ["x-1", "x-2", "x-3"]);
      expect(left.filter((r) => !r.erased).map((r) => r.executionId)).toEqual(["x-3"]);
      expect((await s.getFolded("other", ["x-1"]))[0]?.erased).toBe(false);
    });

    it("clear drops states AND the header: writers are refused until beginFold runs again", async (ctx) => {
      const s = await open(ctx);
      await s.applyFolded(ap());
      await s.clear("m");
      expect(await s.getFolded("m", ["x-1"])).toEqual([]);
      expect(await s.applyFolded(ap())).toBe("version-mismatch");
      await s.beginFold("m", "v1");
      expect(await s.applyFolded(ap())).toBe("applied");
    });

    it("batch reads: empty is empty; more than 1000 keys is refused", async (ctx) => {
      const s = await open(ctx);
      expect(await s.getFolded("m", [])).toEqual([]);
      const many = Array.from({ length: 1001 }, (_, i) => `x-${i}`);
      await expect(s.getFolded("m", many)).rejects.toThrow();
      await expect(s.getFoldedByKey("m", many)).rejects.toThrow();
    });

    it("concurrent applies converge on the highest sequence regardless of arrival order", async (ctx) => {
      const s = await open(ctx);
      const seqs = Array.from({ length: 20 }, (_, i) => i + 1);
      const shuffled = [...seqs.filter((n) => n % 2 === 0).reverse(), ...seqs.filter((n) => n % 2 === 1)];
      await Promise.all(shuffled.map((n) => s.applyFolded(ap({ upToSequence: n, state: { n } }))));
      expect((await s.getFolded("m", ["x-1"]))[0]).toMatchObject({ sequence: 20, state: { n: 20 } });
    });
  });
}
```

In `packages/conformance/src/index.ts` add near the other top-level exports: `export { runFoldedStateConformance } from "./foldedState";` and `export type { FoldedStateStoreLike } from "./foldedState";`.

In `plugins/read-model/src/conformance.test.ts` change to:

```ts
import { runFoldedStateConformance, runReadModelStoreConformance } from "@loom/conformance";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";

runReadModelStoreConformance(() => new InMemoryReadModelStore(), "InMemoryReadModelStore");
runFoldedStateConformance(() => new InMemoryReadModelStore(), "InMemoryReadModelStore");
```

- [ ] **Step 2: Run, verify the cases skip** (in-memory has no folded methods yet — they must SKIP, not fail; this pins the skip contract)

Run: `pnpm --filter @loom/conformance build && pnpm --filter @loom/plugin-read-model exec vitest run src/conformance.test.ts`
Expected: PASS with the 12 folded cases reported as skipped.

- [ ] **Step 3: Commit**

```bash
git add packages/conformance/src/foldedState.ts packages/conformance/src/index.ts plugins/read-model/src/conformance.test.ts
git commit -m "test(conformance): folded-state ReadModelStore kit (ADR 0132)"
```

---

### Task 3: In-memory reference implementation (D3, D5, D6, D12)

**Files:**
- Modify: `plugins/read-model/src/InMemoryReadModelStore.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 2 kit.
- Produces: `InMemoryReadModelStore` implements all five folded methods and `clear` drops folded state.

- [ ] **Step 1: Run the kit — it now has the methods missing (skips); add a guard that proves the suite actually ran.** Append to `plugins/read-model/src/foldedTypes.test.ts`:

```ts
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";

it("the in-memory reference implements every folded method (so the kit does not silently skip)", () => {
  const s = new InMemoryReadModelStore();
  for (const m of ["beginFold", "applyFolded", "getFolded", "getFoldedByKey", "purgeFolded"] as const) {
    expect(typeof s[m]).toBe("function");
  }
});
```
(add `it` import is already present; place the `import` at the top of the file.)

Run: `pnpm --filter @loom/plugin-read-model exec vitest run src/foldedTypes.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement** — in `InMemoryReadModelStore.ts` add imports `FoldedApply, FoldedApplyResult, FoldedRecord, FoldedSelector` (types) and `assertManyKeys` (value) from `./types`; add fields and methods:

```ts
  private readonly foldVersions = new Map<string, string>();
  private readonly folded = new Map<string, Map<string, FoldedRecord>>();

  async beginFold(modelId: string, foldVersion: string): Promise<{ rebuilt: boolean }> {
    const prior = this.foldVersions.get(modelId);
    this.foldVersions.set(modelId, foldVersion);
    if (prior === undefined || prior === foldVersion) return { rebuilt: false };
    this.folded.delete(modelId);
    return { rebuilt: true };
  }

  async applyFolded(a: FoldedApply): Promise<FoldedApplyResult> {
    if (this.foldVersions.get(a.modelId) !== a.foldVersion) return "version-mismatch";
    let byExec = this.folded.get(a.modelId);
    if (byExec === undefined) {
      byExec = new Map();
      this.folded.set(a.modelId, byExec);
    }
    const prev = byExec.get(a.executionId);
    if (prev !== undefined && prev.sequence >= a.upToSequence) return "stale";
    byExec.set(a.executionId, {
      executionId: a.executionId,
      key: a.key ?? prev?.key ?? null,
      scope: a.scope ?? prev?.scope ?? null,
      sequence: a.upToSequence,
      state: prev?.erased === true ? null : structuredClone(a.state),
      erased: prev?.erased ?? false,
    });
    return "applied";
  }

  async getFolded(modelId: string, executionIds: readonly string[]): Promise<FoldedRecord[]> {
    assertManyKeys(executionIds, "getFolded");
    const byExec = this.folded.get(modelId);
    return [...new Set(executionIds)].flatMap((id) => {
      const r = byExec?.get(id);
      return r === undefined ? [] : [structuredClone(r)];
    });
  }

  async getFoldedByKey(modelId: string, keys: readonly string[]): Promise<FoldedRecord[]> {
    assertManyKeys(keys, "getFoldedByKey");
    const wanted = new Set(keys);
    return [...(this.folded.get(modelId)?.values() ?? [])]
      .filter((r) => r.key !== null && wanted.has(r.key))
      .sort((a, b) => (a.executionId < b.executionId ? -1 : a.executionId > b.executionId ? 1 : 0))
      .map((r) => structuredClone(r));
  }

  async purgeFolded(modelId: string, selector: FoldedSelector): Promise<number> {
    let n = 0;
    for (const r of this.folded.get(modelId)?.values() ?? []) {
      const hit =
        "executionId" in selector
          ? r.executionId === selector.executionId
          : "key" in selector
            ? r.key === selector.key
            : r.scope === selector.scope;
      if (hit && !r.erased) {
        r.state = null; // tombstone: sequence KEPT (ADR 0132 D12)
        r.erased = true;
        n++;
      }
    }
    return n;
  }
```
and in `clear`, add `this.folded.delete(modelId); this.foldVersions.delete(modelId);`.

- [ ] **Step 3: Run, verify pass**

Run: `pnpm --filter @loom/plugin-read-model exec vitest run src/conformance.test.ts src/foldedTypes.test.ts`
Expected: PASS, folded cases now RUN (12 passed, 0 skipped).

- [ ] **Step 4: Commit**

```bash
git add plugins/read-model/src/InMemoryReadModelStore.ts plugins/read-model/src/foldedTypes.test.ts
git commit -m "feat(read-model): in-memory folded state reference backend (ADR 0132)"
```

---

### Task 4a: FoldedModelEngine — registration and fold core (D1, D4, D5, D14)

**Files:**
- Create: `plugins/read-model/src/FoldedModelEngine.ts`
- Create: `plugins/read-model/src/foldedFixtures.ts`
- Create: `plugins/read-model/src/foldedEngine.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 3 store.
- Produces:
  - `type FoldedStore`, `foldedCapable(store): store is ReadModelStore & FoldedStore`
  - `class FoldedModelEngine(store: FoldedStore, onError: (err: unknown, event: EventEnvelope) => void, options: FoldedEngineOptions = {})` (`liveSource` is read from `options`; `sensitive` and `cache` are honoured from Tasks 5c and 6b) with `register(def): Promise<{rebuilt:boolean}>`, `has(id)`, `ids(): string[]`, `size`, `versions(): [string,string][]`, `handle(event): void`, `mark(modelId, executionId): Promise<FoldedRecord|undefined>`, `foldBatch(modelId, executionId, rec: FoldBase | undefined, events): Promise<boolean>`, `drain(): Promise<void>`.

- [ ] **Step 1: Fixtures + failing tests.** `plugins/read-model/src/foldedFixtures.ts` (test support; NOT exported from `index.ts`):

```ts
import { projection$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";

export interface IngestState {
  status: "queued" | "running" | "done" | "failed";
  steps: number;
  last?: string;
}

export function ingestProjection(version = "1") {
  return projection$<IngestState>({
    id: "ingest-status",
    name: "Ingest status",
    version,
    initialState: { status: "queued", steps: 0 },
    handlers: {
      STEP_COMPLETED: (s, e) => ({
        ...s,
        status: "running",
        steps: s.steps + 1,
        last: (e.payload as { step: string }).step,
      }),
      EXECUTION_COMPLETED: (s) => ({ ...s, status: "done" }),
      EXECUTION_FAILED: (s) => ({ ...s, status: "failed" }),
    },
  });
}

/** `u1:wf:ingest-d1` and `u1:wf:ingest-d1.2` -> "d1" (DocMind's generation suffix). */
export const keyOf = (id: string): string | undefined => /ingest-(.+?)(?:\.\d+)?$/.exec(id)?.[1];
/** The user-scoped prefix before the first ":". */
export const scopeOf = (id: string): string | undefined => id.split(":")[0] || undefined;

export function evt(executionId: string, sequence: number, eventType: string, payload: unknown = {}): EventEnvelope {
  return {
    id: `${executionId}-${sequence}`,
    workflowId: "wf",
    executionId,
    eventType,
    sequence,
    timestamp: 1_000 + sequence,
    payload,
  };
}
```

`plugins/read-model/src/foldedEngine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FoldedModelEngine } from "./FoldedModelEngine";
import { evt, ingestProjection, keyOf, scopeOf } from "./foldedFixtures";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { FoldGapError } from "./types";

const X = "u1:wf:ingest-d1";

function boot(onError: (e: unknown) => void = (e) => { throw e; }) {
  const store = new InMemoryReadModelStore();
  const engine = new FoldedModelEngine(store as never, onError);
  return { store, engine };
}

describe("FoldedModelEngine — registration (D1, D5)", () => {
  it("requires a non-blank version", async () => {
    const { engine } = boot();
    const bad = { projection: { ...ingestProjection(), version: "  " } };
    await expect(engine.register(bad)).rejects.toThrow(/version/);
  });

  it("refuses a duplicate id", async () => {
    const { engine } = boot();
    await engine.register({ projection: ingestProjection() });
    await expect(engine.register({ projection: ingestProjection() })).rejects.toThrow(/already registered/);
  });
});

describe("FoldedModelEngine — fold (D3, D4)", () => {
  it("folds a contiguous live tail and stores key + scope", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection(), keyOf, scopeOf });
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "ocr" }));
    engine.handle(evt(X, 1, "STEP_COMPLETED", { step: "embed" }));
    await engine.drain();
    expect((await store.getFolded("ingest-status", [X]))[0]).toMatchObject({
      key: "d1", scope: "u1", sequence: 1, state: { status: "running", steps: 2, last: "embed" },
    });
  });

  it("ignores duplicates and lower sequences", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection() });
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await engine.drain();
    expect((await store.getFolded("ingest-status", [X]))[0]?.state).toMatchObject({ steps: 1 });
  });

  it("a gap with no liveSource is reported, never folded over", async () => {
    const errs: unknown[] = [];
    const { store, engine } = boot((e) => errs.push(e));
    await engine.register({ projection: ingestProjection() });
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    engine.handle(evt(X, 5, "STEP_COMPLETED", { step: "late" }));
    await engine.drain();
    expect(errs[0]).toBeInstanceOf(FoldGapError);
    expect((await store.getFolded("ingest-status", [X]))[0]).toMatchObject({ sequence: 0 });
  });

  it("an unhandled event batch advances the watermark with a null state", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: ingestProjection() });
    const rec = await engine.mark("ingest-status", X);
    await engine.foldBatch("ingest-status", X, rec, [evt(X, 0, "SOMETHING_ELSE"), evt(X, 1, "SOMETHING_ELSE")]);
    expect((await store.getFolded("ingest-status", [X]))[0]).toMatchObject({ sequence: 1, state: null });
  });

  it("round-trips each state through JSON so incremental == batch for non-JSON values", async () => {
    const { store, engine } = boot();
    const p = ingestProjection();
    // a handler that leaves an undefined property: the persisted state must not differ by path
    (p.handlers as Record<string, unknown>).STEP_COMPLETED = (s: object) => ({ ...s, extra: undefined, n: 1 });
    await engine.register({ projection: p });
    await engine.foldBatch("ingest-status", X, undefined, [evt(X, 0, "STEP_COMPLETED"), evt(X, 1, "STEP_COMPLETED")]);
    expect((await store.getFolded("ingest-status", [X]))[0]?.state).toStrictEqual({ status: "queued", steps: 0, n: 1 });
  });

  it("a handler returning undefined/null is a loud error, not a stored null", async () => {
    const errs: unknown[] = [];
    const { engine } = boot((e) => errs.push(e));
    const p = ingestProjection();
    (p.handlers as Record<string, unknown>).STEP_COMPLETED = () => undefined;
    await engine.register({ projection: p });
    engine.handle(evt(X, 0, "STEP_COMPLETED"));
    await engine.drain();
    expect(String(errs[0])).toMatch(/state must be a JSON value/);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm --filter @loom/plugin-read-model exec vitest run src/foldedEngine.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `plugins/read-model/src/FoldedModelEngine.ts`:

```ts
import { loadProjectionHandlers, projectionEventTypes } from "@loom/core";
import type { EventEnvelope, ProjectionHandlers } from "@loom/core";
import type {
  FoldBase,
  FoldedEngineOptions,
  FoldedReadModelDefinition,
  FoldedRecord,
  ReadModelStore,
} from "./types";
import { FoldGapError, FoldVersionMismatchError } from "./types";

export type FoldedStore = Required<
  Pick<ReadModelStore, "beginFold" | "applyFolded" | "getFolded" | "getFoldedByKey" | "purgeFolded" | "clear">
>;

/** All five folded methods or none (ADR 0132 D6). */
export function foldedCapable(store: ReadModelStore): store is ReadModelStore & FoldedStore {
  return (
    store.beginFold !== undefined &&
    store.applyFolded !== undefined &&
    store.getFolded !== undefined &&
    store.getFoldedByKey !== undefined &&
    store.purgeFolded !== undefined
  );
}

export interface FoldedModel {
  id: string;
  version: string;
  initial: unknown;
  handlers: ProjectionHandlers<unknown>;
  keyOf?: (executionId: string) => string | undefined;
  scopeOf?: (executionId: string) => string | undefined;
  def: FoldedReadModelDefinition<never>;
}

/** Persist-shaped state: JSON round trip per event, so incremental == batch (ADR 0132 D4). */
function normalize(model: FoldedModel, next: unknown): unknown {
  if (next === undefined || next === null) {
    throw new TypeError(
      `folded read model "${model.id}": a handler returned ${next} — state must be a JSON value other than null (null means "no handled event yet")`
    );
  }
  const text = JSON.stringify(next);
  if (text === undefined) {
    throw new TypeError(`folded read model "${model.id}": state is not JSON-serializable`);
  }
  return JSON.parse(text);
}

export class FoldedModelEngine {
  protected readonly models = new Map<string, FoldedModel>();
  private readonly byEvent = new Map<string, FoldedModel[]>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    protected readonly store: FoldedStore,
    private readonly onError: (err: unknown, event: EventEnvelope) => void,
    protected readonly options: FoldedEngineOptions = {}
  ) {}

  has(modelId: string): boolean {
    return this.models.has(modelId);
  }
  get size(): number {
    return this.models.size;
  }
  ids(): string[] {
    return [...this.models.keys()];
  }
  versions(): [string, string][] {
    return [...this.models.values()].map((m) => [m.id, m.version]);
  }

  async register<S>(def: FoldedReadModelDefinition<S>): Promise<{ rebuilt: boolean }> {
    const p = def.projection;
    const version = p.version?.trim();
    if (version === undefined || version === "") {
      throw new TypeError(
        `folded read model "${p.id}": a version is required — a durable fold cannot be rebuilt when it changes without one (ADR 0132 D5)`
      );
    }
    if (this.models.has(p.id)) throw new TypeError(`read model "${p.id}" is already registered`);
    const handlers = (await loadProjectionHandlers(p.handlers)) as ProjectionHandlers<unknown>;
    const kinds = projectionEventTypes(p.handlers);
    if (kinds.length === 0) throw new TypeError(`folded read model "${p.id}": handlers must be non-empty`);
    const { rebuilt } = await this.store.beginFold(p.id, version);
    if (this.models.has(p.id)) throw new TypeError(`read model "${p.id}" is already registered`);
    const model: FoldedModel = {
      id: p.id,
      version,
      initial: p.initialState,
      handlers,
      ...(def.keyOf !== undefined && { keyOf: def.keyOf }),
      ...(def.scopeOf !== undefined && { scopeOf: def.scopeOf }),
      def: def as unknown as FoldedReadModelDefinition<never>,
    };
    this.models.set(p.id, model);
    for (const kind of kinds) {
      const list = this.byEvent.get(kind);
      if (list === undefined) this.byEvent.set(kind, [model]);
      else list.push(model);
    }
    return { rebuilt };
  }

  /** Live tail: serialized per (model, execution); errors go to `onError`, never into the pipeline. */
  handle(event: EventEnvelope): void {
    for (const model of this.byEvent.get(event.eventType) ?? []) {
      void this.enqueue(model.id, event.executionId, () => this.applyLive(model, event)).catch((err) =>
        this.onError(err, event)
      );
    }
  }

  async mark(modelId: string, executionId: string): Promise<FoldedRecord | undefined> {
    return (await this.store.getFolded(modelId, [executionId]))[0];
  }

  /** Fold `events` (those past the record's watermark) and CAS-write. True when the write applied. */
  async foldBatch(
    modelId: string,
    executionId: string,
    rec: FoldBase | undefined,
    events: readonly EventEnvelope[]
  ): Promise<boolean> {
    const model = this.models.get(modelId);
    if (model === undefined) throw new TypeError(`read model "${modelId}" is not a registered folded model`);
    const from = rec?.sequence ?? -1;
    const todo = events.filter((e) => e.sequence > from);
    if (todo.length === 0) return false;
    const erased = rec?.erased === true;
    let state: unknown = rec?.state ?? null;
    if (!erased) {
      for (const e of todo) {
        const handler = model.handlers[e.eventType];
        if (handler === undefined) continue;
        const base = state === null ? structuredClone(model.initial) : state;
        state = normalize(model, handler(base, e));
      }
    }
    const result = await this.store.applyFolded({
      modelId,
      executionId,
      upToSequence: todo[todo.length - 1]!.sequence,
      state,
      key: model.keyOf?.(executionId) ?? null,
      scope: model.scopeOf?.(executionId) ?? null,
      foldVersion: model.version,
    });
    if (result === "version-mismatch") throw new FoldVersionMismatchError(modelId, model.version);
    return result === "applied";
  }

  async drain(): Promise<void> {
    while (this.queues.size > 0) await Promise.all([...this.queues.values()]);
  }

  protected enqueue(modelId: string, executionId: string, job: () => Promise<void>): Promise<void> {
    const k = `${modelId}\u0000${executionId}`;
    const next = (this.queues.get(k) ?? Promise.resolve()).then(job);
    const tail = next.catch(() => undefined);
    this.queues.set(k, tail);
    void tail.then(() => {
      if (this.queues.get(k) === tail) this.queues.delete(k);
    });
    return next;
  }

  private async applyLive(model: FoldedModel, event: EventEnvelope): Promise<void> {
    const rec = await this.mark(model.id, event.executionId);
    const from = rec?.sequence ?? -1;
    if (event.sequence <= from) return;
    let events: readonly EventEnvelope[];
    if (event.sequence === from + 1) events = [event];
    else if (this.options.liveSource !== undefined) events = await this.options.liveSource.readFrom(event.executionId, from + 1);
    else throw new FoldGapError(model.id, event.executionId, from, event.sequence);
    await this.foldBatch(model.id, event.executionId, rec, events);
  }
}
```

Note: `state` for a record with `state === null` and an unerased row is "no handled event yet" so the first handled event folds from `structuredClone(initialState)`.

- [ ] **Step 4: Run, verify pass** — `pnpm --filter @loom/plugin-read-model exec vitest run src/foldedEngine.test.ts` → PASS. Then `pnpm --filter @loom/plugin-read-model build` (typecheck: confirm `ProjectionHandlers` is exported by `@loom/core`; it is, at `packages/core/src/index.ts:59`).

- [ ] **Step 5: Commit**

```bash
git add plugins/read-model/src/FoldedModelEngine.ts plugins/read-model/src/foldedFixtures.ts plugins/read-model/src/foldedEngine.test.ts
git commit -m "feat(read-model): FoldedModelEngine registration and contiguous fold (ADR 0132 D4/D5)"
```

---

### Task 4b: Engine reads, refresh and purge (D7, D8, D12)

**Files:**
- Modify: `plugins/read-model/src/FoldedModelEngine.ts`
- Modify: `plugins/read-model/src/foldedEngine.test.ts`

**Interfaces:**
- Produces on `FoldedModelEngine`: `getMany(modelId, ids, opts?: { refreshFrom?: readonly ReadModelEventSource[]; concurrency?: number }): Promise<Map<string, FoldedState<unknown>>>`, `getManyByKey(modelId, keys, opts?)`, `refresh(modelId, ids, sources, concurrency?): Promise<number>`, `purge(modelId, selector): Promise<number>`, `reset(modelId): Promise<void>`, `definition(modelId)`.

- [ ] **Step 1: Failing tests** — append to `foldedEngine.test.ts` (add imports `InMemoryAsyncEventStore` from `@loom/event-runtime`):

```ts
describe("FoldedModelEngine — reads, refresh, purge (D7, D8, D12)", () => {
  const Y = "u1:wf:ingest-d1.2";

  it("getMany omits absent, never-matched and erased executions; carries the sequence", async () => {
    const { engine } = boot();
    await engine.register({ projection: ingestProjection(), keyOf, scopeOf });
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await engine.drain();
    await engine.foldBatch("ingest-status", "u1:wf:ingest-d3", undefined, [evt("u1:wf:ingest-d3", 0, "NOISE")]);
    const got = await engine.getMany("ingest-status", [X, "u1:wf:ingest-d3", "u1:wf:ingest-nope"]);
    expect([...got.keys()]).toEqual([X]);
    expect(got.get(X)).toMatchObject({ sequence: 0, key: "d1", state: { steps: 1 } });
    await engine.purge("ingest-status", { executionId: X });
    expect((await engine.getMany("ingest-status", [X])).size).toBe(0);
  });

  it("getManyByKey groups generations under one key, ordered by executionId", async () => {
    const { engine } = boot();
    await engine.register({ projection: ingestProjection(), keyOf });
    for (const id of [Y, X]) engine.handle(evt(id, 0, "EXECUTION_COMPLETED"));
    await engine.drain();
    const got = await engine.getManyByKey("ingest-status", ["d1", "zzz"]);
    expect(got.get("d1")?.map((s) => s.executionId)).toEqual([X, Y]);
    expect(got.has("zzz")).toBe(false);
  });

  it("refresh reads the log tail: read-your-writes without the live feed", async () => {
    const { engine } = boot();
    await engine.register({ projection: ingestProjection() });
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await log.append(evt(X, 1, "EXECUTION_COMPLETED"));
    expect((await engine.getMany("ingest-status", [X])).size).toBe(0); // live feed never delivered
    const got = await engine.getMany("ingest-status", [X], { refreshFrom: [log] });
    expect(got.get(X)?.state).toMatchObject({ status: "done", steps: 1 });
    expect(await engine.refresh("ingest-status", [X], [log])).toBe(0); // current: nothing to fold
  });

  it("purge refuses an empty or multi-field selector", async () => {
    const { engine } = boot();
    await engine.register({ projection: ingestProjection() });
    await expect(engine.purge("ingest-status", {} as never)).rejects.toThrow(/exactly one/);
    await expect(engine.purge("ingest-status", { key: "a", scope: "b" } as never)).rejects.toThrow(/exactly one/);
  });
});
```

- [ ] **Step 2: Run, verify fail** → FAIL (`getMany` is not a function).

- [ ] **Step 3: Implement** — in `FoldedModelEngine.ts` add `FoldedSelector, FoldedState, ReadModelEventSource` to the type import and `assertManyKeys` to the value import from `./types`, then add methods:

```ts
  definition(modelId: string): FoldedReadModelDefinition<never> {
    return this.require(modelId).def;
  }

  async getMany(
    modelId: string,
    executionIds: readonly string[],
    opts: { refreshFrom?: readonly ReadModelEventSource[]; concurrency?: number } = {}
  ): Promise<Map<string, FoldedState<unknown>>> {
    this.require(modelId);
    assertManyKeys(executionIds, "getMany");
    if (opts.refreshFrom !== undefined) {
      await this.refresh(modelId, executionIds, opts.refreshFrom, opts.concurrency);
    }
    const out = new Map<string, FoldedState<unknown>>();
    for (const r of await this.store.getFolded(modelId, executionIds)) {
      const s = toState(r);
      if (s !== undefined) out.set(r.executionId, s);
    }
    return out;
  }

  async getManyByKey(
    modelId: string,
    keys: readonly string[],
    opts: { refreshFrom?: readonly ReadModelEventSource[]; concurrency?: number } = {}
  ): Promise<Map<string, FoldedState<unknown>[]>> {
    this.require(modelId);
    assertManyKeys(keys, "getManyByKey");
    let records = await this.store.getFoldedByKey(modelId, keys);
    if (opts.refreshFrom !== undefined && records.length > 0) {
      await this.refresh(modelId, records.map((r) => r.executionId), opts.refreshFrom, opts.concurrency);
      records = await this.store.getFoldedByKey(modelId, keys);
    }
    const out = new Map<string, FoldedState<unknown>[]>();
    for (const r of records) {
      const s = toState(r);
      if (s === undefined || r.key === null) continue;
      const list = out.get(r.key);
      if (list === undefined) out.set(r.key, [s]);
      else list.push(s);
    }
    return out;
  }

  /**
   * Read-repair (ADR 0132 D8): fold each execution's log tail past its watermark. Serialized
   * behind any in-flight live apply for the same execution, so it also drains it. Returns the
   * number of executions whose state advanced.
   */
  async refresh(
    modelId: string,
    executionIds: readonly string[],
    sources: readonly ReadModelEventSource[],
    concurrency = 8
  ): Promise<number> {
    const model = this.require(modelId);
    const ids = [...new Set(executionIds)];
    let advanced = 0;
    for (let i = 0; i < ids.length; i += concurrency) {
      await Promise.all(
        ids.slice(i, i + concurrency).map((id) =>
          this.enqueue(model.id, id, async () => {
            const rec = await this.mark(model.id, id);
            for (const source of sources) {
              const events = await source.readFrom(id, (rec?.sequence ?? -1) + 1);
              if (events.length === 0) continue;
              if (await this.foldBatch(model.id, id, rec, events)) advanced++;
              break;
            }
          })
        )
      );
    }
    return advanced;
  }

  async purge(modelId: string, selector: FoldedSelector): Promise<number> {
    this.require(modelId);
    const set = Object.values(selector).filter((v) => v !== undefined);
    if (set.length !== 1 || typeof set[0] !== "string" || set[0] === "") {
      throw new TypeError(
        "folded read model purge: the selector must name exactly one of executionId / key / scope, non-empty — an empty selector is not 'every row' (that is `clear`)"
      );
    }
    await this.drain();
    return this.store.purgeFolded(modelId, selector);
  }

  /** Drop the model's states and re-create its header (the caller then runs a catch-up scan). */
  async reset(modelId: string): Promise<void> {
    const model = this.require(modelId);
    await this.drain();
    await this.store.clear(modelId);
    await this.store.beginFold(modelId, model.version);
  }

  private require(modelId: string): FoldedModel {
    const model = this.models.get(modelId);
    if (model === undefined) throw new TypeError(`read model "${modelId}" is not a registered folded model`);
    return model;
  }
```
plus module-level:

```ts
function toState(r: FoldedRecord): FoldedState<unknown> | undefined {
  if (r.erased || r.state === null) return undefined;
  return { executionId: r.executionId, key: r.key, sequence: r.sequence, state: r.state };
}
```
Note `refresh`'s return counts executions advanced (test above: first call after getMany already advanced → second returns 0). Update the ADR text if wording differs: ADR D8 says "number of events folded" — change ADR signature comment to `/* executions advanced */` in this task's commit.

- [ ] **Step 4: Run, verify pass** → `pnpm --filter @loom/plugin-read-model exec vitest run src/foldedEngine.test.ts` PASS.
- [ ] **Step 5: Commit**

```bash
git add plugins/read-model/src/FoldedModelEngine.ts plugins/read-model/src/foldedEngine.test.ts docs/adr/0132-folded-state-read-model.md
git commit -m "feat(read-model): folded getMany/getManyByKey/refresh/purge on the engine (ADR 0132 D7/D8/D12)"
```

---

### Task 5a: Sensitive-state guard — the output check (D11)

**Files:**
- Create: `plugins/read-model/src/sensitiveState.ts`
- Create: `plugins/read-model/src/sensitiveState.test.ts`
- Modify: `plugins/read-model/src/index.ts`

**Interfaces:**
- Produces: `GUARD_WALK_BUDGET = 100_000`, `MIN_LIFTED_STRING = 6`, `MIN_LIFTED_DIGITS = 6`, `Lifted { strings: ReadonlySet<string>; numbers: ReadonlySet<number> }`, `NOTHING_LIFTED`, `isCipherEnvelope(v)`, `isLiftable(v)`, `walkBounded(root, visit): boolean`, `SensitiveStateContext`, `SensitiveStateReason`, `SensitiveStateError`, `assertStateClean(ctx, state, lifted): void`. Pure: no I/O, no store, no clock (P7).

- [ ] **Step 1: Failing test** — `plugins/read-model/src/sensitiveState.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  GUARD_WALK_BUDGET,
  type Lifted,
  NOTHING_LIFTED,
  SensitiveStateError,
  assertStateClean,
  isLiftable,
} from "./sensitiveState";

const ctx = { modelId: "m", executionId: "x-1", eventType: "STEP_COMPLETED", sequence: 3 };
const lifted = (strings: string[] = [], numbers: number[] = []): Lifted => ({
  strings: new Set(strings),
  numbers: new Set(numbers),
});
const refusal = (state: unknown, l: Lifted): SensitiveStateError => {
  try {
    assertStateClean(ctx, state, l);
  } catch (e) {
    return e as SensitiveStateError;
  }
  throw new Error("expected a SensitiveStateError");
};

describe("assertStateClean — the persist-time check (ADR 0132 D11)", () => {
  it("passes an ordinary status-shaped state", () => {
    expect(() => assertStateClean(ctx, { status: "done", steps: 2, tags: ["a"] }, NOTHING_LIFTED)).not.toThrow();
  });

  it("refuses a sealed envelope at any depth and reports where, not what", () => {
    const e = refusal({ a: { b: [{ __loomEnc: "loom/aes-256-gcm", ct: "zzzzzzzz" }] } }, NOTHING_LIFTED);
    expect(e).toBeInstanceOf(SensitiveStateError);
    expect(e).toMatchObject({ reason: "sealed-envelope", statePath: "$.a.b[0]" });
    expect(e.message).not.toContain("zzzzzzzz");
  });

  it("treats a non-string or inherited __loomEnc as an ordinary value (ADR 0130 D2)", () => {
    expect(() => assertStateClean(ctx, { v: { __loomEnc: 1 } }, NOTHING_LIFTED)).not.toThrow();
    expect(() => assertStateClean(ctx, { v: Object.create({ __loomEnc: "x" }) }, NOTHING_LIFTED)).not.toThrow();
  });

  it("refuses a lifted string and names model, execution, event and path — never the value", () => {
    const secret = "alice@example.com";
    const e = refusal({ owner: { email: secret } }, lifted([secret]));
    expect(e).toMatchObject({ reason: "lifted-value", statePath: "$.owner.email" });
    expect(e.message).toContain('"m"');
    expect(e.message).toContain('"x-1"');
    expect(e.message).toContain("STEP_COMPLETED #3");
    expect(e.message).not.toContain(secret);
    expect(JSON.stringify(e.context)).not.toContain(secret);
  });

  it("refuses a lifted value used as an object KEY, without echoing the key", () => {
    const secret = "alice@example.com";
    const e = refusal({ byOwner: { [secret]: 1 } }, lifted([secret]));
    expect(e).toMatchObject({ reason: "lifted-value", statePath: "$.byOwner.<key>" });
    expect(e.message).not.toContain(secret);
  });

  it("refuses a lifted number", () => {
    expect(refusal({ n: [0, 123456789] }, lifted([], [123456789]))).toMatchObject({ statePath: "$.n[1]" });
  });

  it("does not lift values too short to be meaningful (no false positives on 'ok' or 3)", () => {
    expect(isLiftable("ok")).toBe(false);
    expect(isLiftable(12345)).toBe(false);
    expect(isLiftable("abcdef")).toBe(true);
    expect(isLiftable(123456)).toBe(true);
    expect(isLiftable(true)).toBe(false);
  });

  it("fails closed when the state is too large to verify", () => {
    const e = refusal({ big: new Array(GUARD_WALK_BUDGET + 1).fill(0) }, NOTHING_LIFTED);
    expect(e.reason).toBe("unverifiable");
  });
});
```

- [ ] **Step 2: Run, verify fail** — `pnpm --filter @loom/plugin-read-model exec vitest run src/sensitiveState.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `plugins/read-model/src/sensitiveState.ts`:

```ts
// ── ADR 0132 D11 — the persist-time half of the sensitive-state guard ─────────
// Pure functions only. The engine calls `assertStateClean` after every handler result and before
// anything is written; it never reads a store, a clock or a key. Ciphertext is recognised by SHAPE
// (ADR 0130 D2), so this works on a node that does not load the crypto plugin.

/** Same budget as ADR 0130 D2's bounded walk. Exhausting it is "cannot verify", never "clean". */
export const GUARD_WALK_BUDGET = 100_000;
/** Shorter strings / integers are not lifted: "ok" or 3 would flag ordinary state (documented limit). */
export const MIN_LIFTED_STRING = 6;
export const MIN_LIFTED_DIGITS = 6;

/** Scalar values found under the sensitive paths of the event being folded. */
export interface Lifted {
  readonly strings: ReadonlySet<string>;
  readonly numbers: ReadonlySet<number>;
}
export const NOTHING_LIFTED: Lifted = { strings: new Set<string>(), numbers: new Set<number>() };

/** A plain object with an OWN string `__loomEnc`: a crypto-plugin ciphertext envelope (ADR 0130 D2). */
export function isCipherEnvelope(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.hasOwn(v, "__loomEnc") &&
    typeof (v as { __loomEnc?: unknown }).__loomEnc === "string"
  );
}

export function isLiftable(v: unknown): v is string | number {
  if (typeof v === "string") return v.length >= MIN_LIFTED_STRING;
  return (
    typeof v === "number" && Number.isFinite(v) && String(Math.abs(Math.trunc(v))).length >= MIN_LIFTED_DIGITS
  );
}

/**
 * Iterative breadth-first visit of every node under `root` (objects and arrays; depth cannot blow the
 * stack). Returns false when the node budget ran out, which callers MUST treat as unverifiable.
 */
export function walkBounded(root: unknown, visit: (value: unknown) => void): boolean {
  const queue: unknown[] = [root];
  for (let i = 0; i < queue.length; i++) {
    if (queue.length > GUARD_WALK_BUDGET) return false;
    const v = queue[i];
    visit(v);
    if (typeof v !== "object" || v === null) continue;
    for (const child of Array.isArray(v) ? v : Object.values(v)) queue.push(child);
  }
  return queue.length <= GUARD_WALK_BUDGET;
}

export interface SensitiveStateContext {
  readonly modelId: string;
  readonly executionId: string;
  readonly eventType: string;
  readonly sequence: number;
}
export type SensitiveStateReason = "sealed-envelope" | "lifted-value" | "unverifiable";

const WHY: Record<SensitiveStateReason, string> = {
  "sealed-envelope": "the new state holds a sealed envelope",
  "lifted-value": "the new state holds a value copied from a sensitive path",
  unverifiable: "the new state is too large to verify",
};

/** Names the model, execution, event and state path. NEVER carries a value, a key or ciphertext. */
export class SensitiveStateError extends Error {
  readonly name = "SensitiveStateError";
  constructor(
    readonly context: SensitiveStateContext,
    readonly reason: SensitiveStateReason,
    readonly statePath: string
  ) {
    super(
      `folded read model "${context.modelId}": ${WHY[reason]} at ${statePath} (execution "${context.executionId}", ${context.eventType} #${context.sequence}) — a folded state is stored in plaintext and must not hold sensitive data (ADR 0132 D11)`
    );
  }
}

/** Refuse a state that would persist ciphertext or a value lifted from a sensitive path. */
export function assertStateClean(ctx: SensitiveStateContext, state: unknown, lifted: Lifted): void {
  const queue: [unknown, string][] = [[state, "$"]];
  for (let i = 0; i < queue.length; i++) {
    if (queue.length > GUARD_WALK_BUDGET) throw new SensitiveStateError(ctx, "unverifiable", "$");
    const [v, path] = queue[i] as [unknown, string];
    if (typeof v === "string") {
      if (lifted.strings.has(v)) throw new SensitiveStateError(ctx, "lifted-value", path);
      continue;
    }
    if (typeof v === "number") {
      if (lifted.numbers.has(v)) throw new SensitiveStateError(ctx, "lifted-value", path);
      continue;
    }
    if (typeof v !== "object" || v === null) continue;
    if (isCipherEnvelope(v)) throw new SensitiveStateError(ctx, "sealed-envelope", path);
    if (Array.isArray(v)) {
      v.forEach((child, j) => queue.push([child, `${path}[${j}]`]));
      continue;
    }
    for (const [k, child] of Object.entries(v)) {
      // A key that IS a lifted value is reported by position only: the path must not echo it.
      if (lifted.strings.has(k)) throw new SensitiveStateError(ctx, "lifted-value", `${path}.<key>`);
      queue.push([child, `${path}.${k}`]);
    }
  }
}
```
In `index.ts` add `export { SensitiveStateError } from "./sensitiveState"; export type { SensitiveStateContext, SensitiveStateReason } from "./sensitiveState";`.

- [ ] **Step 4: Run, verify pass** — `pnpm --filter @loom/plugin-read-model exec vitest run src/sensitiveState.test.ts && pnpm --filter @loom/plugin-read-model build` → PASS.
- [ ] **Step 5: Commit**

```bash
git add plugins/read-model/src/sensitiveState.ts plugins/read-model/src/sensitiveState.test.ts plugins/read-model/src/index.ts
git commit -m "feat(read-model): sensitive-state guard output check (ADR 0132 D11)"
```

---

### Task 5b: Sensitive-state guard — the fold input view (D11)

**Files:**
- Create: `plugins/read-model/src/sensitiveInput.ts`
- Create: `plugins/read-model/src/sensitiveInput.test.ts`
- Modify: `plugins/read-model/package.json` (add `"@loom/classify": "workspace:*"` to `dependencies`)
- Modify: `plugins/read-model/tsconfig.json` (add `{ "path": "../../packages/classify" }` to `references`)
- Modify: `plugins/read-model/tsconfig.test.json` (same reference, if it lists references)
- Modify: `pnpm-lock.yaml` (via `pnpm install`; commit only the resulting importer entry)

**Interfaces:**
- Consumes: Task 1 `SensitiveMap`; Task 5a `Lifted`, `isCipherEnvelope`, `isLiftable`, `walkBounded`, `SensitiveStateError`.
- Produces: `sensitivePathsFor(event, declared): string[]`, `foldView(modelId, event, declared): { event: EventEnvelope; lifted: Lifted }`.

- [ ] **Step 1: Failing test** — `plugins/read-model/src/sensitiveInput.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evt } from "./foldedFixtures";
import { foldView, sensitivePathsFor } from "./sensitiveInput";
import { GUARD_WALK_BUDGET, SensitiveStateError } from "./sensitiveState";

const sealedField = { __loomEnc: "loom/aes-256-gcm", iv: "iviviviv", ct: "ctctctct" };
const seal = (covers: string[]) => ({ seal: { v: 1, cipher: "loom/aes-256-gcm", covers } });

describe("sensitivePathsFor (ADR 0132 D11)", () => {
  it("unions the declared paths with the event's own seal marker, for that event type only", () => {
    const e = { ...evt("x", 0, "STEP_COMPLETED", {}), metadata: seal(["STEP_COMPLETED.output.ssn", "OTHER.a"]) };
    expect(sensitivePathsFor(e, { STEP_COMPLETED: ["email", "output.ssn"], OTHER: ["z"] })).toEqual([
      "email",
      "output.ssn",
    ]);
  });

  it("is empty when nothing is declared and the event carries no marker", () => {
    expect(sensitivePathsFor(evt("x", 0, "STEP_COMPLETED"), {})).toEqual([]);
  });
});

describe("foldView — what a handler is allowed to see", () => {
  it("masks declared paths, keeps presence, leaves the original event untouched", () => {
    const e = evt("x", 0, "STEP_COMPLETED", { step: "ocr", email: "alice@example.com" });
    const { event } = foldView("m", e, { STEP_COMPLETED: ["email"] });
    expect(event.payload).toEqual({ step: "ocr", email: "[redacted]" });
    expect(e.payload).toEqual({ step: "ocr", email: "alice@example.com" });
  });

  it("resolves array wildcards", () => {
    const e = evt("x", 0, "E", { people: [{ ssn: "111-22-3333", id: "a" }, { ssn: "444-55-6666", id: "b" }] });
    const { event, lifted } = foldView("m", e, { E: ["people[].ssn"] });
    expect(event.payload).toEqual({
      people: [{ ssn: "[redacted]", id: "a" }, { ssn: "[redacted]", id: "b" }],
    });
    expect([...lifted.strings].sort()).toEqual(["111-22-3333", "444-55-6666"]);
  });

  it("lifts only values long enough to mean something, from the original event", () => {
    const { lifted } = foldView("m", evt("x", 0, "E", { a: "ok", b: "long-enough", n: 7, big: 9876543 }), {
      E: ["a", "b", "n", "big"],
    });
    expect([...lifted.strings]).toEqual(["long-enough"]);
    expect([...lifted.numbers]).toEqual([9876543]);
  });

  it("masks a cipher envelope wherever it sits, even with nothing declared, and lifts nothing from ciphertext", () => {
    const { event, lifted } = foldView("m", evt("x", 0, "E", { step: "ocr", deep: { f: [sealedField] } }), {});
    expect(event.payload).toEqual({ step: "ocr", deep: { f: ["[redacted]"] } });
    expect(lifted.strings.size).toBe(0);
  });

  it("masks an envelope that sits ON a sensitive path (a raw at-rest read) and lifts nothing from it", () => {
    const { event, lifted } = foldView("m", evt("x", 0, "E", { email: sealedField }), { E: ["email"] });
    expect(event.payload).toEqual({ email: "[redacted]" });
    expect(lifted.strings.size).toBe(0);
  });

  it("masks a { $shredded } placeholder on a sensitive path like any other value", () => {
    const { event } = foldView("m", evt("x", 0, "E", { email: { $shredded: true } }), { E: ["email"] });
    expect(event.payload).toEqual({ email: "[redacted]" });
  });

  it("returns the very same event when there is nothing to hide", () => {
    const e = evt("x", 0, "E", { a: 1 });
    expect(foldView("m", e, {}).event).toBe(e);
  });

  it("fails closed on a payload too large to verify", () => {
    const e = evt("x", 0, "E", { big: new Array(GUARD_WALK_BUDGET + 1).fill(0) });
    expect(() => foldView("m", e, {})).toThrow(SensitiveStateError);
  });
});
```

- [ ] **Step 2: Run, verify fail** → FAIL (module missing).

- [ ] **Step 3: Implement.** First `pnpm --filter @loom/plugin-read-model add @loom/classify@workspace:*` (updates `package.json` and the lockfile), add the tsconfig reference(s). Then `plugins/read-model/src/sensitiveInput.ts`:

```ts
import { REDACTED, expandPaths, maskPaths } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import {
  type Lifted,
  SensitiveStateError,
  isCipherEnvelope,
  isLiftable,
  walkBounded,
} from "./sensitiveState";
import type { SensitiveMap } from "./types";

// ── ADR 0132 D11 — the fold-input half of the sensitive-state guard (pure) ────

/** Declared paths for the event's type, plus the `EVENT_TYPE.path` entries of its own `metadata.seal` marker. */
export function sensitivePathsFor(event: EventEnvelope, declared: SensitiveMap): string[] {
  const out = new Set<string>(declared[event.eventType] ?? []);
  const covers = (event.metadata as { seal?: { covers?: unknown } } | undefined)?.seal?.covers;
  if (Array.isArray(covers)) {
    const prefix = `${event.eventType}.`;
    for (const c of covers) if (typeof c === "string" && c.startsWith(prefix)) out.add(c.slice(prefix.length));
  }
  return [...out].sort();
}

function valueAt(root: unknown, path: string): unknown {
  let v = root;
  for (const seg of path.split(".")) {
    if (typeof v !== "object" || v === null || !Object.hasOwn(v, seg)) return undefined;
    v = (v as Record<string, unknown>)[seg];
  }
  return v;
}

/**
 * The event a handler is given: every effective sensitive path replaced by `"[redacted]"` and any
 * cipher envelope elsewhere replaced the same way. Also returns the scalar values found under the
 * sensitive paths of the ORIGINAL event, which `assertStateClean` checks the new state against.
 */
export function foldView(
  modelId: string,
  event: EventEnvelope,
  declared: SensitiveMap
): { event: EventEnvelope; lifted: Lifted } {
  const ctx = { modelId, executionId: event.executionId, eventType: event.eventType, sequence: event.sequence };
  const strings = new Set<string>();
  const numbers = new Set<number>();
  const paths = sensitivePathsFor(event, declared);
  let payload = event.payload;
  let touched = false;
  if (paths.length > 0 && typeof payload === "object" && payload !== null) {
    for (const path of expandPaths(payload, paths)) {
      const at = valueAt(payload, path);
      if (at === undefined || isCipherEnvelope(at)) continue; // nothing to lift from ciphertext
      const done = walkBounded(at, (leaf) => {
        if (!isLiftable(leaf)) return;
        if (typeof leaf === "string") strings.add(leaf);
        else numbers.add(leaf);
      });
      if (!done) throw new SensitiveStateError(ctx, "unverifiable", `payload.${path}`);
    }
    payload = maskPaths(payload, paths);
    touched = true;
  }
  // Ciphertext anywhere else (a raw at-rest read, or a path nobody declared) never reaches a handler.
  let sealed = false;
  if (
    !walkBounded(payload, (v) => {
      if (isCipherEnvelope(v)) sealed = true;
    })
  ) {
    throw new SensitiveStateError(ctx, "unverifiable", "payload");
  }
  if (sealed) {
    payload = JSON.parse(JSON.stringify(payload, (_k, v) => (isCipherEnvelope(v) ? REDACTED : v)));
    touched = true;
  }
  return { event: touched ? { ...event, payload } : event, lifted: { strings, numbers } };
}
```

- [ ] **Step 4: Run, verify pass** — `pnpm --filter @loom/plugin-read-model exec vitest run src/sensitiveInput.test.ts && pnpm --filter @loom/plugin-read-model build` → PASS. Check the layering guard still passes: `pnpm --filter @loom/spec exec vitest run` (plugins may depend on `@loom/classify`, as the crypto plugin does).
- [ ] **Step 5: Commit**

```bash
git add plugins/read-model/src/sensitiveInput.ts plugins/read-model/src/sensitiveInput.test.ts plugins/read-model/package.json plugins/read-model/tsconfig.json plugins/read-model/tsconfig.test.json pnpm-lock.yaml
git commit -m "feat(read-model): sensitive-state guard fold input view (ADR 0132 D11)"
```

---

### Task 5c: Sensitive-state guard — configuration and engine wiring (D5, D11)

**Files:**
- Create: `plugins/read-model/src/sensitiveConfig.ts`
- Create: `plugins/read-model/src/sensitiveConfig.test.ts`
- Modify: `plugins/read-model/src/FoldedModelEngine.ts`
- Modify: `plugins/read-model/src/foldedEngine.test.ts`
- Modify: `plugins/read-model/src/index.ts`

**Interfaces:**
- Consumes: Tasks 4a/4b, 5a, 5b.
- Produces: `sensitiveMapFromCovers(covers)`, `mergeSensitive(...maps)`, `effectiveFoldVersion(version, declared)`; the engine now builds the fold view, runs `assertStateClean` after every handler, and registers under the effective version.

- [ ] **Step 1: Failing tests.** `plugins/read-model/src/sensitiveConfig.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { effectiveFoldVersion, mergeSensitive, sensitiveMapFromCovers } from "./sensitiveConfig";

describe("sensitive map helpers (ADR 0132 D5, D11)", () => {
  it("derives the map from sealingCapability().covers", () => {
    expect(
      sensitiveMapFromCovers(["STEP_COMPLETED.output.ssn", "STEP_COMPLETED.output.dob", "OTHER.a", "BARE"])
    ).toEqual({ STEP_COMPLETED: ["output.dob", "output.ssn"], OTHER: ["a"] });
  });

  it("unions maps and de-duplicates paths", () => {
    expect(mergeSensitive({ A: ["x"] }, undefined, { A: ["x", "y"], B: ["z"] })).toEqual({
      A: ["x", "y"],
      B: ["z"],
    });
  });

  it("leaves the declared version alone when nothing is declared", () => {
    expect(effectiveFoldVersion("1", {})).toBe("1");
    expect(effectiveFoldVersion("1", { A: [] })).toBe("1");
  });

  it("changes the version when the declared paths change, and not with key or path order", () => {
    const a = effectiveFoldVersion("1", { A: ["x", "y"], B: ["z"] });
    expect(a).toMatch(/^1\+sens\.[0-9a-f]{8}$/);
    expect(effectiveFoldVersion("1", { B: ["z"], A: ["y", "x"] })).toBe(a);
    expect(effectiveFoldVersion("1", { A: ["x"], B: ["z"] })).not.toBe(a);
  });
});
```
Append to `foldedEngine.test.ts` (imports: `SensitiveStateError` from `./sensitiveState`):

```ts
describe("FoldedModelEngine — sensitive-state guard (D11)", () => {
  const email = "alice@example.com";
  const leaky = (field: "email" | "mirror") => {
    const p = ingestProjection();
    (p.handlers as Record<string, unknown>).STEP_COMPLETED = (s: object, e: { payload: Record<string, string> }) => ({
      ...s,
      status: "running",
      last: e.payload[field],
    });
    return p;
  };

  it("hands the handler a masked event: a fold that copies a declared field stores the sentinel", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: leaky("email"), sensitive: { STEP_COMPLETED: ["email"] } });
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "ocr", email }));
    await engine.drain();
    expect((await store.getFolded("ingest-status", [X]))[0]?.state).toMatchObject({ last: "[redacted]" });
  });

  it("refuses a state that mirrors a sensitive value through an undeclared field, without leaking it", async () => {
    const errs: unknown[] = [];
    const { store, engine } = boot((e) => errs.push(e));
    await engine.register({ projection: leaky("mirror"), sensitive: { STEP_COMPLETED: ["email"] } });
    engine.handle(evt(X, 0, "STEP_COMPLETED", { step: "ocr", email, mirror: email }));
    await engine.drain();
    const err = errs[0] as SensitiveStateError;
    expect(err).toBeInstanceOf(SensitiveStateError);
    expect(err).toMatchObject({ reason: "lifted-value", statePath: "$.last" });
    expect(err.message).toContain("ingest-status");
    expect(err.message).not.toContain(email);
    expect(await store.getFolded("ingest-status", [X])).toEqual([]); // the watermark did not advance
  });

  it("refuses a handler that fabricates a sealed envelope into state", async () => {
    const errs: unknown[] = [];
    const { engine } = boot((e) => errs.push(e));
    const p = ingestProjection();
    (p.handlers as Record<string, unknown>).STEP_COMPLETED = (s: object) => ({ ...s, blob: { __loomEnc: "x" } });
    await engine.register({ projection: p });
    engine.handle(evt(X, 0, "STEP_COMPLETED"));
    await engine.drain();
    expect(errs[0]).toMatchObject({ name: "SensitiveStateError", reason: "sealed-envelope", statePath: "$.blob" });
  });

  it("uses the event's own seal marker with no declared map", async () => {
    const { store, engine } = boot();
    await engine.register({ projection: leaky("email") });
    const e = { ...evt(X, 0, "STEP_COMPLETED", { step: "ocr", email }), metadata: { seal: { v: 1, cipher: "c", covers: ["STEP_COMPLETED.email"] } } };
    engine.handle(e);
    await engine.drain();
    expect((await store.getFolded("ingest-status", [X]))[0]?.state).toMatchObject({ last: "[redacted]" });
  });

  it("registers under a version that includes the declared map: changing the paths rebuilds", async () => {
    const store = new InMemoryReadModelStore();
    const a = new FoldedModelEngine(store as never, () => {});
    expect(await a.register({ projection: ingestProjection(), sensitive: { STEP_COMPLETED: ["email"] } })).toEqual({ rebuilt: false });
    const b = new FoldedModelEngine(store as never, () => {});
    expect(await b.register({ projection: ingestProjection(), sensitive: { STEP_COMPLETED: ["email", "phone"] } })).toEqual({ rebuilt: true });
    expect(b.versions()[0]?.[1]).toMatch(/^1\+sens\./);
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement.** `plugins/read-model/src/sensitiveConfig.ts`:

```ts
import { createHash } from "node:crypto";
import type { SensitiveMap } from "./types";

/** `["STEP_COMPLETED.output.ssn", …]` (a store's `sealingCapability().covers`) -> a {@link SensitiveMap}. */
export function sensitiveMapFromCovers(covers: readonly string[]): SensitiveMap {
  const out: Record<string, string[]> = {};
  for (const c of covers) {
    const dot = c.indexOf(".");
    if (dot <= 0 || dot === c.length - 1) continue;
    (out[c.slice(0, dot)] ??= []).push(c.slice(dot + 1));
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}

/** Union of any number of (optional) maps. */
export function mergeSensitive(...maps: (SensitiveMap | undefined)[]): SensitiveMap {
  const out: Record<string, string[]> = {};
  for (const m of maps) {
    for (const [type, paths] of Object.entries(m ?? {})) (out[type] ??= []).push(...paths);
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k])].sort();
  return out;
}

/**
 * The version written to the fold header: the declared version, plus a digest of the declared
 * sensitive map when there is one, so editing the paths rebuilds the model (ADR 0132 D5, D11).
 */
export function effectiveFoldVersion(version: string, declared: SensitiveMap): string {
  const entries = Object.keys(declared)
    .sort()
    .flatMap((type) => {
      const paths = [...new Set(declared[type])].sort();
      return paths.length === 0 ? [] : [[type, paths]];
    });
  if (entries.length === 0) return version;
  const digest = createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 8);
  return `${version}+sens.${digest}`;
}
```
In `FoldedModelEngine.ts`: import `{ effectiveFoldVersion, mergeSensitive } from "./sensitiveConfig"`, `{ foldView } from "./sensitiveInput"`, `{ assertStateClean } from "./sensitiveState"`, type `SensitiveMap`. Add `sensitive: SensitiveMap;` to `FoldedModel`. In `register`, rename the first local to `declaredVersion` (the blank check and its error use it) and, after the duplicate-id check, add:

```ts
    const sensitive = mergeSensitive(this.options.sensitive, def.sensitive);
    const version = effectiveFoldVersion(declaredVersion, sensitive);
```
then set `sensitive,` in the `model` literal (`beginFold(p.id, version)` and `version` already use the new constant). In `foldBatch`'s loop replace the handler call with:

```ts
        const view = foldView(modelId, e, model.sensitive);
        const base = state === null ? structuredClone(model.initial) : state;
        state = normalize(model, handler(base, view.event));
        assertStateClean({ modelId, executionId, eventType: e.eventType, sequence: e.sequence }, state, view.lifted);
```
In `index.ts` export `sensitiveMapFromCovers` (value) and `SensitiveMap` (type, from Task 1's list).

- [ ] **Step 4: Run** `pnpm --filter @loom/plugin-read-model exec vitest run` → PASS (all prior engine tests unchanged: an empty map and no markers leave events untouched).
- [ ] **Step 5: Commit**

```bash
git add plugins/read-model/src/sensitiveConfig.ts plugins/read-model/src/sensitiveConfig.test.ts plugins/read-model/src/FoldedModelEngine.ts plugins/read-model/src/foldedEngine.test.ts plugins/read-model/src/index.ts
git commit -m "feat(read-model): wire the sensitive-state guard into the fold and fold version (ADR 0132 D5/D11)"
```

---

### Task 6a: State cache — the bounded LRU (D15)

**Files:**
- Create: `plugins/read-model/src/foldStateCache.ts`
- Create: `plugins/read-model/src/foldStateCache.test.ts`

**Interfaces:**
- Consumes: Task 1 `FoldBase`.
- Produces: `class FoldStateCache(maxEntries)` with `size`, `take(modelId, executionId): FoldBase | undefined` (REMOVES the entry), `put(modelId, executionId, entry)`, `delete(modelId, executionId)`, `deleteModel(modelId)`, `clear()`. Pure, no I/O.

- [ ] **Step 1: Failing test** — `plugins/read-model/src/foldStateCache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FoldStateCache } from "./foldStateCache";

const base = (sequence: number) => ({ sequence, state: { n: sequence }, erased: false });

describe("FoldStateCache (ADR 0132 D15)", () => {
  it("take returns the entry and REMOVES it, so a failed fold never leaves a half-mutated base behind", () => {
    const c = new FoldStateCache(4);
    c.put("m", "x", base(2));
    expect(c.take("m", "x")).toEqual(base(2));
    expect(c.take("m", "x")).toBeUndefined();
    expect(c.size).toBe(0);
  });

  it("evicts the least recently used entry beyond maxEntries", () => {
    const c = new FoldStateCache(2);
    c.put("m", "a", base(1));
    c.put("m", "b", base(1));
    c.put("m", "c", base(1)); // a is the oldest
    expect(c.size).toBe(2);
    expect(c.take("m", "a")).toBeUndefined();
    expect(c.take("m", "b")).toBeDefined();
  });

  it("a re-put makes the key the most recent", () => {
    const c = new FoldStateCache(2);
    c.put("m", "a", base(1));
    c.put("m", "b", base(1));
    c.put("m", "a", base(2));
    c.put("m", "c", base(1)); // b is now the oldest
    expect(c.take("m", "b")).toBeUndefined();
    expect(c.take("m", "a")).toEqual(base(2));
  });

  it("keys are per model", () => {
    const c = new FoldStateCache(4);
    c.put("m1", "x", base(1));
    c.put("m2", "x", base(5));
    expect(c.take("m2", "x")).toEqual(base(5));
  });

  it("deleteModel drops one model's entries only; clear drops all", () => {
    const c = new FoldStateCache(8);
    c.put("m1", "a", base(1));
    c.put("m1", "b", base(1));
    c.put("m2", "a", base(1));
    c.deleteModel("m1");
    expect(c.size).toBe(1);
    c.clear();
    expect(c.size).toBe(0);
  });

  it("refuses a non-positive or fractional size (disable by not constructing one)", () => {
    expect(() => new FoldStateCache(0)).toThrow(RangeError);
    expect(() => new FoldStateCache(1.5)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run, verify fail** → FAIL.
- [ ] **Step 3: Implement** `plugins/read-model/src/foldStateCache.ts`:

```ts
import type { FoldBase } from "./types";

// ── ADR 0132 D15 — a bounded per-node LRU of fold bases (pure) ────────────────
// The store's monotonic compare-and-set stays the authority; an entry is only a guess at the base a
// live apply starts from. Map insertion order IS the recency order.

export class FoldStateCache {
  private readonly entries = new Map<string, FoldBase>();

  constructor(readonly maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(`FoldStateCache: maxEntries must be a positive integer (got ${maxEntries}); disable the cache instead`);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** Return AND remove: a fold that throws mid-way must leave the key absent, not half-mutated. */
  take(modelId: string, executionId: string): FoldBase | undefined {
    const k = key(modelId, executionId);
    const hit = this.entries.get(k);
    if (hit !== undefined) this.entries.delete(k);
    return hit;
  }

  put(modelId: string, executionId: string, entry: FoldBase): void {
    const k = key(modelId, executionId);
    this.entries.delete(k);
    this.entries.set(k, entry);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  delete(modelId: string, executionId: string): void {
    this.entries.delete(key(modelId, executionId));
  }

  /** O(entries): used on version change, purge and rebuild, which are rare. */
  deleteModel(modelId: string): void {
    const prefix = `${modelId}\u0000`;
    for (const k of [...this.entries.keys()]) if (k.startsWith(prefix)) this.entries.delete(k);
  }

  clear(): void {
    this.entries.clear();
  }
}

const key = (modelId: string, executionId: string): string => `${modelId}\u0000${executionId}`;
```

- [ ] **Step 4: Run, verify pass** — `pnpm --filter @loom/plugin-read-model exec vitest run src/foldStateCache.test.ts`.
- [ ] **Step 5: Commit**

```bash
git add plugins/read-model/src/foldStateCache.ts plugins/read-model/src/foldStateCache.test.ts
git commit -m "feat(read-model): bounded LRU for fold bases (ADR 0132 D15)"
```

---

### Task 6b: State cache — wired into the live apply path (D4, D15)

**Files:**
- Modify: `plugins/read-model/src/FoldedModelEngine.ts`
- Create: `plugins/read-model/src/foldedCache.test.ts`

**Interfaces:**
- Consumes: Tasks 4a/4b/5c, 6a.
- Produces on `FoldedModelEngine`: `cacheSize(): number`; `foldOutcome(...)` returning `FoldOutcome { result: FoldedApplyResult | "noop"; record?: FoldBase }`; `foldBatch` keeps its signature (now `rec: FoldBase | undefined`) and invalidates the entry; `applyLive` reads and writes the cache. Cache config comes from `FoldedEngineOptions.cache` (Task 1): default `DEFAULT_FOLD_CACHE_ENTRIES`, `false` or `{ maxEntries: 0 }` disables.

- [ ] **Step 1: Failing tests** — `plugins/read-model/src/foldedCache.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FoldedModelEngine } from "./FoldedModelEngine";
import { evt, ingestProjection } from "./foldedFixtures";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import type { FoldedRecord } from "./types";

const X = "u1:wf:ingest-d1";

/** Deterministic evidence: how many times the engine went to the store for a base. */
class CountingStore extends InMemoryReadModelStore {
  reads = 0;
  override async getFolded(modelId: string, executionIds: readonly string[]): Promise<FoldedRecord[]> {
    this.reads++;
    return super.getFolded(modelId, executionIds);
  }
}

async function node(store: CountingStore, opts: ConstructorParameters<typeof FoldedModelEngine>[2] = {}, onError: (e: unknown) => void = (e) => { throw e; }) {
  const engine = new FoldedModelEngine(store as never, onError, opts);
  await engine.register({ projection: ingestProjection() });
  return engine;
}
const step = (id: string, n: number) => evt(id, n, "STEP_COMPLETED", { step: `s${n}` });
const stepsOf = async (store: InMemoryReadModelStore, id = X) =>
  ((await store.getFolded("ingest-status", [id]))[0]?.state as { steps: number } | undefined)?.steps;

describe("FoldedModelEngine — live-path state cache (D15)", () => {
  it("reads the row once for N sequential live events on a hot execution", async () => {
    const store = new CountingStore();
    const engine = await node(store);
    for (let i = 0; i < 10; i++) engine.handle(step(X, i));
    await engine.drain();
    expect(store.reads).toBe(1); // the first event's base; the other nine come from the cache
    expect(await stepsOf(store)).toBe(10);
  });

  it("reads before every apply when the cache is disabled", async () => {
    for (const cache of [false, { maxEntries: 0 }] as const) {
      const store = new CountingStore();
      const engine = await node(store, { cache });
      for (let i = 0; i < 10; i++) engine.handle(step(X, i));
      await engine.drain();
      expect(store.reads).toBe(10);
      expect(engine.cacheSize()).toBe(0);
      expect(await stepsOf(store)).toBe(10);
    }
  });

  it("is bounded by maxEntries, and an eviction costs exactly one re-read", async () => {
    const store = new CountingStore();
    const engine = await node(store, { cache: { maxEntries: 2 } });
    const [A, B, C] = ["u1:wf:ingest-a", "u1:wf:ingest-b", "u1:wf:ingest-c"];
    for (const id of [A, B, C]) engine.handle(step(id, 0));
    await engine.drain();
    expect(store.reads).toBe(3);
    expect(engine.cacheSize()).toBe(2); // A was evicted when C was cached
    engine.handle(step(C, 1)); // hit
    await engine.drain();
    expect(store.reads).toBe(3);
    engine.handle(step(A, 1)); // evicted: one re-read, still correct
    await engine.drain();
    expect(store.reads).toBe(4);
    expect(await stepsOf(store, A)).toBe(2);
  });
});
```
- [ ] **Step 2: Run, verify fail** (`cacheSize` / `cache` option not honoured).

- [ ] **Step 3: Implement** in `FoldedModelEngine.ts`. Imports: `FoldStateCache` from `./foldStateCache`, `DEFAULT_FOLD_CACHE_ENTRIES` from `./types`. Add the field and constructor body:

```ts
  private readonly cache: FoldStateCache | undefined;

  // the constructor from Task 4a keeps its parameter properties; its empty body becomes:
  //   constructor(store, onError, options = {}) {
  //     const c = options.cache;
  //     const max = c === false ? 0 : (c?.maxEntries ?? DEFAULT_FOLD_CACHE_ENTRIES);
  //     this.cache = max > 0 ? new FoldStateCache(max) : undefined;
  //   }

  cacheSize(): number {
    return this.cache?.size ?? 0;
  }
```
In `register`, right after `this.models.set(p.id, model)`: `this.cache?.deleteModel(p.id);`. In `purge`, replace `return this.store.purgeFolded(modelId, selector);` with `const n = await this.store.purgeFolded(modelId, selector); this.cache?.deleteModel(modelId); return n;`. In `reset`, add `this.cache?.deleteModel(modelId);` after `await this.drain();`.

Replace `foldBatch` and `applyLive` with:

```ts
  /** Fold and CAS-write for catch-up / refresh / rebuild. True when the write applied. */
  async foldBatch(
    modelId: string,
    executionId: string,
    rec: FoldBase | undefined,
    events: readonly EventEnvelope[]
  ): Promise<boolean> {
    try {
      return (await this.foldOutcome(modelId, executionId, rec, events)).result === "applied";
    } finally {
      // These paths advance the row behind any cached base; the live path re-reads rather than trust it.
      this.cache?.delete(modelId, executionId);
    }
  }

  /** As {@link foldBatch}, but reports the CAS result and the record this write produced. */
  protected async foldOutcome(
    modelId: string,
    executionId: string,
    rec: FoldBase | undefined,
    events: readonly EventEnvelope[]
  ): Promise<FoldOutcome> {
    const model = this.models.get(modelId);
    if (model === undefined) throw new TypeError(`read model "${modelId}" is not a registered folded model`);
    const from = rec?.sequence ?? -1;
    const todo = events.filter((e) => e.sequence > from);
    if (todo.length === 0) return { result: "noop" };
    const erased = rec?.erased === true;
    let state: unknown = rec?.state ?? null;
    if (!erased) {
      for (const e of todo) {
        const handler = model.handlers[e.eventType];
        if (handler === undefined) continue;
        const view = foldView(modelId, e, model.sensitive);
        const base = state === null ? structuredClone(model.initial) : state;
        state = normalize(model, handler(base, view.event));
        assertStateClean({ modelId, executionId, eventType: e.eventType, sequence: e.sequence }, state, view.lifted);
      }
    }
    const upToSequence = todo[todo.length - 1]!.sequence;
    const result = await this.store.applyFolded({
      modelId,
      executionId,
      upToSequence,
      state,
      key: model.keyOf?.(executionId) ?? null,
      scope: model.scopeOf?.(executionId) ?? null,
      foldVersion: model.version,
    });
    if (result === "version-mismatch") {
      this.cache?.deleteModel(modelId); // another node rebuilt: nothing cached for this model is trustworthy
      throw new FoldVersionMismatchError(modelId, model.version);
    }
    return { result, record: { sequence: upToSequence, state, erased } };
  }

  private async applyLive(model: FoldedModel, event: EventEnvelope): Promise<void> {
    const id = event.executionId;
    // `useCache` is true only on the first pass; every retry goes to the store.
    for (let useCache = this.cache !== undefined; ; useCache = false) {
      const cached = useCache ? this.cache?.take(model.id, id) : undefined;
      const rec: FoldBase | undefined = cached ?? (await this.mark(model.id, id));
      const from = rec?.sequence ?? -1;
      if (event.sequence <= from) {
        if (cached !== undefined) this.cache?.put(model.id, id, cached); // still a valid guess
        return;
      }
      let events: readonly EventEnvelope[];
      if (event.sequence === from + 1) events = [event];
      else if (cached !== undefined) continue; // the cache never decides a gap: another node may be ahead
      else if (this.options.liveSource !== undefined) events = await this.options.liveSource.readFrom(id, from + 1);
      else throw new FoldGapError(model.id, id, from, event.sequence);
      const out = await this.foldOutcome(model.id, id, rec, events);
      if (out.result === "applied" && out.record !== undefined) {
        this.cache?.put(model.id, id, out.record);
        return;
      }
      if (out.result === "stale" && cached !== undefined) continue; // lost the CAS on a possibly stale base: re-read once
      return;
    }
  }
```
and export `interface FoldOutcome { result: FoldedApplyResult | "noop"; record?: FoldBase }`. (`FoldBase` and `FoldedApplyResult` are in the type import from Task 4a.)

- [ ] **Step 4: Run** `pnpm --filter @loom/plugin-read-model exec vitest run` → PASS (all earlier engine/service tests: the cache is on by default and must change no result).
- [ ] **Step 5: Commit**

```bash
git add plugins/read-model/src/FoldedModelEngine.ts plugins/read-model/src/foldedCache.test.ts
git commit -m "feat(read-model): per-node fold-base cache on the live apply path (ADR 0132 D15)"
```

---

### Task 6c: State cache — correctness under conflict, version, purge and reads (D15)

**Files:**
- Modify: `plugins/read-model/src/foldedCache.test.ts`
- Modify: `plugins/read-model/src/FoldedModelEngine.ts` (only if a test exposes a bug; note it in the commit)

**Interfaces:** consumes Task 6b; adds tests only.

- [ ] **Step 1: Write the tests** — append to `foldedCache.test.ts`:

```ts
describe("FoldedModelEngine — the cache never weakens correctness (D15)", () => {
  it("a lost CAS drops the entry, re-reads once and converges", async () => {
    const store = new CountingStore();
    const a = await node(store);
    const b = await node(store);
    for (const i of [0, 1]) a.handle(step(X, i));
    await a.drain(); // a caches a base at sequence 1
    for (const i of [2, 3]) b.handle(step(X, i));
    await b.drain(); // b advances the row to 3 behind a's back
    const before = store.reads;
    a.handle(step(X, 2)); // a folds 2 from its stale base -> CAS says stale
    await a.drain();
    expect(store.reads - before).toBe(1); // exactly one re-read, then the event is seen as already folded
    expect(await stepsOf(store)).toBe(4);
    expect(a.cacheSize()).toBe(0);
  });

  it("never decides a gap: a cached base behind another node re-reads the store instead of failing", async () => {
    const errs: unknown[] = [];
    const store = new CountingStore();
    const a = await node(store, {}, (e) => errs.push(e)); // NO liveSource: a gap would be a FoldGapError
    const b = await node(store);
    a.handle(step(X, 0));
    await a.drain();
    for (const i of [1, 2, 3]) b.handle(step(X, i));
    await b.drain();
    a.handle(step(X, 4)); // a's cache says 0, the event says 4; the store says 3
    await a.drain();
    expect(errs).toEqual([]);
    expect(await stepsOf(store)).toBe(5);
  });

  it("a rebuilt model on another node drops this node's entries and refuses its next apply", async () => {
    const errs: unknown[] = [];
    const store = new CountingStore();
    const old = await node(store, {}, (e) => errs.push(e));
    old.handle(step(X, 0));
    await old.drain();
    expect(old.cacheSize()).toBe(1);
    await new FoldedModelEngine(store as never, () => {}).register({ projection: ingestProjection("2") });
    old.handle(step(X, 1));
    await old.drain();
    expect(String(errs[0])).toMatch(/version "1"/);
    expect(old.cacheSize()).toBe(0);
  });

  it("purge and reset drop the model's entries: the next live event reads the store", async () => {
    const store = new CountingStore();
    const engine = await node(store);
    engine.handle(step(X, 0));
    await engine.drain();
    expect(await engine.purge("ingest-status", { executionId: X })).toBe(1);
    expect(engine.cacheSize()).toBe(0);
    const before = store.reads;
    engine.handle(step(X, 1)); // tombstoned: sequence advances, state stays absent
    await engine.drain();
    expect(store.reads - before).toBe(1);
    expect((await engine.getMany("ingest-status", [X])).size).toBe(0);

    engine.handle(step("u1:wf:ingest-z", 0));
    await engine.drain();
    await engine.reset("ingest-status");
    expect(engine.cacheSize()).toBe(0);
  });

  it("reads never come from the cache: getMany sees another node's progress and costs one store read", async () => {
    const store = new CountingStore();
    const a = await node(store);
    const b = await node(store);
    a.handle(step(X, 0));
    await a.drain(); // a's cache holds sequence 0
    for (const i of [1, 2]) b.handle(step(X, i));
    await b.drain();
    const before = store.reads;
    const got = await a.getMany("ingest-status", [X]);
    expect(store.reads - before).toBe(1);
    expect(got.get(X)).toMatchObject({ sequence: 2, state: { steps: 3 } });
  });

  it("refresh and catch-up writes invalidate the entry so a later live event re-reads", async () => {
    const store = new CountingStore();
    const engine = await node(store);
    engine.handle(step(X, 0));
    await engine.drain();
    await engine.foldBatch("ingest-status", X, await engine.mark("ingest-status", X), [step(X, 1)]);
    expect(engine.cacheSize()).toBe(0);
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @loom/plugin-read-model exec vitest run src/foldedCache.test.ts` → PASS. A failure here is a real correctness bug in Task 6b: fix the engine, never loosen a test or add a wait.
- [ ] **Step 3: Commit**

```bash
git add plugins/read-model/src/foldedCache.test.ts plugins/read-model/src/FoldedModelEngine.ts
git commit -m "test(read-model): fold-base cache stays correct under conflict, rebuild, purge and reads (ADR 0132 D15)"
```

---

### Task 7a: Service wiring — register, live fan-out, shared catch-up (D13)

**Files:**
- Modify: `plugins/read-model/src/ReadModelService.ts`
- Create: `plugins/read-model/src/foldedService.test.ts`

**Interfaces:**
- Consumes: `FoldedModelEngine` (with the guard from Task 5c and the cache from Task 6b), `foldedCapable`, `FoldedEngineOptions`.
- Produces on `ReadModelService`: `ReadModelServiceOptions.liveSource?: ReadModelEventSource`, `.sensitive?: SensitiveMap` (D11), `.foldCache?: FoldCacheOptions | false` (D15), all handed to the engine; `registerFolded<S>(def): Promise<{rebuilt:boolean}>`; `getMany`, `getManyByKey` (delegating; `opts` as engine); `drain(): Promise<void>`; catch-up folds folded models in the same scan.

- [ ] **Step 1: Failing tests** — `plugins/read-model/src/foldedService.test.ts`:

```ts
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { evt, ingestProjection, keyOf, scopeOf } from "./foldedFixtures";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { ReadModelService } from "./ReadModelService";
import { FoldedUnsupportedError } from "./types";
import type { ReadModelStore } from "./types";

const X = "u1:wf:ingest-d1";

async function boot(opts: ConstructorParameters<typeof ReadModelService>[1] = {}) {
  const store = new InMemoryReadModelStore();
  const service = new ReadModelService(store, opts);
  await service.registerFolded({ projection: ingestProjection(), keyOf, scopeOf });
  return { store, service };
}

describe("ReadModelService folded models — wiring (D13)", () => {
  it("live handleEvent and catch-up converge on one state", async () => {
    const { service } = await boot();
    const log = new InMemoryAsyncEventStore();
    const events = [evt(X, 0, "STEP_COMPLETED", { step: "a" }), evt(X, 1, "EXECUTION_COMPLETED")];
    for (const e of events) await log.append(e);
    service.handleEvent(events[0]!);
    await service.drain();
    await service.catchUp([log]); // re-delivers 0, folds 1
    await service.catchUp([log]); // watermark makes this a no-op scan
    const got = await service.getMany("ingest-status", [X]);
    expect(got.get(X)?.state).toEqual({ status: "done", steps: 1, last: "a" });
  });

  it("one shared read serves row models and folded models in the same scan", async () => {
    const { service } = await boot();
    service.register({
      id: "rows",
      kinds: ["STEP_COMPLETED"],
      indexes: ["step"],
      extract: (e) => [{ fields: { step: (e.payload as { step: string }).step } }],
    });
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    const report = await service.catchUp([log]);
    expect(report.eventsScanned).toBe(1);
    expect((await service.query("rows")).rows).toHaveLength(1);
    expect((await service.getMany("ingest-status", [X])).size).toBe(1);
  });

  it("reserved __loom_* streams are never folded", async () => {
    const { service } = await boot();
    service.handleEvent(evt("__loom_lifecycle__", 0, "STEP_COMPLETED", { step: "x" }));
    await service.drain();
    expect((await service.getMany("ingest-status", ["__loom_lifecycle__"])).size).toBe(0);
  });

  it("a gap in the live tail is filled from liveSource", async () => {
    const log = new InMemoryAsyncEventStore();
    const { service } = await boot({ liveSource: log });
    for (let i = 0; i < 3; i++) await log.append(evt(X, i, "STEP_COMPLETED", { step: `s${i}` }));
    service.handleEvent(evt(X, 2, "STEP_COMPLETED", { step: "s2" })); // cold node, missed 0..1
    await service.drain();
    expect((await service.getMany("ingest-status", [X])).get(X)?.state).toMatchObject({ steps: 3 });
  });

  it("registerFolded on a backend without the methods refuses with a typed error", async () => {
    const bare: ReadModelStore = {
      apply: async () => {}, watermark: async () => null, watermarkedExecutions: async () => [],
      query: async () => ({ rows: [] }), clear: async () => {},
    };
    await expect(new ReadModelService(bare).registerFolded({ projection: ingestProjection() }))
      .rejects.toBeInstanceOf(FoldedUnsupportedError);
  });

  it("model ids are one namespace across row and folded kinds", async () => {
    const { service } = await boot();
    expect(() => service.register({ id: "ingest-status", kinds: ["A"], indexes: [], extract: () => [] })).toThrow(/already registered/);
  });
});
```

- [ ] **Step 2: Run, verify fail** (registerFolded undefined).

- [ ] **Step 3: Implement** in `ReadModelService.ts`.

(a) Imports: add `FoldCacheOptions, FoldedReadModelDefinition, FoldedRecord, FoldedState, ReadModelEventSource, SensitiveMap` types as needed, `FoldedUnsupportedError` from `./types`, and `import { FoldedModelEngine, foldedCapable } from "./FoldedModelEngine";`.

(b) Options: add to `ReadModelServiceOptions`:
```ts
  /** Fills a gap in the live tail (ADR 0132 D4) — normally this node's own event store. */
  liveSource?: ReadModelEventSource;
  /** Sensitive payload paths every folded model must never see (D11) — the map you gave `EncryptingEventStore`. */
  sensitive?: SensitiveMap;
  /** Per-node state cache for the live apply path (D15). Default on; `false` disables. */
  foldCache?: FoldCacheOptions | false;
```
Keep `options` as `private readonly options: ReadModelServiceOptions` (change the constructor param to `private readonly options: ReadModelServiceOptions = {}` and use `options.onError`, i.e. replace the local `options.onError ??` references with `this.options.onError ??` — the constructor body already reads it).

(c) Field + registration:
```ts
  private folded?: FoldedModelEngine;

  async registerFolded<S>(def: FoldedReadModelDefinition<S>): Promise<{ rebuilt: boolean }> {
    const id = def.projection.id;
    if (this.models.has(id)) throw new TypeError(`read model "${id}" is already registered`);
    if (!foldedCapable(this.store)) throw new FoldedUnsupportedError(id);
    this.folded ??= new FoldedModelEngine(this.store, this.onError, {
      ...(this.options.liveSource !== undefined && { liveSource: this.options.liveSource }),
      ...(this.options.sensitive !== undefined && { sensitive: this.options.sensitive }),
      ...(this.options.foldCache !== undefined && { cache: this.options.foldCache }),
    });
    return this.folded.register(def);
  }
```
and at the top of `register(model)` add: `if (this.folded?.has(model.id)) throw new TypeError(\`read model "${model.id}" is already registered\`);`

(d) `handleEvent`: after the reserved-stream guard insert `this.folded?.handle(event);` BEFORE the `interested === undefined` early return.

(e) Replace `catchUp` with a version that delegates to a private `scan(sources, only?)`; the body of `scan` is the existing loop with these changes (shown in full):

```ts
  async catchUp(sources: readonly ReadModelEventSource[]): Promise<CatchUpReport> {
    return this.scan(sources);
  }

  private async scan(sources: readonly ReadModelEventSource[], only?: string): Promise<CatchUpReport> {
    const report: CatchUpReport = { executionsScanned: 0, eventsScanned: 0, rowsApplied: 0 };
    const rowModels = only === undefined ? [...this.models.values()] : [];
    const folded = this.folded;
    const foldedIds = folded === undefined ? [] : folded.ids().filter((id) => only === undefined || id === only);
    for (const source of sources) {
      if (source.listExecutions === undefined && source.listExecutionsPage === undefined) {
        throw new TypeError(
          "ReadModelService.catchUp: every event source must support listExecutionsPage() or listExecutions() — a source that cannot be enumerated cannot be indexed completely"
        );
      }
      for await (const executionId of iterateExecutionIds(source)) {
        if (isReservedStream(executionId)) continue;
        report.executionsScanned++;
        if (rowModels.length === 0 && foldedIds.length === 0) continue;
        // ONE shared read per execution from the MIN frontier across row AND folded models.
        const marks = new Map<string, number>();
        const recs = new Map<string, FoldedRecord | undefined>();
        let frontier = Number.POSITIVE_INFINITY;
        for (const model of rowModels) {
          const mark = (await this.store.watermark(model.id, executionId)) ?? -1;
          marks.set(model.id, mark);
          if (mark < frontier) frontier = mark;
        }
        for (const id of foldedIds) {
          const rec = await folded!.mark(id, executionId);
          recs.set(id, rec);
          const mark = rec?.sequence ?? -1;
          marks.set(id, mark);
          if (mark < frontier) frontier = mark;
        }
        const events = await source.readFrom(executionId, frontier + 1);
        if (events.length === 0) continue;
        report.eventsScanned += events.length;
        const tip = events[events.length - 1]!.sequence;
        for (const model of rowModels) {
          const from = marks.get(model.id)!;
          if (tip <= from) continue;
          const kinds = this.kindSets.get(model.id)!;
          const rows: ReadModelRow[] = [];
          for (const event of events) {
            if (event.sequence > from && kinds.has(event.eventType)) rows.push(...toRows(model, event));
          }
          await this.store.apply(model.id, executionId, tip, rows);
          report.rowsApplied += rows.length;
        }
        for (const id of foldedIds) {
          if (tip <= marks.get(id)!) continue;
          await folded!.foldBatch(id, executionId, recs.get(id), events);
        }
      }
    }
    return report;
  }
```
(the row-model body is unchanged from today; keep its existing comments when editing).

(f) Delegating reads:
```ts
  getMany<S = unknown>(modelId: string, executionIds: readonly string[], opts?: { refreshFrom?: readonly ReadModelEventSource[]; concurrency?: number }): Promise<Map<string, FoldedState<S>>> {
    return this.engine(modelId).getMany(modelId, executionIds, opts) as Promise<Map<string, FoldedState<S>>>;
  }
  getManyByKey<S = unknown>(modelId: string, keys: readonly string[], opts?: { refreshFrom?: readonly ReadModelEventSource[]; concurrency?: number }): Promise<Map<string, FoldedState<S>[]>> {
    return this.engine(modelId).getManyByKey(modelId, keys, opts) as Promise<Map<string, FoldedState<S>[]>>;
  }
  /** Await this node's in-flight live applies (tests, graceful shutdown). */
  async drain(): Promise<void> {
    await this.folded?.drain();
  }
  private engine(modelId: string): FoldedModelEngine {
    if (this.folded === undefined || !this.folded.has(modelId)) {
      throw new TypeError(`read model "${modelId}" is not a registered folded model`);
    }
    return this.folded;
  }
```
Also export `FoldedModelEngine`? No (internal).

- [ ] **Step 4: Run all read-model tests** — `pnpm --filter @loom/plugin-read-model exec vitest run` → PASS (existing row tests unchanged: confirms the `scan` refactor).
- [ ] **Step 5: Commit**

```bash
git add plugins/read-model/src/ReadModelService.ts plugins/read-model/src/foldedService.test.ts
git commit -m "feat(read-model): registerFolded, live fan-out and shared catch-up for folded models (ADR 0132 D13)"
```

---

### Task 7b: Service — refresh, purgeFolded, rebuild, pins (D5, D8, D12)

**Files:**
- Modify: `plugins/read-model/src/ReadModelService.ts`
- Modify: `plugins/read-model/src/foldedService.test.ts`

**Interfaces:**
- Produces: `ReadModelService.refresh(modelId, executionIds, sources, concurrency?)`, `purgeFolded(modelId, selector)`, `rebuild` works for folded ids, `pins()` includes folded versions.

- [ ] **Step 1: Failing tests** — append to `foldedService.test.ts`:

```ts
describe("ReadModelService folded models — refresh, erasure, rebuild, pins", () => {
  it("getMany({ refreshFrom }) is read-your-writes without any live feed", async () => {
    const { service } = await boot();
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "EXECUTION_COMPLETED"));
    const got = await service.getMany("ingest-status", [X], { refreshFrom: [log] });
    expect(got.get(X)?.state).toMatchObject({ status: "done" });
  });

  it("purgeFolded tombstones; a later catch-up and later events do not resurrect it", async () => {
    const { service } = await boot();
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await service.catchUp([log]);
    expect(await service.purgeFolded("ingest-status", { scope: "u1" })).toBe(1);
    await log.append(evt(X, 1, "EXECUTION_COMPLETED"));
    await service.catchUp([log]);
    service.handleEvent(evt(X, 2, "STEP_COMPLETED", { step: "late" }));
    await service.drain();
    expect((await service.getMany("ingest-status", [X])).size).toBe(0);
  });

  it("purgeFolded refuses an unregistered model", async () => {
    const { service } = await boot();
    await expect(service.purgeFolded("nope", { key: "a" })).rejects.toThrow(/not a registered folded model/);
  });

  it("a changed fold version rebuilds on registration and the next catch-up re-folds from the log", async () => {
    const store = new InMemoryReadModelStore();
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    const v1 = new ReadModelService(store);
    expect(await v1.registerFolded({ projection: ingestProjection("1") })).toEqual({ rebuilt: false });
    await v1.catchUp([log]);

    const v2 = new ReadModelService(store);
    expect(await v2.registerFolded({ projection: ingestProjection("2") })).toEqual({ rebuilt: true });
    expect((await v2.getMany("ingest-status", [X])).size).toBe(0);
    const report = await v2.catchUp([log]);
    expect(report.eventsScanned).toBe(1);
    expect((await v2.getMany("ingest-status", [X])).size).toBe(1);
  });

  it("an old-version node is refused after a rebuild instead of corrupting the new fold", async () => {
    const store = new InMemoryReadModelStore();
    const errs: unknown[] = [];
    const old = new ReadModelService(store, { onError: (e) => errs.push(e) });
    await old.registerFolded({ projection: ingestProjection("1") });
    await new ReadModelService(store).registerFolded({ projection: ingestProjection("2") });
    old.handleEvent(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await old.drain();
    expect(String(errs[0])).toMatch(/version "1"/);
    expect((await store.getFolded("ingest-status", [X]))).toEqual([]);
  });

  it("rebuild(modelId) clears and re-folds a folded model; pins() reports its version", async () => {
    const { service } = await boot();
    const log = new InMemoryAsyncEventStore();
    await log.append(evt(X, 0, "STEP_COMPLETED", { step: "a" }));
    await service.catchUp([log]);
    expect(service.pins()).toEqual({ "ingest-status": "1" });
    const report = await service.rebuild("ingest-status", [log]);
    expect(report.eventsScanned).toBe(1);
    expect((await service.getMany("ingest-status", [X])).get(X)?.sequence).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** in `ReadModelService.ts`:

```ts
  refresh(modelId: string, executionIds: readonly string[], sources: readonly ReadModelEventSource[], concurrency?: number): Promise<number> {
    return this.engine(modelId).refresh(modelId, executionIds, sources, concurrency);
  }

  /** Tombstone folded states (ADR 0132 D12). Exactly one of executionId / key / scope. */
  purgeFolded(modelId: string, selector: FoldedSelector): Promise<number> {
    return this.engine(modelId).purge(modelId, selector);
  }
```
(import `FoldedSelector`). In `pins()` add after the row loop: `for (const [id, version] of this.folded?.versions() ?? []) pins[id] = version;`. In `rebuild`, replace the first guard so the folded case precedes it:

```ts
    if (this.folded?.has(modelId)) {
      await this.folded.reset(modelId);
      return this.scan(sources, modelId);
    }
```
(keep the existing `!this.models.has` TypeError after it).

Doc comment on `purgeFolded`: "A tombstone for an execution that exists; rebuild un-tombstones — see ADR 0132 D12 for the tolerant-source obligation."

- [ ] **Step 4: Run** `pnpm --filter @loom/plugin-read-model exec vitest run` → PASS.
- [ ] **Step 5: Commit**

```bash
git add plugins/read-model/src/ReadModelService.ts plugins/read-model/src/foldedService.test.ts
git commit -m "feat(read-model): folded refresh, tombstone purge, version rebuild and pins (ADR 0132 D5/D8/D12)"
```

---

### Task 8: Rebuild == incremental, multi-node and cached-node convergence (D3, D14, D15)

**Files:**
- Create: `plugins/read-model/src/foldedConvergence.test.ts`

**Interfaces:** consumes only public service API (no production change expected; if a test exposes a bug, fix it in the owning file and note it in the commit).

- [ ] **Step 1: Write the tests** — `plugins/read-model/src/foldedConvergence.test.ts`:

```ts
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import { evt, ingestProjection, keyOf, scopeOf } from "./foldedFixtures";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { ReadModelService } from "./ReadModelService";

// A log with interleaved executions, one with a `.2` generation, and unhandled noise.
const ids = ["u1:wf:ingest-d1", "u1:wf:ingest-d1.2", "u2:wf:ingest-d2"];
function corpus(): EventEnvelope[] {
  const out: EventEnvelope[] = [];
  for (const id of ids) {
    out.push(evt(id, 0, "EXECUTION_STARTED"));
    out.push(evt(id, 1, "STEP_COMPLETED", { step: "ocr" }));
    out.push(evt(id, 2, "NOISE"));
    out.push(evt(id, 3, "STEP_COMPLETED", { step: "embed" }));
    out.push(evt(id, 4, id.endsWith(".2") ? "EXECUTION_FAILED" : "EXECUTION_COMPLETED"));
  }
  return out;
}
async function logOf(events: EventEnvelope[]) {
  const log = new InMemoryAsyncEventStore();
  for (const e of events) await log.append(e);
  return log;
}
async function service(store = new InMemoryReadModelStore()) {
  const s = new ReadModelService(store);
  await s.registerFolded({ projection: ingestProjection(), keyOf, scopeOf });
  return { store, s };
}
const snapshot = async (s: ReadModelService) =>
  Object.fromEntries(await s.getMany("ingest-status", ids).then((m) => [...m]));

describe("folded models: rebuild == incremental (D14)", () => {
  it("live-only, catch-up-only, partial-prefix-then-catch-up and rebuild all agree", async () => {
    const events = corpus();
    const log = await logOf(events);

    const live = await service();
    for (const e of events) live.s.handleEvent(e);
    await live.s.drain();

    const scan = await service();
    await scan.s.catchUp([log]);

    const prefix = await service();
    for (const e of events.filter((e) => e.sequence < 2)) prefix.s.handleEvent(e);
    await prefix.s.drain();
    await prefix.s.catchUp([log]);

    const rebuilt = await service();
    await rebuilt.s.catchUp([log]);
    await rebuilt.s.rebuild("ingest-status", [log]);

    const expected = await snapshot(live.s);
    expect(Object.keys(expected)).toHaveLength(3);
    expect(await snapshot(scan.s)).toEqual(expected);
    expect(await snapshot(prefix.s)).toEqual(expected);
    expect(await snapshot(rebuilt.s)).toEqual(expected);
  });

  it("two nodes ingesting the same events concurrently into one store converge", async () => {
    const events = corpus();
    const store = new InMemoryReadModelStore();
    const a = await service(store);
    const b = await service(store);
    // opposite orders per node; per-execution order is the log's, interleaving is arbitrary
    for (const e of events) a.s.handleEvent(e);
    for (const e of [...events].reverse().sort((x, y) => x.sequence - y.sequence)) b.s.handleEvent(e);
    await Promise.all([a.s.drain(), b.s.drain()]);
    await a.s.catchUp([await logOf(events)]); // heals whatever a lost race left out
    const ref = await service();
    await ref.s.catchUp([await logOf(events)]);
    expect(await snapshot(a.s)).toEqual(await snapshot(ref.s));
  });

  it("the state cache cannot change a result: cache on, cache off and a disabled-by-size cache agree", async () => {
    const events = corpus();
    const log = await logOf(events);
    const snaps = [];
    for (const foldCache of [undefined, false, { maxEntries: 1 }] as const) {
      const s = new ReadModelService(new InMemoryReadModelStore(), foldCache === undefined ? {} : { foldCache });
      await s.registerFolded({ projection: ingestProjection(), keyOf, scopeOf });
      for (const e of events) s.handleEvent(e);
      await s.drain();
      await s.catchUp([log]);
      snaps.push(await snapshot(s));
    }
    expect(snaps[1]).toEqual(snaps[0]);
    expect(snaps[2]).toEqual(snaps[0]);
  });

  it("two cached nodes that each saw only half of the events converge through the log (D15)", async () => {
    const events = corpus();
    const log = await logOf(events);
    const store = new InMemoryReadModelStore();
    const mk = async () => {
      const s = new ReadModelService(store, { liveSource: log }); // default cache ON, gaps filled from the log
      await s.registerFolded({ projection: ingestProjection(), keyOf, scopeOf });
      return s;
    };
    const a = await mk();
    const b = await mk();
    events.forEach((e, i) => (i % 2 === 0 ? a : b).handleEvent(e)); // each node's cache goes stale behind the other
    await Promise.all([a.drain(), b.drain()]);
    await a.catchUp([log]);
    const ref = new ReadModelService(new InMemoryReadModelStore());
    await ref.registerFolded({ projection: ingestProjection(), keyOf, scopeOf });
    await ref.catchUp([log]);
    expect(await snapshot(a)).toEqual(await snapshot(ref));
    expect(await snapshot(b)).toEqual(await snapshot(ref));
  });

  it("getManyByKey returns both generations of a document", async () => {
    const { s } = await service();
    await s.catchUp([await logOf(corpus())]);
    const got = await s.getManyByKey<{ status: string }>("ingest-status", ["d1"]);
    expect(got.get("d1")?.map((g) => [g.executionId, g.state.status])).toEqual([
      ["u1:wf:ingest-d1", "done"],
      ["u1:wf:ingest-d1.2", "failed"],
    ]);
  });
});
```

- [ ] **Step 2: Run** — `pnpm --filter @loom/plugin-read-model exec vitest run src/foldedConvergence.test.ts`. Expected: PASS. If the two-node test is flaky or fails, that is a real convergence bug: stop and root-cause (do not add waits).
- [ ] **Step 3: Commit**

```bash
git add plugins/read-model/src/foldedConvergence.test.ts
git commit -m "test(read-model): folded rebuild==incremental and multi-node convergence (ADR 0132 D14)"
```

---

### Task 9: Sensitive-state guard — service-level conformance across every feed (D11, D14)

**Files:**
- Create: `plugins/read-model/src/foldedSensitive.test.ts`

**Interfaces:** consumes the public service API plus the real `EncryptingEventStore` / `InMemoryKeyStore` from `@loom/plugin-crypto` (a devDependency already). No production change expected; a failure is a guard bug, fix it in the owning file.

- [ ] **Step 1: Write the tests** — `plugins/read-model/src/foldedSensitive.test.ts`:

```ts
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { projection$ } from "@loom/core";
import { describe, expect, it } from "vitest";
import { evt } from "./foldedFixtures";
import { InMemoryReadModelStore } from "./InMemoryReadModelStore";
import { ReadModelService } from "./ReadModelService";
import { sensitiveMapFromCovers } from "./sensitiveConfig";
import { SensitiveStateError } from "./sensitiveState";

const EMAIL = "alice@example.com";
const SENSITIVE = { STEP_COMPLETED: ["email"] };
const X = "u1:wf:ingest-d1";

interface S { steps: number; owner?: string }
/** Copies BOTH the sealed field and a plain duplicate of it into state, one field per projection. */
const proj = (id: string, field: "email" | "mirror" | "step") =>
  projection$<S>({
    id,
    name: id,
    version: "1",
    initialState: { steps: 0 },
    handlers: {
      STEP_COMPLETED: (s, e) => ({ ...s, steps: s.steps + 1, owner: (e.payload as Record<string, string>)[field] }),
    },
  });

async function logs() {
  const raw = new InMemoryAsyncEventStore();
  const keys = new InMemoryKeyStore();
  const enc = new EncryptingEventStore(raw, keys, { sensitive: SENSITIVE, subjectOf: (e) => e.executionId.split(":")[0] as string });
  const events: EventEnvelope[] = [0, 1].map((i) => evt(X, i, "STEP_COMPLETED", { step: `s${i}`, email: EMAIL, mirror: EMAIL }));
  for (const e of events) await enc.append(e);
  return { raw, enc, events };
}
const stateOf = async (s: ReadModelService, id: string) => (await s.getMany(id, [X])).get(X)?.state;

describe("sensitive-state guard — every feed presents the same masked input (D11)", () => {
  it("live, catch-up through the encrypting store, catch-up from the sealed raw log, refresh and rebuild agree, and none holds the secret", async () => {
    const { raw, enc, events } = await logs();
    const covers = enc.sealingCapability?.()?.covers ?? [];
    expect(covers).toContain("STEP_COMPLETED.email"); // the derivation path is real, not assumed
    const sensitive = sensitiveMapFromCovers(covers);
    const mk = async () => {
      const s = new ReadModelService(new InMemoryReadModelStore(), { sensitive });
      await s.registerFolded({ projection: proj("owner-email", "email") });
      return s;
    };
    const live = await mk();
    for (const e of events) live.handleEvent(e); // the runtime's plaintext events: no seal marker
    await live.drain();
    const viaEnc = await mk();
    await viaEnc.catchUp([enc]);
    const viaRaw = await mk(); // sealed at rest: envelopes + metadata.seal
    await viaRaw.catchUp([raw]);
    const refreshed = await mk();
    await refreshed.refresh("owner-email", [X], [enc]);
    const rebuilt = await mk();
    await rebuilt.catchUp([enc]);
    await rebuilt.rebuild("owner-email", [raw]);

    const expected = { steps: 2, owner: "[redacted]" };
    for (const s of [live, viaEnc, viaRaw, refreshed, rebuilt]) {
      expect(await stateOf(s, "owner-email")).toEqual(expected);
    }
  });

  it("a sealed raw log needs no declared map: the event's own seal marker is enough", async () => {
    const { raw } = await logs();
    const s = new ReadModelService(new InMemoryReadModelStore());
    await s.registerFolded({ projection: proj("owner-email", "email") });
    await s.catchUp([raw]);
    expect(await stateOf(s, "owner-email")).toEqual({ steps: 2, owner: "[redacted]" });
  });

  it("ciphertext whose marker was stripped is still never handed to the fold", async () => {
    const { raw } = await logs();
    const stripped = {
      listExecutions: async () => (await raw.listExecutions?.()) ?? [],
      readFrom: async (id: string, from: number) =>
        (await raw.readFrom(id, from)).map(({ metadata: _m, ...e }) => e as EventEnvelope),
    };
    const s = new ReadModelService(new InMemoryReadModelStore());
    await s.registerFolded({ projection: proj("owner-email", "email") });
    await s.catchUp([stripped]);
    expect(await stateOf(s, "owner-email")).toEqual({ steps: 2, owner: "[redacted]" });
  });
});

describe("sensitive-state guard — a lifted copy fails loudly on every feed (D11)", () => {
  it("catch-up throws, the live path reports, nothing is stored, and the message carries no value", async () => {
    const { enc, events } = await logs();
    const errs: unknown[] = [];
    const s = new ReadModelService(new InMemoryReadModelStore(), { sensitive: SENSITIVE, onError: (e) => errs.push(e) });
    await s.registerFolded({ projection: proj("owner-mirror", "mirror") }); // copies the PLAIN duplicate

    const thrown = await s.catchUp([enc]).then(() => undefined, (e: unknown) => e);
    expect(thrown).toBeInstanceOf(SensitiveStateError);
    for (const e of events) s.handleEvent(e);
    await s.drain();
    expect(errs[0]).toBeInstanceOf(SensitiveStateError);
    for (const e of [thrown, errs[0]] as SensitiveStateError[]) {
      expect(e).toMatchObject({ reason: "lifted-value", statePath: "$.owner" });
      expect(e.message).toContain("owner-mirror");
      expect(e.message).not.toContain(EMAIL);
    }
    expect((await s.getMany("owner-mirror", [X])).size).toBe(0); // the watermark never advanced
  });

  it("a safe fold over the same log is untouched (the guard has no false positive on plain fields)", async () => {
    const { enc } = await logs();
    const s = new ReadModelService(new InMemoryReadModelStore(), { sensitive: SENSITIVE });
    await s.registerFolded({ projection: proj("owner-step", "step") });
    await s.catchUp([enc]);
    expect(await stateOf(s, "owner-step")).toEqual({ steps: 2, owner: "s1" });
  });

  it("changing the declared sensitive paths rebuilds the model on the next registration", async () => {
    const store = new InMemoryReadModelStore();
    const first = new ReadModelService(store, { sensitive: SENSITIVE });
    expect(await first.registerFolded({ projection: proj("owner-step", "step") })).toEqual({ rebuilt: false });
    const second = new ReadModelService(store, { sensitive: { STEP_COMPLETED: ["email", "phone"] } });
    expect(await second.registerFolded({ projection: proj("owner-step", "step") })).toEqual({ rebuilt: true });
  });
});
```
(Adjust the `projection$` import into the first `@loom/core` import; confirm `sealingCapability` is callable on the store instance in this repo state — it is defined on `EncryptingEventStore` at `plugins/crypto/src/EncryptingEventStore.ts:160/234`; if it is only installed lazily, read it from the instance after construction as the ADR 0130 D7 tests do in `plugins/crypto/src/sealMarker.test.ts`.)

- [ ] **Step 2: Run** `pnpm --filter @loom/plugin-read-model exec vitest run src/foldedSensitive.test.ts` → PASS (requires Task 7a: `ReadModelService` takes `sensitive`; if you run this task before 7a, move it after).
- [ ] **Step 3: Commit**

```bash
git add plugins/read-model/src/foldedSensitive.test.ts
git commit -m "test(read-model): sensitive-state guard parity across live, catch-up, refresh, rebuild and raw sources (ADR 0132 D11)"
```

---

### Task 10: Erasure integration with compliance (D11, D12)

**Files:**
- Create: `plugins/read-model/src/foldedErasure.test.ts`

**Interfaces:** consumes the existing `erasure.test.ts` harness conventions — read `plugins/read-model/src/erasure.test.ts` first and reuse its `EncryptingEventStore` / `eraseSubject` setup verbatim (do not re-derive it).

- [ ] **Step 1: Write the tests.** Model them on `erasure.test.ts`; assert, with the same strict/tolerant sources that file builds:
  1. After `eraseSubject` for subject A, a folded model that copied a field from A's events still holds it (the hazard — pins D11's "plaintext copy"); `purgeFolded(model, { scope: A })` removes it and returns the count; B's state is untouched.
  2. A rebuild through the STRICT source throws `PayloadShreddedError` (documented hazard); through the tolerant source it completes, and a handler that does `isShredded(payload) ? skip : fold` yields no state for A (not a `$shredded` bucket).
  3. Purge then catch-up through the tolerant source does not resurrect A's state (tombstone sticks).
  4. With the sensitive map declared (`sensitive: { FILE_ADDED: ["name"] }`, the paths the encrypting store seals), the fold never held A's value at all: after `eraseSubject` the folded state contains the sentinel `"[redacted]"` and no trace of `secret.pdf`, so `purgeFolded` is the backstop for undeclared paths, not the primary control (D11/D12). A second model with no map still shows the hazard in case 1.
  Skeleton for case 1 (adapt names to the helpers in `erasure.test.ts`):

```ts
it("purgeFolded removes the plaintext the fold copied out before the key died", async () => {
  const { service, erase, appendAs } = await harness(); // from erasure.test.ts's setup, extended with registerFolded
  await appendAs("alice", { filename: "secret.pdf" });
  await appendAs("bob", { filename: "ok.pdf" });
  await service.catchUp([live]);
  await erase("alice");
  expect((await service.getMany("files", [ALICE_EXEC])).get(ALICE_EXEC)).toBeDefined(); // the hazard
  expect(await service.purgeFolded("files", { scope: "alice" })).toBe(1);
  expect((await service.getMany("files", [ALICE_EXEC])).size).toBe(0);
  expect((await service.getMany("files", [BOB_EXEC])).size).toBe(1);
});
```
  The fixture's projection folds `FILE_ADDED` into `{ name }`; `scopeOf` returns the subject id from the executionId.

- [ ] **Step 2: Run** `pnpm --filter @loom/plugin-read-model exec vitest run src/foldedErasure.test.ts` → PASS (no production change expected; a failure here means D12 is wrong — fix the code, not the test).
- [ ] **Step 3: Commit**

```bash
git add plugins/read-model/src/foldedErasure.test.ts
git commit -m "test(read-model): folded state erasure via purgeFolded and tolerant rebuild (ADR 0132 D12)"
```

---

### Task 11: SQLite backend (D3, D5, D6, D12)

**Files:**
- Modify: `plugins/sqlite/src/SqliteReadModelStore.ts`
- Modify: `plugins/sqlite/src/conformance.test.ts`

**Interfaces:** implements the five optional methods; `clear` also deletes folded rows/header.

- [ ] **Step 1: Failing test** — in `plugins/sqlite/src/conformance.test.ts` add `runFoldedStateConformance` to the `@loom/conformance` import and, after line 34:

```ts
runFoldedStateConformance(() => new SqliteReadModelStore(":memory:"), "SqliteReadModelStore");
```
Run: `pnpm --filter @loom/conformance build && pnpm --filter @loom/plugin-sqlite exec vitest run src/conformance.test.ts` → folded cases SKIP (no methods yet). Add to the same file a guard `it("implements the folded methods", () => { expect(typeof new SqliteReadModelStore(":memory:").applyFolded).toBe("function"); });` inside a `describe("SqliteReadModelStore folded", …)` — FAILS.

- [ ] **Step 2: Implement.** Imports: `FoldedApply, FoldedApplyResult, FoldedRecord, FoldedSelector` (types) and `assertManyKeys` (value) from `@loom/plugin-read-model`. In the constructor's `db.exec` add:

```sql
        CREATE TABLE IF NOT EXISTS read_model_folds (
          model_id TEXT PRIMARY KEY,
          version TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS read_model_state (
          model_id TEXT NOT NULL,
          execution_id TEXT NOT NULL,
          app_key TEXT,
          scope TEXT,
          sequence INTEGER NOT NULL,
          state TEXT,
          erased INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (model_id, execution_id)
        );
        CREATE INDEX IF NOT EXISTS idx_rm_state_key ON read_model_state (model_id, app_key) WHERE app_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_rm_state_scope ON read_model_state (model_id, scope) WHERE scope IS NOT NULL;
```
Methods:

```ts
  private foldedRow(r: { execution_id: string; app_key: string | null; scope: string | null; sequence: number; state: string | null; erased: number }): FoldedRecord {
    return {
      executionId: r.execution_id, key: r.app_key, scope: r.scope, sequence: r.sequence,
      state: r.state === null ? null : JSON.parse(r.state), erased: r.erased === 1,
    };
  }

  async beginFold(modelId: string, foldVersion: string): Promise<{ rebuilt: boolean }> {
    return this.db.transaction(() => {
      const prior = this.db.prepare("SELECT version FROM read_model_folds WHERE model_id = ?").get(modelId) as { version: string } | undefined;
      this.db.prepare("INSERT INTO read_model_folds (model_id, version) VALUES (?, ?) ON CONFLICT (model_id) DO UPDATE SET version = excluded.version").run(modelId, foldVersion);
      if (prior === undefined || prior.version === foldVersion) return { rebuilt: false };
      this.db.prepare("DELETE FROM read_model_state WHERE model_id = ?").run(modelId);
      return { rebuilt: true };
    })();
  }

  async applyFolded(a: FoldedApply): Promise<FoldedApplyResult> {
    return this.db.transaction((): FoldedApplyResult => {
      const info = this.db.prepare(
        `INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state, erased)
         SELECT ?, ?, ?, ?, ?, ?, 0
         WHERE EXISTS (SELECT 1 FROM read_model_folds WHERE model_id = ? AND version = ?)
         ON CONFLICT (model_id, execution_id) DO UPDATE
           SET sequence = excluded.sequence,
               state = CASE WHEN read_model_state.erased = 1 THEN NULL ELSE excluded.state END,
               app_key = COALESCE(excluded.app_key, read_model_state.app_key),
               scope = COALESCE(excluded.scope, read_model_state.scope)
           WHERE read_model_state.sequence < excluded.sequence`
      ).run(a.modelId, a.executionId, a.key, a.scope, a.upToSequence,
            a.state === null ? null : JSON.stringify(a.state), a.modelId, a.foldVersion);
      if (info.changes > 0) return "applied";
      const hdr = this.db.prepare("SELECT version FROM read_model_folds WHERE model_id = ?").get(a.modelId) as { version: string } | undefined;
      return hdr?.version === a.foldVersion ? "stale" : "version-mismatch";
    })();
  }

  async getFolded(modelId: string, executionIds: readonly string[]): Promise<FoldedRecord[]> {
    assertManyKeys(executionIds, "getFolded");
    const ids = [...new Set(executionIds)];
    if (ids.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT execution_id, app_key, scope, sequence, state, erased FROM read_model_state
       WHERE model_id = ? AND execution_id IN (${ids.map(() => "?").join(",")})`
    ).all(modelId, ...ids) as Parameters<SqliteReadModelStore["foldedRow"]>[0][];
    const byId = new Map(rows.map((r) => [r.execution_id, this.foldedRow(r)]));
    return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  }

  async getFoldedByKey(modelId: string, keys: readonly string[]): Promise<FoldedRecord[]> {
    assertManyKeys(keys, "getFoldedByKey");
    const uniq = [...new Set(keys)];
    if (uniq.length === 0) return [];
    const rows = this.db.prepare(
      `SELECT execution_id, app_key, scope, sequence, state, erased FROM read_model_state
       WHERE model_id = ? AND app_key IN (${uniq.map(() => "?").join(",")}) ORDER BY execution_id`
    ).all(modelId, ...uniq) as Parameters<SqliteReadModelStore["foldedRow"]>[0][];
    return rows.map((r) => this.foldedRow(r));
  }

  async purgeFolded(modelId: string, selector: FoldedSelector): Promise<number> {
    const [col, val] = "executionId" in selector ? ["execution_id", selector.executionId]
      : "key" in selector ? ["app_key", selector.key] : ["scope", selector.scope];
    // Tombstone, never delete: the row IS the watermark (ADR 0132 D12).
    return this.db.prepare(
      `UPDATE read_model_state SET state = NULL, erased = 1 WHERE model_id = ? AND ${col} = ? AND erased = 0`
    ).run(modelId, val).changes;
  }
```
(`col` is chosen from three literals, never caller input.) Extend `clear`: also `DELETE FROM read_model_state WHERE model_id = ?` and `DELETE FROM read_model_folds WHERE model_id = ?` in the same transaction as the existing deletes (inspect the current `clear` body and wrap it).

If `foldedRow` being `private` breaks the `Parameters<…>` trick, replace it with a module-level `interface FoldedDbRow` and use that type directly.

- [ ] **Step 3: Run** `pnpm --filter @loom/plugin-sqlite exec vitest run src/conformance.test.ts` → 12 folded cases PASS (not skipped).
- [ ] **Step 4: Commit**

```bash
git add plugins/sqlite/src/SqliteReadModelStore.ts plugins/sqlite/src/conformance.test.ts
git commit -m "feat(sqlite): folded-state read model store methods (ADR 0132)"
```

---

### Task 12a: Postgres placement — identifiers, DDL builder, table ensure (D10)

**Files:**
- Create: `plugins/postgres/src/foldedState.ts`
- Create: `plugins/postgres/src/foldedState.test.ts`
- Modify: `plugins/postgres/src/index.ts`

**Interfaces:**
- Produces: `FoldedTableOptions { schema?: string; tables?: { state?: string; folds?: string } }`, `foldedNames(o): { state: string; folds: string; stateBare: string }` (quoted, qualified), `foldedStateDdl(o): string`, `ensureFoldedTables(pool: PoolLike, o): Promise<void>`.

- [ ] **Step 1: Failing test** (pure, no database) — `plugins/postgres/src/foldedState.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { foldedNames, foldedStateDdl } from "./foldedState";

describe("folded-state placement (ADR 0132 D10)", () => {
  it("defaults to unqualified read_model_state / read_model_folds", () => {
    expect(foldedNames()).toMatchObject({ state: '"read_model_state"', folds: '"read_model_folds"' });
  });

  it("qualifies a caller-chosen schema and table names", () => {
    const n = foldedNames({ schema: "docmind", tables: { state: "doc_status", folds: "doc_status_folds" } });
    expect(n.state).toBe('"docmind"."doc_status"');
    expect(n.folds).toBe('"docmind"."doc_status_folds"');
  });

  it.each(['a"b', "a b", "1abc", "", "x".repeat(48), "a;DROP"])("refuses the identifier %j", (bad) => {
    expect(() => foldedNames({ schema: bad })).toThrow(TypeError);
    expect(() => foldedNames({ tables: { state: bad } })).toThrow(TypeError);
  });

  it("emits a scope column, a key index and a scope index for the RLS policy to use", () => {
    const ddl = foldedStateDdl({ schema: "docmind" });
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "docmind"."read_model_state"');
    expect(ddl).toMatch(/scope TEXT/);
    expect(ddl).toMatch(/\(model_id, app_key\)/);
    expect(ddl).toMatch(/\(model_id, scope\)/);
  });
});
```
Run → FAIL (module missing).

- [ ] **Step 2: Implement** `plugins/postgres/src/foldedState.ts`:

```ts
import type { PoolLike } from "./pool";

// ADR 0132 D10 — caller-chosen placement for folded read-model state. The shared migrate()
// is untouched: these two tables are created lazily, under an advisory lock, only when a
// folded model is used (or by the app's own migration, via foldedStateDdl).

// 48 chars max so the derived index names stay under Postgres's 63-byte identifier limit.
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

export interface FoldedTableOptions {
  /** Default: the pool's current schema (its search_path), like every other Loom store. */
  schema?: string;
  tables?: { state?: string; folds?: string };
}

export interface FoldedNames {
  state: string;
  folds: string;
  stateBare: string;
}

function ident(value: string, what: string): string {
  if (!IDENT.test(value)) {
    throw new TypeError(`PostgresReadModelStore: ${what} ${JSON.stringify(value)} is not a plain SQL identifier ([A-Za-z_][A-Za-z0-9_]{0,47})`);
  }
  return `"${value}"`;
}

export function foldedNames(o: FoldedTableOptions = {}): FoldedNames {
  const state = o.tables?.state ?? "read_model_state";
  const folds = o.tables?.folds ?? "read_model_folds";
  const qualify = (t: string, what: string): string =>
    o.schema === undefined ? ident(t, what) : `${ident(o.schema, "schema")}.${ident(t, what)}`;
  return { state: qualify(state, "state table"), folds: qualify(folds, "folds table"), stateBare: state };
}

/** Pure DDL — drop it into the app's own migration, then add RLS policies on `scope`. */
export function foldedStateDdl(o: FoldedTableOptions = {}): string {
  const n = foldedNames(o);
  return `
    CREATE TABLE IF NOT EXISTS ${n.folds} (
      model_id TEXT PRIMARY KEY,
      version TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${n.state} (
      model_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      app_key TEXT,
      scope TEXT,
      sequence BIGINT NOT NULL,
      state JSONB,
      erased BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (model_id, execution_id)
    );
    CREATE INDEX IF NOT EXISTS "${n.stateBare}_key_idx" ON ${n.state} (model_id, app_key) WHERE app_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS "${n.stateBare}_scope_idx" ON ${n.state} (model_id, scope) WHERE scope IS NOT NULL;
  `;
}

/** Create the tables once per process, serialized across nodes by a transaction-scoped advisory lock. */
export async function ensureFoldedTables(pool: PoolLike, o: FoldedTableOptions = {}): Promise<void> {
  const n = foldedNames(o);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`loom:folded:${n.state}`]);
    await client.query(foldedStateDdl(o));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
```
In `index.ts` add: `export { foldedStateDdl } from "./foldedState"; export type { FoldedTableOptions } from "./foldedState";`.

- [ ] **Step 3: Run** `pnpm --filter @loom/plugin-postgres exec vitest run src/foldedState.test.ts` → PASS.
- [ ] **Step 4: Commit**

```bash
git add plugins/postgres/src/foldedState.ts plugins/postgres/src/foldedState.test.ts plugins/postgres/src/index.ts
git commit -m "feat(postgres): caller-chosen schema/tables and DDL for folded read-model state (ADR 0132 D10)"
```

---

### Task 12b: Postgres folded methods, conformance, RLS test (D3, D5, D10, D12)

**Files:**
- Modify: `plugins/postgres/src/PostgresReadModelStore.ts`
- Modify: `plugins/postgres/src/conformance.test.ts`
- Create: `plugins/postgres/src/foldedRls.test.ts`

**Interfaces:**
- Produces: `new PostgresReadModelStore(config, options?: PostgresReadModelStoreOptions)` where `PostgresReadModelStoreOptions extends FoldedTableOptions { manageSchema?: boolean }`; the five methods; `clear` also deletes folded state/header.

- [ ] **Step 1: Failing test** — in `plugins/postgres/src/conformance.test.ts` add `runFoldedStateConformance` to the `@loom/conformance` import, a cursor `let nextFolded = 0;` next to `nextReadModel`, and after the existing read-model kit call (line ~127):

```ts
  runFoldedStateConformance(() => {
    const pool = pools[nextFolded++ % pools.length] as Pool;
    return new PostgresReadModelStore(pool);
  }, "PostgresReadModelStore");
```
Run (needs the test database; never print the URL): `LOOM_TEST_POSTGRES_URL=… pnpm --filter @loom/plugin-postgres exec vitest run src/conformance.test.ts` → folded cases SKIP. Add a guard test (no DB needed) in `foldedState.test.ts`: `import { PostgresReadModelStore } from "./PostgresReadModelStore"; it("exposes the folded methods", () => expect(typeof PostgresReadModelStore.prototype.applyFolded).toBe("function"));` → FAILS.

- [ ] **Step 2: Implement.** Imports: `FoldedApply, FoldedApplyResult, FoldedRecord, FoldedSelector` (types) and `assertManyKeys` from `@loom/plugin-read-model`; `type FoldedNames, type FoldedTableOptions, ensureFoldedTables, foldedNames` from `./foldedState`. Constructor and fields:

```ts
export interface PostgresReadModelStoreOptions extends FoldedTableOptions {
  /**
   * Default true. false = create NO tables and skip the shared migrate() — the setting for a
   * least-privilege RLS reader instance, or for an app that ran `foldedStateDdl` itself.
   */
  manageSchema?: boolean;
}

  private readonly names: FoldedNames;
  private readonly tableOptions: FoldedTableOptions;
  private readonly manage: boolean;
  private foldedReady?: Promise<void>;

  constructor(config: PgConfig, options: PostgresReadModelStoreOptions = {}) {
    const { pool, owned } = toPool(config);
    this.pool = pool;
    this.ownsPool = owned;
    this.manage = options.manageSchema ?? true;
    this.tableOptions = options;
    this.names = foldedNames(options);
    this.ready = this.manage ? migrate(this.pool) : Promise.resolve();
  }

  private folded(): Promise<void> {
    if (!this.manage) return this.ready;
    this.foldedReady ??= this.ready
      .then(() => ensureFoldedTables(this.pool, this.tableOptions))
      .catch((err) => {
        this.foldedReady = undefined; // never cache a rejection
        throw err;
      });
    return this.foldedReady;
  }
```
Methods (`T = this.names.state`, `H = this.names.folds`):

```ts
  async beginFold(modelId: string, foldVersion: string): Promise<{ rebuilt: boolean }> {
    await this.folded();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`INSERT INTO ${this.names.folds} (model_id, version) VALUES ($1, $2) ON CONFLICT (model_id) DO NOTHING`, [modelId, foldVersion]);
      // FOR UPDATE serializes concurrent beginFolds and blocks applyFolded's FOR SHARE until commit.
      const { rows } = await client.query<{ version: string }>(`SELECT version FROM ${this.names.folds} WHERE model_id = $1 FOR UPDATE`, [modelId]);
      let rebuilt = false;
      if (rows[0]?.version !== foldVersion) {
        await client.query(`DELETE FROM ${this.names.state} WHERE model_id = $1`, [modelId]);
        await client.query(`UPDATE ${this.names.folds} SET version = $2 WHERE model_id = $1`, [modelId, foldVersion]);
        rebuilt = true;
      }
      await client.query("COMMIT");
      return { rebuilt };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async applyFolded(a: FoldedApply): Promise<FoldedApplyResult> {
    await this.folded();
    const T = this.names.state;
    const H = this.names.folds;
    const res = await this.pool.query(
      `INSERT INTO ${T} (model_id, execution_id, app_key, scope, sequence, state, erased)
       SELECT $1, $2, $3::text, $4::text, $5::bigint, $6::jsonb, false
       WHERE EXISTS (SELECT 1 FROM ${H} h WHERE h.model_id = $1 AND h.version = $7 FOR SHARE OF h)
       ON CONFLICT (model_id, execution_id) DO UPDATE
          SET sequence = EXCLUDED.sequence,
              state    = CASE WHEN ${T}.erased THEN NULL ELSE EXCLUDED.state END,
              app_key  = COALESCE(EXCLUDED.app_key, ${T}.app_key),
              scope    = COALESCE(EXCLUDED.scope, ${T}.scope)
        WHERE ${T}.sequence < EXCLUDED.sequence
       RETURNING sequence`,
      [a.modelId, a.executionId, a.key, a.scope, a.upToSequence, a.state === null ? null : JSON.stringify(a.state), a.foldVersion]
    );
    if ((res.rowCount ?? 0) > 0) return "applied";
    const hdr = await this.pool.query<{ version: string }>(`SELECT version FROM ${H} WHERE model_id = $1`, [a.modelId]);
    return hdr.rows[0]?.version === a.foldVersion ? "stale" : "version-mismatch";
  }

  async getFolded(modelId: string, executionIds: readonly string[]): Promise<FoldedRecord[]> {
    assertManyKeys(executionIds, "getFolded");
    await this.folded();
    const ids = [...new Set(executionIds)];
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query<FoldedDbRow>(
      `SELECT execution_id, app_key, scope, sequence, state, erased FROM ${this.names.state}
       WHERE model_id = $1 AND execution_id = ANY($2::text[])`, [modelId, ids]);
    const byId = new Map(rows.map((r) => [r.execution_id, toFolded(r)]));
    return ids.flatMap((id) => (byId.has(id) ? [byId.get(id) as FoldedRecord] : []));
  }

  async getFoldedByKey(modelId: string, keys: readonly string[]): Promise<FoldedRecord[]> {
    assertManyKeys(keys, "getFoldedByKey");
    await this.folded();
    if (keys.length === 0) return [];
    const { rows } = await this.pool.query<FoldedDbRow>(
      `SELECT execution_id, app_key, scope, sequence, state, erased FROM ${this.names.state}
       WHERE model_id = $1 AND app_key = ANY($2::text[]) ORDER BY execution_id`, [modelId, [...new Set(keys)]]);
    return rows.map(toFolded);
  }

  async purgeFolded(modelId: string, selector: FoldedSelector): Promise<number> {
    await this.folded();
    const [col, val] = "executionId" in selector ? ["execution_id", selector.executionId]
      : "key" in selector ? ["app_key", selector.key] : ["scope", selector.scope];
    // Tombstone, never delete: the row IS the watermark (ADR 0132 D12). `col` is one of three literals.
    const { rowCount } = await this.pool.query(
      `UPDATE ${this.names.state} SET state = NULL, erased = true WHERE model_id = $1 AND ${col} = $2 AND NOT erased`,
      [modelId, val]);
    return rowCount ?? 0;
  }
```
module-level:
```ts
interface FoldedDbRow { execution_id: string; app_key: string | null; scope: string | null; sequence: string; state: unknown | null; erased: boolean }
function toFolded(r: FoldedDbRow): FoldedRecord {
  return { executionId: r.execution_id, key: r.app_key, scope: r.scope, sequence: Number(r.sequence), state: r.state, erased: r.erased };
}
```
`clear`: when `this.manage` is true (or tables exist) add, AFTER the existing two deletes: `await this.folded(); await this.pool.query(\`DELETE FROM ${this.names.state} WHERE model_id = $1\`, [modelId]); await this.pool.query(\`DELETE FROM ${this.names.folds} WHERE model_id = $1\`, [modelId]);`. (An app that never used folded models pays two empty deletes plus the one-time lazy table creation on first `clear`; acceptable and noted in the ADR consequences.)

Note on the types: `pg` returns BIGINT as string, hence `Number(...)` (as the row path already does); a `state` JSONB column arrives parsed.

- [ ] **Step 3: RLS test** — `plugins/postgres/src/foldedRls.test.ts`, gated like the sibling suites on `LOOM_TEST_POSTGRES_URL` (`describe.skip` when unset). Create a unique schema `loom_rls_<pid>`; construct a writer `new PostgresReadModelStore(pool, { schema, tables: { state: "doc_status", folds: "doc_status_folds" } })`; write two scopes via `beginFold`/`applyFolded`; then `ALTER TABLE … ENABLE ROW LEVEL SECURITY` plus the two policies from ADR D10 (reader policy `USING (scope = current_setting('app.tenant', true))`, ingest policy `FOR ALL … USING (true) WITH CHECK (true)`) using roles created with `CREATE ROLE … NOLOGIN` guarded by `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '…') THEN CREATE ROLE … END IF; END $$` (skip the whole test with `ctx.skip()` if role creation or `SET ROLE` is not permitted). Assert via a reader `PostgresReadModelStore(client-pool, { …same names, manageSchema: false })` obtained from a pool whose session did `SET ROLE docmind_app; SET app.tenant = 'u1'`: `getFolded` returns only the u1 execution while the writer still sees both. `afterAll`: drop the schema and the roles. Assert the custom-schema placement too: `SELECT to_regclass('"<schema>"."doc_status"')` is not null and `public.read_model_state` was not created by this store.

- [ ] **Step 4: Run** the guard test, then with the database: `LOOM_TEST_POSTGRES_URL=… pnpm --filter @loom/plugin-postgres exec vitest run src/conformance.test.ts src/foldedRls.test.ts src/foldedState.test.ts` → folded kit 12 PASS; RLS PASS or skipped-with-reason.

- [ ] **Step 5: Commit**

```bash
git add plugins/postgres/src/PostgresReadModelStore.ts plugins/postgres/src/conformance.test.ts plugins/postgres/src/foldedRls.test.ts plugins/postgres/src/foldedState.test.ts
git commit -m "feat(postgres): folded-state read model store, conformance and RLS placement (ADR 0132 D3/D10)"
```

---

### Task 13a: User docs — plugins, API reference, README (D10, D11, D15)

**Files:**
- Modify: `docs/plugins.md` (read-model section: folded models, boot order, `getMany`/`refresh`, the guard, the cache, a DocMind-shaped example)
- Modify: `docs/api-reference.org` (around line 1116–1143: `registerFolded`, `getMany`, `getManyByKey`, `refresh`, `purgeFolded`, `sensitive`, `foldCache`, `sensitiveMapFromCovers`, `SensitiveStateError`, SPI 1.2.0)
- Modify: `docs/README.md` (add ADR 0132 to the list near line 175–183)

- [ ] **Step 1: `docs/plugins.md`** — add a "Folded-state models" subsection with exactly this wiring (the DocMind shape) and the rules below it:

```ts
const service = new ReadModelService(new PostgresReadModelStore(ingestPool, { schema: "docmind" }), {
  liveSource: eventStore,
  sensitive: SENSITIVE,            // the SAME map given to EncryptingEventStore (or sensitiveMapFromCovers(...))
  foldCache: { maxEntries: 1024 }, // the default; `false` disables
  onError: (err) => logger.error(err),
});
await service.registerFolded({
  projection: ingestStatus, // projection$({ id, version: "1", initialState, handlers })
  keyOf: (executionId) => /ingest-(.+?)(?:\.\d+)?$/.exec(executionId)?.[1],
  // DocMind execution ids are `u_<userId>:<name>`: scope = userId. The app's RLS policy maps scope -> tenant
  // through its own table; Loom stays generic and `scopeOf` stays synchronous.
  scopeOf: (executionId) => /^u_([^:]+):/.exec(executionId)?.[1],
});
const app = defineConfig({ /* … */ onEvent: (e) => service.handleEvent(e) });
await service.catchUp([eventStore]);                       // boot: heals + re-folds after a version or sensitive-map change

// request path (a reader instance: PostgresReadModelStore(readerPool, { schema: "docmind", manageSchema: false }))
const states = await readerService.getManyByKey("ingest-status", pageOfDocumentIds);
// right after a step the user just caused (one log-tail read, only for the execution that action touched):
await service.getMany("ingest-status", [executionId], { refreshFrom: [eventStore] });
```
State the rules in prose: (1) **Sensitive state.** Handlers receive events with every declared or sealed-marked path replaced by `"[redacted]"`; a state that holds a sealed envelope or a value copied from a sensitive path is refused with `SensitiveStateError` (model, execution, event and state path; never the value) and the watermark does not advance. Say what it cannot catch (an undeclared field, a transformed copy, a short value, free text) in the same words as ADR 0132 D11, and that state should still hold identifiers, enums, counters and timestamps. (2) Keep `version` honest; the declared sensitive map is part of the fold version, so editing it rebuilds. (3) `refresh` costs a log-tail read: use it on the one execution a user action touched. (4) The state cache serves the live write path only; reads always hit the store; `foldCache: false` disables it.

- [ ] **Step 2: `docs/api-reference.org` and `docs/README.md`** — add the entries; in README add a bullet "[0132](adr/0132-folded-state-read-model.md) added durable per-execution folded-state read models with a sensitive-state guard and a bounded live-path cache".
- [ ] **Step 3: Commit**

```bash
git add docs/plugins.md docs/api-reference.org docs/README.md
git commit -m "docs: folded-state read models — plugins, API reference, README (ADR 0132)"
```

---

### Task 13b: Compliance docs, ADR bookkeeping, close-out (D11, D12)

**Files:**
- Modify: `docs/compliance.md` (new "Folded read-model state" subsection after "Purge the subject's rows")
- Modify: `docs/data-classification.md` (one paragraph under "Deriving the wiring": a folded read model consumes the same `sensitive` map)
- Modify: `docs/adr/0132-folded-state-read-model.md` (Status stays **Proposed** until the owner accepts; add "Implemented in PRs #…" only when merged)

- [ ] **Step 1: `docs/compliance.md`** — "Folded read-model state": the fold copies plaintext out of the log unless the guard stops it; declare the sensitive map (the same one the encrypting store uses) so handlers never see those values and a mirrored copy is refused; list the guard's limits verbatim from ADR 0132 D11; erase what slips through with `purgeFolded(model, { scope })` after `eraseSubject`; a tombstone keeps the watermark; rebuild needs a tolerant source and `isShredded` handling; the state cache holds no data a purge leaves behind (it is dropped on purge and never serves reads); link ADR 0132 D11/D12/D15.
- [ ] **Step 2: `docs/data-classification.md`** — the paragraph and a two-line example passing `sensitivePathsFromSteps(flow.steps)` to both `EncryptingEventStore` and `ReadModelService({ sensitive })`.
- [ ] **Step 3: Full local verify (the close-out)** — run exactly:

```bash
pnpm build && npx turbo test --force --concurrency=2 && pnpm typecheck && pnpm typecheck:tests && pnpm lint
```
Expected: all green. Fix anything biome reports with `pnpm lint --write` only where it is formatting in files this plan touched.

- [ ] **Step 4: Commit, then open this task's DRAFT PR** (stacked on task 13a's; do not mark ready; ask the owner first).

```bash
git add docs/
git commit -m "docs: folded-state compliance and classification notes (ADR 0132)"
git push -u origin <this task's branch>   # only when the owner says to push
gh pr create --draft --base <previous task's branch> --title "docs: folded-state compliance notes (ADR 0132)" --body "…"   # ends with the Claude Code attribution line
```
Merge later with `gh pr merge --rebase`, in stack order.

---

## Self-review (run against the ADR)

- **Spec coverage:** D1 -> T1, T4a, T7a. D2 -> T4a (key/scope from executionId), T8 (generations). D3 -> T2, T3, T11, T12b (CAS statement), T8. D4 -> T4a (contiguity, gap, JSON normalize), T6b (cached base). D5 -> T4a (version required), T5c (effective version), T7b (rebuild + old-node refusal), T2 (header guard). D6 -> T1 (SPI), T2 (kit), T3/T11/T12b. D7 -> T1 (`assertManyKeys`), T4b, T2. D8 -> T4b/T7b (`refresh`, `refreshFrom`, `drain`). D9 -> T4b (`getManyByKey`); paging explicitly absent. D10 -> T12a/T12b. D11 -> T5a (output check), T5b (input view), T5c (config + engine), T9 (parity across feeds), T10 (erasure), T13a/T13b (docs). D12 -> T3/T11/T12b tombstone, T7b, T10. D13 -> T7a. D14 -> T8, T9. D15 -> T6a (LRU), T6b (wiring), T6c (conflict/version/purge/read tests), T7a (options), T8 (two cached nodes). No gap found.
- **Placeholders:** the only abbreviated steps are T10's fixture (it MUST copy the harness from `erasure.test.ts`, named explicitly) and T12b's RLS test (specified assertion by assertion); every production code step has full code.
- **Type consistency:** `FoldedRecord`/`FoldedApply`/`FoldedSelector`/`FoldedState`/`FoldBase`/`SensitiveMap`/`FoldCacheOptions`/`FoldedEngineOptions`/`DEFAULT_FOLD_CACHE_ENTRIES` are defined once in T1 and used verbatim after; `Lifted`, `isCipherEnvelope`, `isLiftable`, `walkBounded`, `SensitiveStateError`, `assertStateClean` are defined once in T5a and used by T5b (`foldView`, `sensitivePathsFor`), T5c (engine, `sensitiveMapFromCovers`, `mergeSensitive`, `effectiveFoldVersion`) and T9; `foldedCapable`/`FoldedStore` (T4a) are what T7a imports; `FoldStateCache` (T6a) is what T6b imports; `FoldedModelEngine`'s constructor takes `FoldedEngineOptions` from T4a on, and T7a builds it from `ReadModelServiceOptions` (`liveSource`, `sensitive`, `foldCache`); `refresh` returns "executions advanced" in T4b and T7b.
- **Size check (est. changed lines / files):** T1 ~140/3, T2 ~190/3, T3 ~100/2, T4a ~190/3, T4b ~150/3, T5a ~150/3, T5b ~190/6, T5c ~180/5, T6a ~120/2, T6b ~170/2, T6c ~130/2, T7a ~190/2, T7b ~110/2, T8 ~140/1, T9 ~150/1, T10 ~125/1, T11 ~140/2, T12a ~110/3, T12b ~190/4, T13a ~130/3, T13b ~90/3; none exceeds 200 / 10. If a task overruns when implemented, split it a/b at the step boundary before opening its PR (T5b and T7a are the likeliest).

## Owner decisions (2026-10-19)

1. **Q1 — fold `version` is required** for every folded model (blank = `TypeError`). Accepted as recommended. Since D11, the version written to the header also carries a digest of the declared sensitive map.
2. **Q2 — `getMany` / `getManyByKey` omit erased and never-matched executions.** Accepted as recommended: indistinguishable to the caller, so erasure state does not leak to UI code.
3. **Q3 — a sensitive-state guard ships in v1 (changed from the recommendation).** Handlers receive events with declared or seal-marked paths masked to `"[redacted]"` and with any cipher envelope masked; before persisting, the engine rejects a state holding a sealed envelope or a value lifted from a sensitive path, with a typed `SensitiveStateError` that names the model, execution, event and state path and never the value. Built from `sensitive()` marks / the `sensitive` map, `metadata.seal`, the ADR 0130 envelope shape rule and `@loom/classify` masking; pure (P7); limits stated in ADR 0132 D11. Tasks 5a, 5b, 5c, 9.
4. **Q4 — `refresh` is one log-tail read per execution**, used only on the execution a user action touched; list pages use the plain `getMany` / `getManyByKey`. Accepted as recommended; no "wait until sequence N" API.
5. **Q5 — old-version nodes stop projecting** (`FoldVersionMismatchError` to `onError`) until restarted on the new version, and a rollback re-folds. Accepted as recommended; no dual-version tables.
6. **Q6 — lazy tables by default; `manageSchema: false` for apps that own their DDL** (DocMind runs `foldedStateDdl({ schema: "docmind" })` in its own migrations beside the RLS policies). Accepted as recommended.
7. **Q7 — an in-process state cache ships in v1 (changed from the recommendation).** A bounded per-node LRU of `(modelId, executionId) -> { sequence, state, erased }` on the live apply path; default 1024 entries, `foldCache: false` or `{ maxEntries: 0 }` disables. The store's compare-and-set stays the authority: a lost CAS drops the entry and re-reads, a cached base never decides a gap, version change / purge / rebuild invalidate, and the cache never serves `getMany` / `getManyByKey` / `refresh`. Tasks 6a, 6b, 6c, 8.
8. **Q8 — `scopeOf` is derived synchronously from the executionId.** DocMind example (Loom stays generic): its execution ids are `u_<userId>:<name>`, so scope = userId; the app's own RLS policy maps scope -> tenant through its own table. No async `scopeOf`, no ADR amendment.
9. **Q9 — ONE draft PR PER TASK**, each <= 200 changed lines and <= 10 files, stacked in task order and merged in order with `gh pr merge --rebase`. This replaces the earlier three-PR split (see Global Constraints).
