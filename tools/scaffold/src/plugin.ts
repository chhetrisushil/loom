import { camel, pascal } from "./codegen";

// ── Plugin scaffolding (used by `loom plugin new`) ───────────────────────────
//
// A Loom plugin is an ordinary package that implements an existing SPI and/or
// exports a preset `(opts) => Partial<LoomConfig>` (or a singleton like a
// StorageConfig), imported statically and passed to `defineConfig`. See ADR 0043
// and docs/plugins.md. This module emits a ready-to-fill package for a chosen
// seam, in either first-party (`@loom/plugin-*`, in `plugins/`) or third-party
// (`loom-plugin-*`, standalone) shape.

/** A replaceable seam a plugin can target. */
interface SeamDef {
  /** CLI key, e.g. "store". */
  key: string;
  title: string;
  /**
   * The SPI interface this seam is defined by. Load-bearing beyond documentation:
   * `seamDocs.test.ts` asserts every seam has a row naming it in the canonical SPI
   * map, so a seam cannot ship without appearing where implementers look for it.
   */
  spi: string;
  /**
   * How an app wires it, shown to the author. Usually a `defineConfig` key; a
   * seam whose implementation is consumed from flow code rather than from the
   * composition root says so instead of implying a config key that doesn't exist.
   */
  wiring: string;
  /** SPI packages the plugin depends on (besides `@loom/core`). */
  spiDeps: string[];
  /** `@loom/conformance` runners to pre-wire, if any. */
  conformance: string[];
  /** `src/index.ts` body. */
  index: (name: string) => string;
  /** `src/index.test.ts` body. */
  test: (name: string) => string;
}

const SEAMS: Record<string, SeamDef> = {
  store: {
    key: "store",
    spi: "EventStore",
    title: "Durable storage backend (EventStore + SnapshotStore [+ BranchRegistry])",
    wiring: "storage: <name>Storage({ /* … */ })",
    spiDeps: ["@loom/event-runtime", "@loom/snapshot-runtime", "@loom/plugin-kit"],
    conformance: ["runEventStoreConformance", "runSnapshotStoreConformance"],
    index: (name) => {
      const P = pascal(name);
      const c = camel(name);
      return [
        `import type { EventStore } from "@loom/event-runtime";`,
        `import type { SnapshotStore } from "@loom/snapshot-runtime";`,
        `import type { CustomStorage } from "@loom/plugin-kit";`,
        "",
        `export interface ${P}StorageOptions {`,
        "  /** Whatever your backend needs — a URL, a directory, a token. */",
        "  url: string;",
        "  /** Also provision a branch registry for fork/branch (optional). */",
        "  branching?: boolean;",
        "}",
        "",
        "/**",
        " * `defineConfig({ storage })` preset. Returns a `custom` storage descriptor with",
        " * your stores constructed — so `@loom/app` never learns your backend exists and a",
        " * third-party backend wires exactly like a first-party one (ADR 0043).",
        " */",
        `export function ${c}Storage(options: ${P}StorageOptions): CustomStorage {`,
        "  return {",
        '    kind: "custom",',
        `    eventStore: new ${P}EventStore(options.url),`,
        `    snapshotStore: new ${P}SnapshotStore(options.url),`,
        `    // ...(options.branching === true && { branchRegistry: new ${P}BranchRegistry(options.url) }),`,
        "  };",
        "}",
        "",
        "// --- Implement the SPIs against your backend; prove them with the conformance",
        "// kit (see index.test.ts). These stubs exist only so the template type-checks. ---",
        "",
        `export class ${P}EventStore implements EventStore {`,
        "  constructor(private readonly url: string) {}",
        "  append(): Promise<void> {",
        "    throw new Error(`not implemented (${this.url})`);",
        "  }",
        "  read(): Promise<never[]> {",
        '    throw new Error("not implemented");',
        "  }",
        "  readFrom(): Promise<never[]> {",
        '    throw new Error("not implemented");',
        "  }",
        "  subscribe(): Promise<() => void> {",
        '    throw new Error("not implemented");',
        "  }",
        "  close(): Promise<void> {",
        "    return Promise.resolve();",
        "  }",
        "}",
        "",
        `export class ${P}SnapshotStore implements SnapshotStore {`,
        "  constructor(private readonly url: string) {}",
        "  save(): Promise<void> {",
        "    throw new Error(`not implemented (${this.url})`);",
        "  }",
        "  loadLatest(): Promise<null> {",
        '    throw new Error("not implemented");',
        "  }",
        "  loadAt(): Promise<null> {",
        '    throw new Error("not implemented");',
        "  }",
        "  loadLatestBefore(): Promise<null> {",
        '    throw new Error("not implemented");',
        "  }",
        "  close(): Promise<void> {",
        "    return Promise.resolve();",
        "  }",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      const c = camel(name);
      return [
        "// Prove your stores satisfy the SPI with the published conformance kit — this is",
        '// what makes "plugin" a checkable category (ADR 0043). Wire real backends here.',
        "//",
        "// import {",
        "//   runEventStoreConformance,",
        "//   runSnapshotStoreConformance,",
        '// } from "@loom/conformance";',
        `// import { ${P}EventStore, ${P}SnapshotStore } from "./index";`,
        "//",
        `// runEventStoreConformance(() => new ${P}EventStore(":memory:"));`,
        `// runSnapshotStoreConformance(() => new ${P}SnapshotStore(":memory:"));`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${c}Storage } from "./index";`,
        "",
        `describe("${c}Storage preset", () => {`,
        '  it("returns a custom storage descriptor", () => {',
        `    const s = ${c}Storage({ url: ":memory:" });`,
        '    expect(s.kind).toBe("custom");',
        "    expect(s.eventStore).toBeDefined();",
        "    expect(s.snapshotStore).toBeDefined();",
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  dispatcher: {
    key: "dispatcher",
    spi: "ExecutionDispatcher",
    title: "Compute placement (ExecutionDispatcher)",
    wiring: "execution: { dispatcher: new <Name>Dispatcher({ /* … */ }) }",
    spiDeps: ["@loom/dispatcher"],
    conformance: ["runExecutionDispatcherConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        "import type {",
        "  DispatchMetadata,",
        "  DispatcherHealth,",
        "  ExecutionDispatcher,",
        "  ExecutionPackage,",
        "  ExecutionResult,",
        `} from "@loom/dispatcher";`,
        "",
        `export interface ${P}DispatcherOptions {`,
        "  /** Where/how this dispatcher places work. */",
        "  endpoint?: string;",
        "}",
        "",
        "/** An `ExecutionDispatcher`: decides WHERE an execution runs. Wire as `dispatcher`. */",
        `export class ${P}Dispatcher implements ExecutionDispatcher {`,
        `  constructor(private readonly options: ${P}DispatcherOptions = {}) {}`,
        "",
        "  dispatch(pkg: ExecutionPackage, _meta?: DispatchMetadata): Promise<ExecutionResult> {",
        "    throw new Error(`not implemented: dispatch ${pkg.executionId} to ${this.options.endpoint}`);",
        "  }",
        "",
        "  cancel(_executionId: string): Promise<void> {",
        "    return Promise.resolve();",
        "  }",
        "",
        "  health(): Promise<DispatcherHealth> {",
        '    throw new Error("not implemented");',
        "  }",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        "// Prove your dispatcher with the conformance kit once dispatch() is real:",
        '// import { runExecutionDispatcherConformance } from "@loom/conformance";',
        `// import { ${P}Dispatcher } from "./index";`,
        `// runExecutionDispatcherConformance(() => new ${P}Dispatcher());`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${P}Dispatcher } from "./index";`,
        "",
        `describe("${P}Dispatcher", () => {`,
        '  it("constructs and cancel() is a safe no-op", async () => {',
        `    const d = new ${P}Dispatcher();`,
        '    await expect(d.cancel("x")).resolves.toBeUndefined();',
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  telemetry: {
    key: "telemetry",
    spi: "TelemetryAdapter",
    title: "Telemetry adapter (flow/step lifecycle hooks)",
    wiring: "observability: { telemetry: [<name>Telemetry({ /* … */ })] }",
    spiDeps: ["@loom/telemetry"],
    conformance: [],
    index: (name) => {
      const P = pascal(name);
      const c = camel(name);
      return [
        `import type { TelemetryAdapter } from "@loom/telemetry";`,
        "",
        `export interface ${P}TelemetryOptions {`,
        "  /** e.g. a sink URL, a logger, a sampling rate. */",
        "  sink?: (line: string) => void;",
        "}",
        "",
        "/**",
        " * A `TelemetryAdapter`. Every hook is optional — implement the ones you care about.",
        ` * Wire it as \`observability: { telemetry: [${c}Telemetry()] }\`; \`defineConfig\` composes multiple.`,
        " */",
        `export function ${c}Telemetry(options: ${P}TelemetryOptions = {}): TelemetryAdapter {`,
        "  const emit: (line: string) => void = options.sink ?? (() => {});",
        "  return {",
        "    onStepComplete(info) {",
        "      emit(`step ${info.stepId} ${info.status} in ${info.durationMs ?? 0}ms`);",
        "    },",
        "    onStepFail(info) {",
        "      emit(`step ${info.stepId} FAILED`);",
        "    },",
        "  };",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      const c = camel(name);
      return [
        'import { describe, expect, it } from "vitest";',
        `import { ${c}Telemetry } from "./index";`,
        "",
        `describe("${P} telemetry", () => {`,
        '  it("emits on step completion", () => {',
        "    const lines: string[] = [];",
        `    const t = ${c}Telemetry({ sink: (l) => lines.push(l) });`,
        "    t.onStepComplete?.({",
        '      executionId: "e",',
        '      workflowId: "w",',
        '      stepId: "s",',
        "      attempt: 1,",
        "      startedAt: 0,",
        '      status: "completed",',
        "      durationMs: 5,",
        "    });",
        '    expect(lines[0]).toContain("step s completed");',
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  middleware: {
    key: "middleware",
    spi: "EffectMiddleware",
    title: "Effect middleware (wrap every effect execution)",
    wiring: "execution: { effectMiddleware: [<name>Middleware({ /* … */ })] }",
    spiDeps: ["@loom/effect-runtime"],
    conformance: [],
    index: (name) => {
      const P = pascal(name);
      const c = camel(name);
      return [
        `import type { EffectMiddleware } from "@loom/effect-runtime";`,
        "",
        `export interface ${P}MiddlewareOptions {`,
        "  /** your knobs here */",
        "  label?: string;",
        "}",
        "",
        "/**",
        " * An `EffectMiddleware` — an onion layer over every effect. `middleware[0]` is",
        " * outermost. It runs only for non-completed steps, so it is replay-safe. Wire as",
        ` * \`execution: { effectMiddleware: [${c}Middleware()] }\`; order is behavioural, so document where`,
        " * yours belongs relative to retry/metering.",
        " *",
        " * STREAMING (ADR 0119): if this middleware REJECTS or REWRITES the effect's output after",
        " * `next()`, a streamed delta would bypass it. It MUST then be marked `inspectsOutput: true`",
        " * (the runtime then disables live streaming for the call, fail-closed) or provide a",
        " * `deltaGuard` that checks the running text. Leave both unset only if you never alter or",
        " * refuse the output.",
        " */",
        `export function ${c}Middleware(options: ${P}MiddlewareOptions = {}): EffectMiddleware {`,
        `  const label = options.label ?? "${name}";`,
        "  return async (ctx, input, next) => {",
        "    // before: inspect ctx.stepId / ctx.attempt / ctx.emit(...)",
        "    void label;",
        "    const result = await next(input);",
        "    // after: inspect / transform result",
        "    return result;",
        "  };",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      const c = camel(name);
      return [
        'import { describe, expect, it } from "vitest";',
        `import { ${c}Middleware } from "./index";`,
        "",
        `describe("${P} middleware", () => {`,
        '  it("passes the effect result through", async () => {',
        `    const mw = ${c}Middleware();`,
        "    const ctx = {",
        '      executionId: "e",',
        '      stepId: "s",',
        '      workflowId: "w",',
        "      attempt: 1,",
        "      emit: () => {},",
        "    };",
        "    // biome-ignore lint/suspicious/noExplicitAny: minimal EffectContext for the test",
        "    const out = await mw(ctx as any, 42, async (i) => i);",
        "    expect(out).toBe(42);",
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  timer: {
    key: "timer",
    spi: "TimerStore",
    title: "Durable timer store (T1 scheduled wakes)",
    wiring: "timers: { store: new <Name>TimerStore() }",
    spiDeps: ["@loom/event-runtime"],
    conformance: ["runTimerStoreConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        'import type { TimerRecord, TimerStore } from "@loom/event-runtime";',
        "",
        "/** A `TimerStore` — the findable half of `ctx.sleep`. Wire as `timers: { store }`. */",
        `export class ${P}TimerStore implements TimerStore {`,
        "  schedule(_timer: TimerRecord): Promise<void> {",
        '    throw new Error("not implemented");',
        "  }",
        "  due(_now: number, _limit?: number): Promise<TimerRecord[]> {",
        '    throw new Error("not implemented");',
        "  }",
        "  complete(_executionId: string, _wakeAt: number): Promise<void> {",
        '    throw new Error("not implemented");',
        "  }",
        "  close(): Promise<void> {",
        "    return Promise.resolve();",
        "  }",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        "// Prove your timer store with the conformance kit once the methods are real:",
        '// import { runTimerStoreConformance } from "@loom/conformance";',
        `// import { ${P}TimerStore } from "./index";`,
        `// runTimerStoreConformance(() => new ${P}TimerStore());`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${P}TimerStore } from "./index";`,
        "",
        `describe("${P}TimerStore", () => {`,
        '  it("constructs", () => {',
        `    expect(new ${P}TimerStore()).toBeDefined();`,
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  lease: {
    key: "lease",
    spi: "LeaseStore",
    title: "Execution ownership leases (#380 — claim before waking)",
    wiring: 'timers: { store, leases: { store: new <Name>LeaseStore(), owner: "node-1" } }',
    spiDeps: ["@loom/event-runtime"],
    conformance: ["runLeaseStoreConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        'import type { Lease, LeaseStore } from "@loom/event-runtime";',
        "",
        "/**",
        " * A `LeaseStore` — who owns an execution right now.",
        " *",
        " * The three return values carry the whole contract, and getting one of them wrong is",
        " * how a lease store causes the split-brain it exists to prevent:",
        " *",
        " * - `acquire` returns `null` when ANOTHER owner holds an unexpired lease. Re-acquiring",
        " *   one you already hold is a renewal, not a conflict — a node that restarts must be",
        " *   able to take back its own work.",
        " * - `renew` returns `false` when ownership was lost. Never resurrect a lease another",
        " *   owner has taken: a caller that keeps working on `false` is the split-brain.",
        " * - `expired` is the evidence an execution was orphaned — soonest-expired first.",
        " *",
        " * The optional `get` answers a different question from `expired`: *is anything watching",
        " * this execution at all*. An execution that never had a lease is invisible to `expired`,",
        " * and it is not orphaned — it is unwatched (`loom census` counts those separately).",
        " *",
        " * Implement against a store with an atomic compare-and-set; the first-party SQLite and",
        " * Postgres stores each do it in ONE statement, because a read-then-write is exactly the",
        " * race this is meant to close.",
        " */",
        `export class ${P}LeaseStore implements LeaseStore {`,
        "  acquire(",
        "    _executionId: string,",
        "    _owner: string,",
        "    _ttlMs: number,",
        "    _now?: number",
        "  ): Promise<Lease | null> {",
        '    throw new Error("not implemented");',
        "  }",
        "  renew(_executionId: string, _owner: string, _ttlMs: number, _now?: number): Promise<boolean> {",
        '    throw new Error("not implemented");',
        "  }",
        "  expired(_now?: number, _limit?: number): Promise<Lease[]> {",
        '    throw new Error("not implemented");',
        "  }",
        "  release(_executionId: string, _owner: string): Promise<void> {",
        '    throw new Error("not implemented");',
        "  }",
        "  /** Optional. Omit it and `loom census` reports coverage as unknown rather than zero. */",
        "  get(_executionId: string): Promise<Lease | null> {",
        '    throw new Error("not implemented");',
        "  }",
        "  close(): Promise<void> {",
        "    return Promise.resolve();",
        "  }",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        "// Prove your lease store with the conformance kit once the methods are real. Do not",
        "// skip it: the kit covers the concurrent cases (two owners racing, renewal after",
        "// expiry, release by a non-owner) that a hand-written test usually misses.",
        '// import { runLeaseStoreConformance } from "@loom/conformance";',
        `// import { ${P}LeaseStore } from "./index";`,
        `// runLeaseStoreConformance(() => new ${P}LeaseStore());`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${P}LeaseStore } from "./index";`,
        "",
        `describe("${P}LeaseStore", () => {`,
        '  it("constructs", () => {',
        `    expect(new ${P}LeaseStore()).toBeDefined();`,
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  content: {
    key: "content",
    spi: "ContentStore",
    title: "Content-addressed blob store (claim-check payloads)",
    wiring: "claimCheckMiddleware({ store: new <Name>ContentStore(), inlineCapBytes: 16 * 1024 })",
    spiDeps: ["@loom/plugin-content"],
    conformance: ["runContentStoreConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        'import type { ContentRef, ContentStore } from "@loom/plugin-content";',
        "",
        "/**",
        " * A `ContentStore` — where a claim-check payload actually lives (ADR 0046).",
        " *",
        " * Content-ADDRESSED: `put` is keyed by the hash of the bytes, so storing the same",
        " * payload twice is one object and a retry is free. That is what makes the store safe",
        " * to call from a replayed effect.",
        " *",
        " * `get` returns `null` for an absent ref and MUST NOT throw: a missing blob is a fact",
        " * the caller handles (the log still has the digest), not an exception that aborts a",
        " * replay. `delete` is idempotent PHYSICAL erasure — it is the K10 shredding path, so",
        " * deleting what is already gone must succeed rather than object.",
        " */",
        `export class ${P}ContentStore implements ContentStore {`,
        "  put(_bytes: Uint8Array): Promise<ContentRef> {",
        '    throw new Error("not implemented");',
        "  }",
        "  get(_ref: ContentRef): Promise<Uint8Array | null> {",
        '    throw new Error("not implemented");',
        "  }",
        "  delete(_ref: ContentRef): Promise<void> {",
        '    throw new Error("not implemented");',
        "  }",
        "  // Optional, and worth implementing where the backend has them natively:",
        "  //   putStream(stream: AsyncIterable<Uint8Array>): Promise<ContentRef>  — ADR 0059",
        "  //   getMany(refs: readonly ContentRef[]): Promise<(Uint8Array | null)[]> — ADR 0062",
        "  //   deleteIfUntouchedSince(ref: ContentRef, cutoffMs: number): Promise<boolean>",
        "  //   listPage(opts: ContentListPageOptions): Promise<ContentListPage>  — ADR 0055 D5/D6",
        "  //   touchClock(): Promise<number>  — now, on the clock you stamp touch times with",
        "  //   touch(addresses: readonly string[]): Promise<string[]>  — SPI 1.4.0: bump touch times",
        "  //     WITHOUT a put (max); unknown addresses are a no-op, resolved as the missing list.",
        "  //     `loom sweep content --orphans --apply` REFUSES a store without it (forks and appends",
        "  //     that carry a ref call it).",
        "  // Implement the first three TOGETHER (the kit fails a partial set), and then EVERY put must",
        "  // bump the blob's touch time, never backwards, even for bytes you already hold",
        "  // (ON CONFLICT DO UPDATE, not INSERT OR IGNORE): they make `loom sweep content`",
        "  // race-safe and let it reclaim orphans.",
        "  // Left out rather than stubbed: a throwing optional method is worse than an absent",
        "  // one, because callers feature-detect it.",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        "// Prove it with the kit once the methods are real — it covers the idempotence that",
        "// content addressing depends on (same bytes twice, delete twice, get after delete):",
        '// import { runContentStoreConformance } from "@loom/conformance";',
        `// import { ${P}ContentStore } from "./index";`,
        `// runContentStoreConformance(() => new ${P}ContentStore());`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${P}ContentStore } from "./index";`,
        "",
        `describe("${P}ContentStore", () => {`,
        '  it("constructs", () => {',
        `    expect(new ${P}ContentStore()).toBeDefined();`,
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  "durable-state": {
    key: "durable-state",
    spi: "DurableStateStore",
    title: "Carry state across executions (compare-and-set)",
    wiring:
      'durableState({ id: "carry", version: 1, schema, store: new <Name>DurableStateStore() })',
    spiDeps: ["@loom/plugin-durable-state"],
    conformance: ["runDurableStateStoreConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        'import type { DurableStateRecord, DurableStateStore } from "@loom/plugin-durable-state";',
        "",
        "/**",
        " * A `DurableStateStore` — state that OUTLIVES one execution (a sentinel's carry).",
        " *",
        " * `save` is a compare-and-set on `expectedRevision`, and that is the whole point: two",
        " * nodes finishing the same sentinel run must not silently overwrite each other. A",
        " * mismatch REJECTS rather than wins; the caller re-reads and decides. Implement it as",
        " * one conditional statement, not read-then-write, or the race you are closing is the",
        " * race you introduce.",
        " *",
        " * `load` returns `null` when the key was never written — distinct from a record whose",
        " * payload happens to be empty.",
        " */",
        `export class ${P}DurableStateStore implements DurableStateStore {`,
        "  load(_key: string): Promise<DurableStateRecord | null> {",
        '    throw new Error("not implemented");',
        "  }",
        "  save(",
        "    _key: string,",
        "    _value: { contractVersion: number; payload: unknown },",
        "    _expectedRevision: number",
        "  ): Promise<DurableStateRecord> {",
        '    throw new Error("not implemented");',
        "  }",
        "  clear(_key: string): Promise<void> {",
        '    throw new Error("not implemented");',
        "  }",
        "  close(): Promise<void> {",
        "    return Promise.resolve();",
        "  }",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        "// The kit covers the concurrent compare-and-set cases a hand-written test misses:",
        '// import { runDurableStateStoreConformance } from "@loom/conformance";',
        `// import { ${P}DurableStateStore } from "./index";`,
        `// runDurableStateStoreConformance(() => new ${P}DurableStateStore());`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${P}DurableStateStore } from "./index";`,
        "",
        `describe("${P}DurableStateStore", () => {`,
        '  it("constructs", () => {',
        `    expect(new ${P}DurableStateStore()).toBeDefined();`,
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  "read-model": {
    key: "read-model",
    spi: "ReadModelStore",
    title: "Durable cross-execution query layer (ADR 0058)",
    wiring: "new ReadModelService(new <Name>ReadModelStore())",
    spiDeps: ["@loom/plugin-read-model"],
    conformance: ["runReadModelStoreConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        "import type {",
        "  ReadModelPage,",
        "  ReadModelQuery,",
        "  ReadModelRow,",
        "  ReadModelStore,",
        '} from "@loom/plugin-read-model";',
        "",
        "/**",
        " * A `ReadModelStore` — the durable index behind cross-execution queries (ADR 0058).",
        " *",
        " * Two properties carry it, and both are about REPLAY rather than about querying:",
        " *",
        " * - `apply` is idempotent per `rowId`. A catch-up re-reads events the store already",
        " *   saw, so applying the same row twice must leave one row, not two.",
        " * - the watermark is MONOTONIC. `apply` advances it to `upToSequence` atomically with",
        " *   the rows; if the rows land and the watermark does not, the next pass re-applies",
        " *   them (fine), but the reverse loses them forever.",
        " *",
        " * `query` pages by KEYSET, not offset: a read model grows while you page through it.",
        " */",
        `export class ${P}ReadModelStore implements ReadModelStore {`,
        "  apply(",
        "    _modelId: string,",
        "    _executionId: string,",
        "    _upToSequence: number,",
        "    _rows: readonly ReadModelRow[]",
        "  ): Promise<void> {",
        '    throw new Error("not implemented");',
        "  }",
        "  watermark(_modelId: string, _executionId: string): Promise<number | null> {",
        '    throw new Error("not implemented");',
        "  }",
        "  watermarkedExecutions(_modelId: string): Promise<string[]> {",
        '    throw new Error("not implemented");',
        "  }",
        "  query(_modelId: string, _q?: ReadModelQuery): Promise<ReadModelPage> {",
        '    throw new Error("not implemented");',
        "  }",
        "  clear(_modelId: string): Promise<void> {",
        '    throw new Error("not implemented");',
        "  }",
        "  close(): Promise<void> {",
        "    return Promise.resolve();",
        "  }",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        "// The kit covers idempotent re-apply and watermark monotonicity — the two things a",
        "// read model is wrong about silently:",
        '// import { runReadModelStoreConformance } from "@loom/conformance";',
        `// import { ${P}ReadModelStore } from "./index";`,
        `// runReadModelStoreConformance(() => new ${P}ReadModelStore());`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${P}ReadModelStore } from "./index";`,
        "",
        `describe("${P}ReadModelStore", () => {`,
        '  it("constructs", () => {',
        `    expect(new ${P}ReadModelStore()).toBeDefined();`,
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  keystore: {
    key: "keystore",
    spi: "KeyStore",
    title: "Per-subject encryption keys (K10 crypto-shredding)",
    wiring: "new EncryptingEventStore(inner, new <Name>KeyStore(), { sensitive })",
    spiDeps: ["@loom/plugin-crypto"],
    conformance: ["runKeyStoreConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        'import type { KeyStore } from "@loom/plugin-crypto";',
        "",
        "/**",
        " * A `KeyStore` — one encryption key per subject, and therefore the erasure boundary.",
        " *",
        " * `destroy` is IRREVERSIBLE and is how loom honours an erasure request without",
        " * rewriting an append-only log: destroy the key and the subject's events become",
        " * undecryptable everywhere at once, including in backups you cannot reach. There is no",
        " * undo, so back this with a KMS/HSM in production rather than with a table you might",
        " * restore from a snapshot.",
        " *",
        " * `get` returns `null` both for a key never created AND for one destroyed — the caller",
        " * cannot distinguish them, deliberately: after shredding there is nothing true to say.",
        " */",
        `export class ${P}KeyStore implements KeyStore {`,
        "  getOrCreate(_subjectId: string): Promise<Buffer> {",
        '    throw new Error("not implemented");',
        "  }",
        "  get(_subjectId: string): Promise<Buffer | null> {",
        '    throw new Error("not implemented");',
        "  }",
        "  destroy(_subjectId: string): Promise<void> {",
        '    throw new Error("not implemented");',
        "  }",
        "  // OPTIONAL, left out until implemented (conformance skips a store without it): true only",
        "  // if THIS store destroyed the subject's key (persist the tombstone), so a retry can prove",
        "  // destruction. Uncomment and implement it; do not stub it to return true.",
        "  // wasDestroyed(_subjectId: string): Promise<boolean> {",
        '  //   throw new Error("not implemented");',
        "  // }",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        "// The kit covers the irreversibility: get-after-destroy is null, and getOrCreate does",
        "// NOT resurrect a shredded subject.",
        '// import { runKeyStoreConformance } from "@loom/conformance";',
        `// import { ${P}KeyStore } from "./index";`,
        `// runKeyStoreConformance(() => new ${P}KeyStore());`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${P}KeyStore } from "./index";`,
        "",
        `describe("${P}KeyStore", () => {`,
        '  it("constructs", () => {',
        `    expect(new ${P}KeyStore()).toBeDefined();`,
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  memory: {
    key: "memory",
    spi: "MemoryStore",
    title: "Agent memory store (scoped entries, optional relevance search)",
    wiring: "memoryStore: new <Name>MemoryStore()",
    spiDeps: ["@loom/memory"],
    conformance: ["runMemoryStoreConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        'import type { MemoryEntry, MemoryStore } from "@loom/memory";',
        "",
        "/**",
        " * A `MemoryStore` — durable agent memory. Wire as `memoryStore`.",
        " *",
        " * A key names an ORDERED LIST of entries. `read` returns them in APPEND order,",
        " * not timestamp order: entries routinely share a timestamp (one turn written in",
        " * one tick), so a backend needs an insertion key of its own. An absent key reads",
        " * as `[]`, never a throw, and `clear` is idempotent.",
        " *",
        " * An entry may carry a caller-assigned `id`, and round-tripping it is REQUIRED —",
        " * appended with one it reads back with the same one, appended without one it reads",
        " * back with NONE (`{ content }` must not become `{ id: null, content }`). This is",
        " * the field a backend that decomposes an entry into columns forgets, and the",
        " * forgetting is silent: removal above the SPI matches on the id `read` gives back,",
        " * so a dropped id turns a delete into a no-op rather than an error.",
        " *",
        " * The other four are OPTIONAL, and PRESENCE IS THE FEATURE FLAG:",
        " * the runtime tests for the method and falls back when it is missing. A stub that",
        " * throws is therefore worse than no stub at all — it would advertise a capability",
        " * the store does not have. Add each one only when you implement it:",
        " *",
        " *   replace(key, entries)  atomic whole-list rewrite. Without it, eviction is",
        " *                          clear-then-re-append, and a crash between the two loses",
        " *                          the scope.",
        " *   search(key, query, o)  relevance retrieval, best first — what separates memory",
        " *                          from the tail of a conversation. Index",
        " *                          `searchableText(entry)` and split terms with `tokenize`",
        " *                          (both exported by @loom/memory), because what gets",
        " *                          indexed and what counts as a term are the contract.",
        " *   remove(key, ids)       delete named entries, survivors keeping append order.",
        " *                          Idempotent; an entry with NO id is never removed by any",
        " *                          list of ids. Without it, the runtime rewrites the whole",
        " *                          key instead — correct, and O(scope) per document edit.",
        " *   close()                release a handle or a pool.",
        " *",
        " * `runMemoryStoreConformance` covers the required verbs and skips the optional",
        " * ones you have not added.",
        " */",
        `export class ${P}MemoryStore implements MemoryStore {`,
        "  append(_key: string, _entry: MemoryEntry): Promise<void> {",
        '    throw new Error("not implemented");',
        "  }",
        "  read(_key: string): Promise<MemoryEntry[]> {",
        '    throw new Error("not implemented");',
        "  }",
        "  clear(_key: string): Promise<void> {",
        '    throw new Error("not implemented");',
        "  }",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        "// Prove your memory store with the conformance kit once the methods are real:",
        '// import { runMemoryStoreConformance } from "@loom/conformance";',
        `// import { ${P}MemoryStore } from "./index";`,
        `// runMemoryStoreConformance(() => new ${P}MemoryStore());`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${P}MemoryStore } from "./index";`,
        "",
        `describe("${P}MemoryStore", () => {`,
        '  it("constructs", () => {',
        `    expect(new ${P}MemoryStore()).toBeDefined();`,
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  projection: {
    key: "projection",
    spi: "ProjectionRuntime",
    title: "Projection runtime (custom read-model backend)",
    wiring: "projectionRuntime: new <Name>ProjectionRuntime()",
    spiDeps: ["@loom/projection-runtime"],
    conformance: ["runProjectionRuntimeConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        'import type { EventEnvelope } from "@loom/core";',
        'import type { Projection, ProjectionRuntime } from "@loom/projection-runtime";',
        "",
        "/** A `ProjectionRuntime` — folds events into read-models. Wire as `projectionRuntime`. */",
        `export class ${P}ProjectionRuntime implements ProjectionRuntime {`,
        "  register<TState>(_projection: Projection<TState>): void {",
        '    throw new Error("not implemented");',
        "  }",
        "  getState<TState>(_projectionId: string, _executionId: string): TState {",
        '    throw new Error("not implemented");',
        "  }",
        "  subscribe<TState>(",
        "    _projectionId: string,",
        "    _executionId: string,",
        "    _handler: (state: TState) => void",
        "  ): () => void {",
        '    throw new Error("not implemented");',
        "  }",
        "  /**",
        "   * Slice-scoped subscription (ADR 0068). Change-only, exactly like `subscribe`: it",
        "   * does NOT fire on subscribe, and the last slice is seeded from current state so the",
        "   * first handler call is the first genuine change.",
        "   */",
        "  subscribeSelector<TState, TSlice>(",
        "    _projectionId: string,",
        "    _executionId: string,",
        "    _selector: (state: TState) => TSlice,",
        "    _handler: (slice: TSlice) => void,",
        "    _isEqual?: (a: TSlice, b: TSlice) => boolean",
        "  ): () => void {",
        '    throw new Error("not implemented");',
        "  }",
        "  handleEvent(_event: EventEnvelope): void {",
        '    throw new Error("not implemented");',
        "  }",
        "  seedState(_projectionId: string, _executionId: string, _state: unknown): void {",
        '    throw new Error("not implemented");',
        "  }",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        "// Prove your projection runtime with the conformance kit once methods are real:",
        '// import { runProjectionRuntimeConformance } from "@loom/conformance";',
        `// import { ${P}ProjectionRuntime } from "./index";`,
        `// runProjectionRuntimeConformance(() => new ${P}ProjectionRuntime());`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${P}ProjectionRuntime } from "./index";`,
        "",
        `describe("${P}ProjectionRuntime", () => {`,
        '  it("constructs", () => {',
        `    expect(new ${P}ProjectionRuntime()).toBeDefined();`,
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  worker: {
    key: "worker",
    spi: "WorkerRuntime",
    title: "Worker runtime (run an execution on some compute)",
    wiring: "execution: { dispatcher: new LocalDispatcher(new <Name>Worker()) }",
    spiDeps: ["@loom/worker-runtime"],
    conformance: ["runWorkerRuntimeConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        "import type {",
        "  ExecutionPackage,",
        "  ExecutionResult,",
        "  WorkerLease,",
        "  WorkerRequest,",
        "  WorkerRuntime,",
        '} from "@loom/worker-runtime";',
        "",
        "/** A `WorkerRuntime` — runs an ExecutionPackage on some compute; wrap it in a dispatcher. */",
        `export class ${P}Worker implements WorkerRuntime {`,
        "  allocate(request: WorkerRequest): Promise<WorkerLease> {",
        "    return Promise.resolve({ leaseId: `lease-${request.executionId}` });",
        "  }",
        "  execute(_lease: WorkerLease, pkg: ExecutionPackage): Promise<ExecutionResult> {",
        "    throw new Error(`not implemented: execute ${pkg.executionId}`);",
        "  }",
        "  release(_lease: WorkerLease): Promise<void> {",
        "    return Promise.resolve();",
        "  }",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        "// Prove your worker with the conformance kit once execute() is real — it needs a",
        "// package your worker can run, so the factory returns { worker, pkg }:",
        '// import { runWorkerRuntimeConformance } from "@loom/conformance";',
        `// import { ${P}Worker } from "./index";`,
        `// runWorkerRuntimeConformance(() => ({ worker: new ${P}Worker(), pkg: /* runnable ExecutionPackage */ }));`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${P}Worker } from "./index";`,
        "",
        `describe("${P}Worker", () => {`,
        '  it("allocate returns a lease", async () => {',
        `    const lease = await new ${P}Worker().allocate({ executionId: "e" });`,
        '    expect(typeof lease.leaseId).toBe("string");',
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  llm: {
    key: "llm",
    spi: "LlmProvider",
    title: "LLM provider (model backend)",
    wiring: "createLlmEffect({ provider: new <Name>Provider() })",
    spiDeps: ["@loom/llm"],
    conformance: ["runLlmProviderConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        'import { assertRequestSupported } from "@loom/llm";',
        'import type { LlmCapabilities, LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";',
        "",
        "/** An `LlmProvider` — wire via `createLlmEffect({ provider })` or an agent's `provider`. */",
        `export class ${P}Provider implements LlmProvider {`,
        "  // Media this provider accepts (R5). ABSENT = text + tool calls only; declare e.g.",
        '  // `{ image: ["image/png", "image/jpeg"] }` and map the parts in complete().',
        "  readonly capabilities?: LlmCapabilities;",
        "",
        "  async complete(request: LlmRequest): Promise<LlmResponse> {",
        "    // Fail closed on an undeclared modality BEFORE any network call.",
        `    assertRequestSupported(request, this.capabilities, "${P}Provider");`,
        "    // Message content is `string | LlmContentPart[]` — read it with `textOf` / `toParts`.",
        "    throw new Error(`not implemented: complete (${request.messages.length} messages)`);",
        "  }",
        "  // stream?(request: LlmRequest): AsyncIterable<LlmStreamChunk> — optional",
        "  // warm?(): void | Promise<void> — optional advisory pre-warm",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        "// Prove your provider with the conformance kit once complete() is real:",
        '// import { runLlmProviderConformance } from "@loom/conformance";',
        `// import { ${P}Provider } from "./index";`,
        "//",
        "// A `toolRequest` this provider answers WITH a tool call is REQUIRED once it has",
        "// `stream` — without one the kit fails (an unproven tool-call parity is a refusal,",
        "// not a pass). A provider that never calls tools opts out with `toolRequest: null`.",
        `// runLlmProviderConformance(() => new ${P}Provider(), "${P}Provider", { toolRequest: someToolRequest });`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${P}Provider } from "./index";`,
        "",
        `describe("${P}Provider", () => {`,
        '  it("constructs", () => {',
        `    expect(new ${P}Provider()).toBeDefined();`,
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  authorizer: {
    key: "authorizer",
    spi: "CapabilityAuthorizer",
    title: "Capability authorizer (allow/deny each effect)",
    wiring: "security: { authorizer: new <Name>Authorizer() }",
    spiDeps: ["@loom/effect-runtime"],
    conformance: ["runCapabilityAuthorizerConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        "import type {",
        "  CapabilityAuthorizer,",
        "  CapabilityDecision,",
        "  CapabilityRequest,",
        '} from "@loom/effect-runtime";',
        "",
        "/** A `CapabilityAuthorizer` — allow/deny each effect. Wire as `authorizer`. */",
        `export class ${P}Authorizer implements CapabilityAuthorizer {`,
        "  authorize(req: CapabilityRequest): CapabilityDecision {",
        "    // TODO: your policy. Default-deny is the safe placeholder.",
        "    return { allowed: false, reason: `not implemented (${req.toolId})` };",
        "  }",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        "// Prove your authorizer with the conformance kit (decision shape + determinism):",
        '// import { runCapabilityAuthorizerConformance } from "@loom/conformance";',
        `// import { ${P}Authorizer } from "./index";`,
        `// runCapabilityAuthorizerConformance(() => new ${P}Authorizer());`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${P}Authorizer } from "./index";`,
        "",
        `describe("${P}Authorizer", () => {`,
        '  it("returns a boolean decision", () => {',
        `    const d = new ${P}Authorizer().authorize({`,
        '      toolId: "t",',
        '      executionId: "e",',
        '      workflowId: "w",',
        '      stepId: "s",',
        "    });",
        '    expect(typeof d.allowed).toBe("boolean");',
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  "execution-authorizer": {
    key: "execution-authorizer",
    spi: "ExecutionAuthorizer",
    title: "Execution-lifecycle authorizer (start/resume/cancel/query)",
    wiring: "security: { executionAuthorizer: new <Name>ExecutionAuthorizer() }",
    spiDeps: ["@loom/workflow-runtime"],
    conformance: ["runExecutionAuthorizerConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        "import type {",
        "  ExecutionAuthorizer,",
        "  ExecutionAuthzRequest,",
        "  ExecutionAuthzVerdict,",
        '} from "@loom/workflow-runtime";',
        "",
        "/**",
        " * An `ExecutionAuthorizer` — gates the execution LIFECYCLE, where a",
        " * `CapabilityAuthorizer` gates individual effects. Consulted at the entry of",
        " * `start`, `resume`, `cancel` and the public `loadState` (query).",
        " *",
        " * Answer every op: `cancel` and `query` are the two that get forgotten, and an",
        " * authorizer that allows an op it never considered is a hole that looks like a policy.",
        " * The verdict is SYNCHRONOUS — it is read before anything is appended, so there is no",
        " * async escape hatch here by design.",
        " *",
        " * `request.principal` is OPTIONAL, and how to treat its absence is your decision:",
        " * denying anonymous access and allowing it are both real policies; throwing is not,",
        " * because the caller is left with no verdict to act on.",
        " */",
        `export class ${P}ExecutionAuthorizer implements ExecutionAuthorizer {`,
        "  authorize(request: ExecutionAuthzRequest): ExecutionAuthzVerdict {",
        "    // TODO: your policy. Default-deny is the safe placeholder.",
        "    return { allowed: false, reason: `not implemented (${request.op})` };",
        "  }",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        "// The kit checks every lifecycle op is answered, determinism, and that the verdict is",
        "// synchronous — un-comment once your policy is real:",
        '// import { runExecutionAuthorizerConformance } from "@loom/conformance";',
        `// import { ${P}ExecutionAuthorizer } from "./index";`,
        `// runExecutionAuthorizerConformance(() => new ${P}ExecutionAuthorizer());`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${P}ExecutionAuthorizer } from "./index";`,
        "",
        `describe("${P}ExecutionAuthorizer", () => {`,
        '  it("denies by default until a policy is written", () => {',
        `    const verdict = new ${P}ExecutionAuthorizer().authorize({`,
        '      op: "start",',
        '      executionId: "e",',
        '      workflowId: "w",',
        "    });",
        "    expect(verdict.allowed).toBe(false);",
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  "resume-authenticator": {
    key: "resume-authenticator",
    spi: "ResumeAuthenticator",
    title: "Resume authority (K12.2 — may this event reopen an execution?)",
    wiring: "security: { resumeAuthenticator: new <Name>ResumeAuthenticator() }",
    spiDeps: ["@loom/workflow-runtime"],
    conformance: ["runResumeAuthenticatorConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        "import type {",
        "  ResumeAuthenticator,",
        "  ResumeEvent,",
        "  ResumeVerdict,",
        '} from "@loom/workflow-runtime";',
        "",
        "/**",
        " * A `ResumeAuthenticator` — may this event REOPEN a suspended execution (K12.2)?",
        " *",
        " * The narrowest of loom's three authority rings, and the one an attacker reaches",
        " * first: a resume arrives from OUTSIDE the process, where an effect call and a",
        " * lifecycle call do not. A signed approval from your identity provider is verified",
        " * here, before the event is appended.",
        " *",
        " * Three statuses, and the third is the one to get right:",
        " *",
        " * - `verified` — you checked, and it is genuine. Name the `actor` and what",
        " *   `verifiedBy` them, because both land in the log as the record of WHO resumed.",
        " * - `rejected` — refuse it. Carries a reason, which `ApprovalRejectedError` puts in",
        " *   front of whoever tried.",
        " * - `not-applicable` — *this event is not mine to judge*. The runtime treats it as no",
        " *   opinion and lets the resume proceed. It is NOT a soft denial: returning it for an",
        " *   event you meant to refuse has allowed that event.",
        " */",
        `export class ${P}ResumeAuthenticator implements ResumeAuthenticator {`,
        "  verify(event: ResumeEvent): ResumeVerdict {",
        "    // TODO: verify the signature/token over the WHOLE event — `payload` AND, when present,",
        "    // `discardLegacyAnswers` (ADR 0104: honoured only on a verified event, so a signature",
        "    // over `payload` alone lets a caller attach it). Refusing by default is",
        "    // the safe placeholder — `not-applicable` would let everything through.",
        '    return { status: "rejected", reason: `not implemented (${event.eventType})` };',
        "  }",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        "// The kit checks the verdict is one of the three statuses, is deterministic, and that",
        "// a rejection carries a non-empty reason:",
        '// import { runResumeAuthenticatorConformance } from "@loom/conformance";',
        `// import { ${P}ResumeAuthenticator } from "./index";`,
        `// runResumeAuthenticatorConformance(() => new ${P}ResumeAuthenticator());`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${P}ResumeAuthenticator } from "./index";`,
        "",
        `describe("${P}ResumeAuthenticator", () => {`,
        '  it("refuses by default until the verification is written", () => {',
        `    const verdict = new ${P}ResumeAuthenticator().verify({`,
        '      eventType: "Approved",',
        "      payload: {},",
        "    });",
        '    expect(verdict.status).toBe("rejected");',
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  "timer-dispatcher": {
    key: "timer-dispatcher",
    spi: "TimerDispatcher",
    title: "Where a due wake runs (#392 placement for timers)",
    wiring: "timers: { store, dispatcher: new <Name>TimerDispatcher() }",
    spiDeps: ["@loom/workflow-runtime"],
    conformance: ["runTimerDispatcherConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        'import type { TimerDispatcher } from "@loom/workflow-runtime";',
        "",
        "/**",
        " * A `TimerDispatcher` — where a due wake RUNS (#392).",
        " *",
        " * Without one, a timer resumes the execution inside whichever process happens to poll",
        " * the store; with one, it runs on the lane the execution was STARTED on. That matters",
        " * when a branch was given its own compute: it otherwise wakes up in the web server.",
        " *",
        " * The `target` is a HINT and may name a lane that no longer exists — a node is often",
        " * recovering an execution precisely BECAUSE its lane went away. Fall back; never",
        " * strand the wake, which would leave the execution suspended forever.",
        " *",
        " * Pass `resumeEvent` through UNCHANGED. The kernel owns the resume vocabulary (K7.5);",
        " * a transport that reinterprets it changes what the log records.",
        " */",
        `export class ${P}TimerDispatcher implements TimerDispatcher {`,
        "  dispatch(",
        "    _pkg: {",
        "      executionId: string;",
        "      workflowId: string;",
        "      flowId: string;",
        "      resumeEvent: { eventType: string; payload: unknown };",
        "      metadata?: Record<string, unknown>;",
        "    },",
        "    _meta?: { target?: string }",
        "  ): Promise<unknown> {",
        '    throw new Error("not implemented");',
        "  }",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        "// The kit checks the two things a dispatcher is silently wrong about: an unknown",
        "// target must not strand the wake, and the resume event must pass through unchanged.",
        '// import { runTimerDispatcherConformance } from "@loom/conformance";',
        `// import { ${P}TimerDispatcher } from "./index";`,
        `// runTimerDispatcherConformance(() => new ${P}TimerDispatcher());`,
        "",
        'import { describe, expect, it } from "vitest";',
        `import { ${P}TimerDispatcher } from "./index";`,
        "",
        `describe("${P}TimerDispatcher", () => {`,
        '  it("constructs", () => {',
        `    expect(new ${P}TimerDispatcher()).toBeDefined();`,
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },

  policy: {
    key: "policy",
    spi: "Policy",
    title: "Learned policy (choose an action from an observation)",
    // The one seam that is NOT a defineConfig contributor. A policy is consumed
    // from flow code, deliberately: ADR 0080 keeps the runtime unaware that a
    // policy exists, so a learned choice can only ever reach a run through
    // `ctx.decide` — recorded, replayable, auditable.
    wiring:
      "decideWithPolicy(ctx, id, new <Name>Policy(), context, actions)  — flow code, NOT defineConfig",
    spiDeps: ["@loom/learning"],
    conformance: ["runPolicyConformance"],
    index: (name) => {
      const P = pascal(name);
      return [
        'import type { Policy, PolicyChoice, PolicyContext } from "@loom/learning";',
        "",
        "/**",
        " * A `Policy` — given an observation, choose one of the offered actions.",
        " *",
        " * Consumed from flow code via `decideWithPolicy(ctx, id, policy, context, actions)`,",
        " * which records the choice as a durable decision along with the context and the",
        " * propensity. There is no `defineConfig` key: the runtime never learns a policy",
        " * exists (ADR 0080).",
        " *",
        " * Two contracts to honour:",
        " *  - `select` must be PURE and cheap. It runs before `ctx.decide`, so on replay it",
        " *    is called and its answer discarded.",
        " *  - `propensity` is `P(chosen | context)` and must be EXACT. Nothing downstream",
        " *    can detect a misreported one, and it biases every later off-policy estimate.",
        " *    Return 1 only if this policy is genuinely deterministic — a log written that",
        " *    way holds no counterfactuals and can never evaluate the next candidate.",
        " */",
        `export class ${P}Policy<A = string> implements Policy<A> {`,
        `  readonly id = "${name}";`,
        "  /** Bump when you retrain. A policy object is one immutable snapshot. */",
        '  readonly version = "1";',
        "",
        "  select(context: PolicyContext, actions: readonly A[]): PolicyChoice<A> {",
        "    if (actions.length === 0) {",
        `      throw new Error("${P}Policy: no actions to choose from");`,
        "    }",
        "    // Replace with your algorithm. Train offline from `trajectories(events)`",
        "    // and ship the result as a NEW version.",
        "    void context;",
        "    return { action: actions[0] as A, propensity: 1 };",
        "  }",
        "}",
        "",
      ].join("\n");
    },
    test: (name) => {
      const P = pascal(name);
      return [
        'import { runPolicyConformance } from "@loom/conformance";',
        'import { describe, expect, it } from "vitest";',
        `import { ${P}Policy } from "./index";`,
        "",
        "// The SPI kit: proves the shape and the propensity contract, never the quality",
        "// of what you choose. Pass observations representative of what you will see.",
        "runPolicyConformance<string>(",
        `  () => new ${P}Policy<string>(),`,
        '  ["a", "b", "c"],',
        "  [{ feature: 0 }, { feature: 1 }]",
        ");",
        "",
        `describe("${P}Policy", () => {`,
        '  it("chooses from the offered actions", () => {',
        `    expect(["a", "b"]).toContain(new ${P}Policy<string>().select({}, ["a", "b"]).action);`,
        "  });",
        "});",
        "",
      ].join("\n");
    },
  },
};

export const SEAM_KEYS = Object.keys(SEAMS);

/** seam key → SPI interface name. Consumed by the seam/doc coverage fitness test. */
export const SEAM_SPI: Record<string, string> = Object.fromEntries(
  Object.entries(SEAMS).map(([k, v]) => [k, v.spi])
);

/** seam key → the line that wires it. Consumed by the wiring fitness test. */
export const SEAM_WIRING: Record<string, string> = Object.fromEntries(
  Object.entries(SEAMS).map(([k, v]) => [k, v.wiring])
);

/** Human-readable seam list for `loom plugin seams`. */
export function listSeams(): string {
  // Derived, not a constant: a seam key longer than the column silently breaks the alignment
  // of every row, which is how `durable-state` landed mid-column the first time.
  const width = Math.max(...SEAM_KEYS.map((k) => k.length));
  const rows = SEAM_KEYS.map((k) => {
    const s = SEAMS[k]!;
    const conf = s.conformance.length > 0 ? " (conformance ✓)" : "";
    return `  ${k.padEnd(width)} ${s.title}${conf}\n  ${" ".repeat(width)} wire: ${s.wiring}`;
  });
  return `Loom plugin seams (loom plugin new <seam> <name>):\n\n${rows.join("\n")}`;
}

function pluginPackageJson(seam: SeamDef, packageName: string, firstParty: boolean): string {
  // @loom/core is foundational (its types back every seam) and is always in the
  // tsconfig references, so it is always a dependency — deduped against seam.spiDeps.
  const spi = [...new Set(["@loom/core", ...seam.spiDeps])];
  const version = firstParty ? "workspace:*" : "*";
  const deps: Record<string, string> = {};
  for (const d of spi) deps[d] = version;

  const devDeps: Record<string, string> = {};
  if (seam.conformance.length > 0) devDeps["@loom/conformance"] = version;
  devDeps.typescript = "^5.6.3";
  devDeps.vitest = "^2.1.8";
  // A template that writes `Buffer` in a signature needs node's ambient types, or the package
  // it scaffolds does not compile — which is how `loom plugin new keystore` shipped code
  // nobody could build. Derived from the emitted source rather than listed per seam, so a
  // template that starts using Buffer tomorrow is covered without anyone remembering.
  if (usesNodeGlobals(seam.index("probe"))) devDeps["@types/node"] = "^22.0.0";

  const pkg: Record<string, unknown> = {
    name: packageName,
    version: "0.0.0",
    ...(firstParty ? {} : { private: false }),
    description: `A Loom ${seam.key} plugin — ${seam.title}.`,
    keywords: firstParty ? ["loom", "loom-plugin"] : ["loom", "loom-plugin", `loom-${seam.key}`],
    type: "commonjs",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    // `types` first (TypeScript matches conditions in order), `default` LAST — it is
    // the fallback that any condition set matches, and without it an `import`, which
    // offers ["node", "import"] and never "require", resolves nothing at all.
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        require: "./dist/index.js",
        default: "./dist/index.js",
      },
    },
    scripts: {
      build: "tsc --build",
      test: "vitest run",
      clean: "rm -rf dist tsconfig.tsbuildinfo",
    },
    ...(firstParty ? { dependencies: deps } : { peerDependencies: deps }),
    devDependencies: firstParty ? devDeps : { ...deps, ...devDeps },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** Node globals a template can reference that only `@types/node` declares. */
const NODE_GLOBALS = /\b(Buffer|process|__dirname|NodeJS\.)/;

/**
 * Does this template's CODE use a node global?
 *
 * Comments are stripped first, and that is not a detail: two seams describe "the process" in
 * their prose, and matching those would have added `@types/node` to packages whose code never
 * touches it. A sweep that reads comments is measuring prose, not code.
 */
export function usesNodeGlobals(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return NODE_GLOBALS.test(code);
}

function pluginTsconfig(seam: SeamDef, firstParty: boolean): string {
  if (firstParty) {
    const refs = ["@loom/core", ...seam.spiDeps].map(
      (d) => `    { "path": "../../packages/${d.replace("@loom/", "")}" }`
    );
    return [
      "{",
      '  "extends": "../../tsconfig.base.json",',
      '  "compilerOptions": { "rootDir": "src", "outDir": "dist" },',
      '  "include": ["src/**/*"],',
      '  "exclude": ["node_modules", "dist", "**/*.test.ts"],',
      '  "references": [',
      refs.join(",\n"),
      "  ]",
      "}",
      "",
    ].join("\n");
  }
  return [
    "{",
    '  "compilerOptions": {',
    '    "target": "ES2022",',
    '    "module": "CommonJS",',
    '    "moduleResolution": "node",',
    '    "declaration": true,',
    '    "strict": true,',
    '    "esModuleInterop": true,',
    '    "skipLibCheck": true,',
    '    "rootDir": "src",',
    '    "outDir": "dist"',
    "  },",
    '  "include": ["src/**/*"],',
    '  "exclude": ["node_modules", "dist", "**/*.test.ts"]',
    "}",
    "",
  ].join("\n");
}

function pluginReadme(
  seam: SeamDef,
  name: string,
  packageName: string,
  firstParty: boolean
): string {
  const wire = seam.wiring.replace(/<name>/g, camel(name)).replace(/<Name>/g, pascal(name));
  return [
    `# ${packageName}`,
    "",
    `A Loom **${seam.key}** plugin — ${seam.title}.`,
    "",
    "## Wire it",
    "",
    "```ts",
    'import { defineConfig } from "@loom/app";',
    `// import { … } from "${packageName}";`,
    "",
    `export const app = defineConfig({ ${wire} });`,
    "```",
    "",
    "## Contract",
    "",
    "- Implement the SPI; keep the preset a pure function.",
    "- Contribute only to existing seams — no kernel hook, no reducer into the replay fold.",
    "- Prove it with `@loom/conformance` (see `src/index.test.ts`).",
    firstParty
      ? "- First-party: lives in `plugins/`, conformance-gated in Loom CI."
      : "- Third-party: publish under `loom-plugin-*`, keyword `loom-plugin`; you own the supply-chain trust.",
    "",
    "See https://github.com/chhetrisushil/loom/blob/main/docs/plugins.md",
    "",
  ].join("\n");
}

/**
 * Scaffold a plugin package for `seam`, named `name`, in first- or third-party
 * shape. Returns a map of relative path → file contents (pure — the CLI writes).
 */
export function pluginFiles(
  seamKey: string,
  name: string,
  opts: { firstParty: boolean }
): Record<string, string> {
  const seam = SEAMS[seamKey];
  if (seam === undefined) {
    throw new Error(`unknown seam "${seamKey}" — expected ${SEAM_KEYS.join(" | ")}`);
  }
  // `name` is interpolated straight into a path AND a package name, and the caller writes
  // every returned key to disk. Unvalidated, `loom plugin new store ../../x` scaffolds
  // outside the target directory. A plugin name is a single npm-style token; anything with
  // a separator or a leading dot is a mistake at best.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(
      `invalid plugin name "${name}" — use lowercase letters, digits and hyphens (no slashes, dots, or leading hyphen)`
    );
  }
  const dir = opts.firstParty ? `plugins/${name}` : `loom-plugin-${name}`;
  const packageName = opts.firstParty ? `@loom/plugin-${name}` : `loom-plugin-${name}`;
  return {
    [`${dir}/package.json`]: pluginPackageJson(seam, packageName, opts.firstParty),
    [`${dir}/tsconfig.json`]: pluginTsconfig(seam, opts.firstParty),
    [`${dir}/src/index.ts`]: seam.index(name),
    [`${dir}/src/index.test.ts`]: seam.test(name),
    [`${dir}/README.md`]: pluginReadme(seam, name, packageName, opts.firstParty),
  };
}
