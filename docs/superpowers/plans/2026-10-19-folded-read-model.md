# Folded-State Read Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second model kind to `@loom/plugin-read-model` — a durable, per-execution folded-state projection (`registerFolded`, `getMany`, `getManyByKey`, `refresh`, `purgeFolded`) — with in-memory, SQLite and Postgres backends and a conformance kit.

**Architecture:** The fold is the existing `ProjectionDefinition` (`projection$`). One state row per `(modelId, executionId)` whose `sequence` IS the watermark, written by a monotonic compare-and-set so nodes converge without locks. A `FoldedModelEngine` (pure core, new file) owns registration, contiguity, per-execution serialization and reads; `ReadModelService` delegates to it and shares the existing `onEvent` seam and catch-up scan. Backends gain five OPTIONAL store methods (SPI 1.1.0 → 1.2.0).

**Tech Stack:** TypeScript, vitest, better-sqlite3, node-postgres, pnpm/turbo, biome.

**Spec:** `docs/adr/0132-folded-state-read-model.md` (decisions D1–D14). Read it first; tasks cite decisions by number.

## Global Constraints

- No kernel change: `KERNEL_ABI` and `EVENT_SCHEMA` untouched; no `@loom/app`, `@loom/core` or event-type edits. Layering guard intact (plugins never imported by kernel packages).
- `READ_MODEL_STORE_SPI_VERSION` becomes `"1.2.0"`; the five new store methods are OPTIONAL (`beginFold?`, `applyFolded?`, `getFolded?`, `getFoldedByKey?`, `purgeFolded?`).
- A folded model is a cache of the log: rebuild == incremental; nothing reads it on replay.
- Fold `version` is REQUIRED (non-blank after trim); a changed version rebuilds the model automatically (D5).
- `getMany*` is capped at `MAX_GET_MANY = 1000` keys.
- Tests: wait on conditions (`service.drain()`, `until`), never fixed sleeps; no `performance.now()` in `*.test.ts`; Postgres suites gated on `LOOM_TEST_POSTGRES_URL` (never print its value); every package with tests keeps its `tsconfig.test.json` (`pnpm typecheck:tests`).
- Each task: <= 200 changed lines and <= 10 files. Open the PR as a DRAFT; `gh pr merge --rebase` only.
- Use `command ls`, never bare `ls`, in shell steps.
- **Local verify (close-out and before any "ready"):** `pnpm build && npx turbo test --force --concurrency=2 && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
|---|---|
| `plugins/read-model/src/types.ts` (modify) | Folded types, optional store methods, SPI 1.2.0, error classes, `assertManyKeys` |
| `plugins/read-model/src/FoldedModelEngine.ts` (create) | Registration, contiguity, serialization, fold, reads, refresh, purge — no I/O of its own |
| `plugins/read-model/src/ReadModelService.ts` (modify) | `registerFolded`, live fan-out, shared catch-up scan, delegation, pins, rebuild |
| `plugins/read-model/src/InMemoryReadModelStore.ts` (modify) | Reference folded methods |
| `plugins/read-model/src/foldedFixtures.ts` (create) | Test-only ingest-status projection + event helpers (excluded from `index.ts`) |
| `packages/conformance/src/foldedState.ts` (create) | `runFoldedStateConformance` |
| `plugins/sqlite/src/SqliteReadModelStore.ts` (modify) | SQLite folded methods |
| `plugins/postgres/src/foldedState.ts` (create) | Identifier validation, DDL builder, table ensure (pure + thin) |
| `plugins/postgres/src/PostgresReadModelStore.ts` (modify) | Options arg, folded methods |
| `docs/plugins.md`, `docs/compliance.md`, `docs/api-reference.org`, `docs/README.md` (modify) | User docs |

Task order: 1 → 2 → 3 → 4a → 4b → 5a → 5b → 6 → 7 → 8 → 9a → 9b → 10. Tasks 8, 9a/9b depend only on 1 and 2 and may run in parallel with 4a–7.

---

### Task 1: Folded types and SPI 1.2.0 (D1, D6, D7)

**Files:**
- Modify: `plugins/read-model/src/types.ts`
- Modify: `plugins/read-model/src/index.ts`
- Create: `plugins/read-model/src/foldedTypes.test.ts`

**Interfaces:**
- Produces: `FoldedReadModelDefinition<S>`, `FoldedRecord`, `FoldedApply`, `FoldedApplyResult`, `FoldedSelector`, `FoldedState<S>`, `MAX_GET_MANY`, `assertManyKeys(keys, what)`, `FoldedUnsupportedError`, `FoldGapError`, `FoldVersionMismatchError`, optional `ReadModelStore` methods, `READ_MODEL_STORE_SPI_VERSION = "1.2.0"`.

- [ ] **Step 1: Write the failing test** — `plugins/read-model/src/foldedTypes.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { MAX_GET_MANY, READ_MODEL_STORE_SPI_VERSION, assertManyKeys } from "./types";

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
}

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

Update the `clear` doc: "also drops the model's folded states and fold header". In `index.ts` add `MAX_GET_MANY, assertManyKeys, FoldedUnsupportedError, FoldGapError, FoldVersionMismatchError` to the value export list and `FoldedReadModelDefinition, FoldedRecord, FoldedApply, FoldedApplyResult, FoldedSelector, FoldedState` to the type export list.

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
  - `class FoldedModelEngine(store: FoldedStore, onError: (err: unknown, event: EventEnvelope) => void, liveSource?: ReadModelEventSource)` with `register(def): Promise<{rebuilt:boolean}>`, `has(id)`, `ids(): string[]`, `size`, `versions(): [string,string][]`, `handle(event): void`, `mark(modelId, executionId): Promise<FoldedRecord|undefined>`, `foldBatch(modelId, executionId, rec, events): Promise<boolean>`, `drain(): Promise<void>`.

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
  FoldedReadModelDefinition,
  FoldedRecord,
  ReadModelEventSource,
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
    private readonly liveSource?: ReadModelEventSource
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
    rec: FoldedRecord | undefined,
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
    else if (this.liveSource !== undefined) events = await this.liveSource.readFrom(event.executionId, from + 1);
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

- [ ] **Step 3: Implement** — in `FoldedModelEngine.ts` add `FoldedSelector, FoldedState` to the type import and `assertManyKeys` to the value import from `./types`, then add methods:

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

### Task 5a: Service wiring — register, live fan-out, shared catch-up (D13)

**Files:**
- Modify: `plugins/read-model/src/ReadModelService.ts`
- Create: `plugins/read-model/src/foldedService.test.ts`

**Interfaces:**
- Consumes: `FoldedModelEngine`, `foldedCapable`.
- Produces on `ReadModelService`: `ReadModelServiceOptions.liveSource?: ReadModelEventSource`; `registerFolded<S>(def): Promise<{rebuilt:boolean}>`; `getMany`, `getManyByKey` (delegating; `opts` as engine); `drain(): Promise<void>`; catch-up folds folded models in the same scan.

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

(a) Imports: add `FoldedReadModelDefinition, FoldedRecord, FoldedState, ReadModelEventSource` types as needed, `FoldedUnsupportedError` from `./types`, and `import { FoldedModelEngine, foldedCapable } from "./FoldedModelEngine";`.

(b) Options: add to `ReadModelServiceOptions`:
```ts
  /** Fills a gap in the live tail (ADR 0132 D4) — normally this node's own event store. */
  liveSource?: ReadModelEventSource;
```
Keep `options` as `private readonly options: ReadModelServiceOptions` (change the constructor param to `private readonly options: ReadModelServiceOptions = {}` and use `options.onError`, i.e. replace the local `options.onError ??` references with `this.options.onError ??` — the constructor body already reads it).

(c) Field + registration:
```ts
  private folded?: FoldedModelEngine;

  async registerFolded<S>(def: FoldedReadModelDefinition<S>): Promise<{ rebuilt: boolean }> {
    const id = def.projection.id;
    if (this.models.has(id)) throw new TypeError(`read model "${id}" is already registered`);
    if (!foldedCapable(this.store)) throw new FoldedUnsupportedError(id);
    this.folded ??= new FoldedModelEngine(this.store, this.onError, this.options.liveSource);
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

### Task 5b: Service — refresh, purgeFolded, rebuild, pins (D5, D8, D12)

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

### Task 6: Rebuild == incremental, and multi-node convergence (D3, D14)

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

### Task 7: Erasure integration with compliance (D11, D12)

**Files:**
- Create: `plugins/read-model/src/foldedErasure.test.ts`

**Interfaces:** consumes the existing `erasure.test.ts` harness conventions — read `plugins/read-model/src/erasure.test.ts` first and reuse its `EncryptingEventStore` / `eraseSubject` setup verbatim (do not re-derive it).

- [ ] **Step 1: Write the tests.** Model them on `erasure.test.ts`; assert, with the same strict/tolerant sources that file builds:
  1. After `eraseSubject` for subject A, a folded model that copied a field from A's events still holds it (the hazard — pins D11's "plaintext copy"); `purgeFolded(model, { scope: A })` removes it and returns the count; B's state is untouched.
  2. A rebuild through the STRICT source throws `PayloadShreddedError` (documented hazard); through the tolerant source it completes, and a handler that does `isShredded(payload) ? skip : fold` yields no state for A (not a `$shredded` bucket).
  3. Purge then catch-up through the tolerant source does not resurrect A's state (tombstone sticks).
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

### Task 8: SQLite backend (D3, D5, D6, D12)

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

### Task 9a: Postgres placement — identifiers, DDL builder, table ensure (D10)

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

### Task 9b: Postgres folded methods, conformance, RLS test (D3, D5, D10, D12)

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

### Task 10: Docs, ADR bookkeeping, close-out (D11)

**Files:**
- Modify: `docs/plugins.md` (read-model section: folded models, boot order, `getMany`/`refresh`, DocMind-shaped example)
- Modify: `docs/compliance.md` (new "Folded read-model state" subsection after "Purge the subject's rows")
- Modify: `docs/api-reference.org` (around line 1116–1143: `registerFolded`, `getMany`, `getManyByKey`, `refresh`, `purgeFolded`, SPI 1.2.0)
- Modify: `docs/README.md` (add ADR 0132 to the list near line 175–183)
- Modify: `docs/adr/0132-folded-state-read-model.md` (Status stays **Proposed** until the owner accepts; add "Implemented in PRs #…" only when merged)

- [ ] **Step 1: `docs/plugins.md`** — add a "Folded-state models" subsection with exactly this wiring (the DocMind shape) and the plaintext warning:

```ts
const service = new ReadModelService(new PostgresReadModelStore(ingestPool, { schema: "docmind" }), {
  liveSource: eventStore,
  onError: (err) => logger.error(err),
});
await service.registerFolded({
  projection: ingestStatus, // projection$({ id, version: "1", initialState, handlers })
  keyOf: (executionId) => /ingest-(.+?)(?:\.\d+)?$/.exec(executionId)?.[1],
  scopeOf: (executionId) => userPrefixOf(executionId),
});
const app = defineConfig({ /* … */ onEvent: (e) => service.handleEvent(e) });
await service.catchUp([eventStore]);                       // boot: heals + re-folds after a version bump

// request path (a reader instance: PostgresReadModelStore(readerPool, { schema: "docmind", manageSchema: false }))
const states = await readerService.getManyByKey("ingest-status", pageOfDocumentIds);
// right after a step the user just caused:
await service.getMany("ingest-status", [executionId], { refreshFrom: [eventStore] });
```
State the three rules in prose: state must be non-sensitive or app-sealed; keep `version` honest; `refresh` costs a tail read.

- [ ] **Step 2: `docs/compliance.md`** — "Folded read-model state": the fold copies plaintext out of the log; erase with `purgeFolded(model, { scope })` after `eraseSubject`; a tombstone keeps the watermark; rebuild needs a tolerant source and `isShredded` handling; link ADR 0132 D11/D12.

- [ ] **Step 3: `docs/api-reference.org` and `docs/README.md`** — add the entries; in README add a bullet "[0132](adr/0132-folded-state-read-model.md) added durable per-execution folded-state read models".

- [ ] **Step 4: Full local verify (the close-out)** — run exactly:

```bash
pnpm build && npx turbo test --force --concurrency=2 && pnpm typecheck && pnpm typecheck:tests && pnpm lint
```
Expected: all green. Fix anything biome reports with `pnpm lint --write` only where it is formatting in files this plan touched.

- [ ] **Step 5: Commit, then open a DRAFT PR** (do not mark ready; ask the owner first — see open questions).

```bash
git add docs/
git commit -m "docs: folded-state read models (ADR 0132) — plugins, compliance, api reference"
git push -u origin docs/folded-read-model   # only when the owner says to push
gh pr create --draft --title "feat(read-model): folded-state durable projections (ADR 0132)" --body "…"   # ends with the Claude Code attribution line
```
Merge later with `gh pr merge --rebase`.

---

## Self-review (run against the ADR)

- **Spec coverage:** D1 → T1, T4a, T5a. D2 → T4a (key/scope from executionId), T6 (generations). D3 → T2, T3, T8, T9b (CAS statement), T6. D4 → T4a (contiguity, gap, JSON normalize). D5 → T4a (version required), T5b (rebuild + old-node refusal), T2 (header guard). D6 → T1 (SPI), T2 (kit), T3/T8/T9b. D7 → T1 (`assertManyKeys`), T4b, T2. D8 → T4b/T5b (`refresh`, `refreshFrom`, `drain`). D9 → T4b (`getManyByKey`); paging explicitly absent. D10 → T9a/T9b. D11 → T10 docs (+ T7 hazard test). D12 → T3/T8/T9b tombstone, T5b, T7. D13 → T5a. D14 → T6. No gap found.
- **Placeholders:** the only abbreviated steps are T7's fixture (it MUST copy the harness from `erasure.test.ts`, named explicitly) and T9b's RLS test (specified assertion by assertion); every production code step has full code.
- **Type consistency:** `FoldedRecord`/`FoldedApply`/`FoldedSelector`/`FoldedState` are defined once in T1 and used verbatim in T3, T4a/b, T8, T9b; `foldedCapable`/`FoldedStore` (T4a) are what T5a imports; `refresh` returns "executions advanced" in T4b and T5b (the ADR D8 wording is corrected in T4b).
- **Size check (est. changed lines / files):** T1 ~120/3, T2 ~190/3, T3 ~100/2, T4a ~190/3, T4b ~150/3, T5a ~170/2, T5b ~110/2, T6 ~100/1, T7 ~120/1, T8 ~140/2, T9a ~110/3, T9b ~190/4, T10 ~150/5; none exceeds 200 / 10. If a task overruns when implemented, split it a/b at the step boundary before opening its PR.

## Open questions for the owner

1. **Version required for every folded model?** ADR 0095 left `version` optional. *Recommended default:* required (blank = `TypeError`), because auto-rebuild is the point; an unversioned durable fold is the silent-divergence hazard 0095 describes.
2. **`getMany` surfaces erased/never-matched as absent.** *Recommended default:* yes (indistinguishable to the caller); the alternative (returning `{ erased: true }`) would leak erasure state to UI code.
3. **Sensitive-state guard.** The framework cannot detect plaintext-sensitive state. *Recommended default:* documentation + tombstone purge only (D11/D12); do not add a heuristic scanner. Reopen if a second consumer stores user content in state.
4. **`refresh` semantics: log tail read per call.** *Recommended default:* adopt as written; DocMind uses `refreshFrom` only for the execution a user action just touched, and plain `getManyByKey` for list pages. A cheaper "wait until sequence N" API needs a per-node watermark notification channel and is not worth it for one consumer.
5. **Rolling-deploy behavior:** old-version nodes stop projecting (`FoldVersionMismatchError` to `onError`) until they restart on the new version; a rollback re-folds. *Recommended default:* accept; the alternative (dual-version tables) is overbuilt.
6. **Postgres schema ownership.** Should the library create tables lazily (default) or only emit `foldedStateDdl`? *Recommended default:* lazy for dev/default, and DocMind sets `manageSchema: false` on both instances and runs `foldedStateDdl({ schema: "docmind" })` in its own migrations beside the RLS policies, since its roles should not have DDL rights.
7. **In-process state cache in the live path.** *Recommended default:* none in v1 (one extra indexed read per handled event); add an LRU only against a measured ingest rate.
8. **Where DocMind computes `scopeOf`.** Assumed to be derivable from the executionId prefix; I did not read DocMind to confirm the prefix format. *Recommended default:* the owner confirms the prefix is stable and parseable; otherwise `scope` should come from a lookup table at write time, which would need `scopeOf` to become async (a small ADR amendment).
9. **Task sequencing / PR split.** *Recommended default:* three draft PRs: (A) tasks 1–7 (plugin + in-memory + kit), (B) task 8 (SQLite), (C) tasks 9a–10 (Postgres + docs), each under the 200 LOC / 10 file rule per task and rebase-merged in order.
