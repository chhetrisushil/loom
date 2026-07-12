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
  /** How it wires into `defineConfig` (shown to the author). */
  wiring: string;
  /** SPI packages the plugin depends on (besides `@loom/core`). */
  spiDeps: string[];
  /** `@loom/testing/conformance` runners to pre-wire, if any. */
  conformance: string[];
  /** `src/index.ts` body. */
  index: (name: string) => string;
  /** `src/index.test.ts` body. */
  test: (name: string) => string;
}

const SEAMS: Record<string, SeamDef> = {
  store: {
    key: "store",
    title: "Durable storage backend (EventStore + SnapshotStore [+ BranchRegistry])",
    wiring: "storage: <name>Storage({ /* … */ })",
    spiDeps: ["@loom/event-runtime", "@loom/snapshot-runtime"],
    conformance: ["runEventStoreConformance", "runSnapshotStoreConformance"],
    index: (name) => {
      const P = pascal(name);
      const c = camel(name);
      return [
        `import type { BranchRegistry, EventStore } from "@loom/event-runtime";`,
        `import type { SnapshotStore } from "@loom/snapshot-runtime";`,
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
        `export function ${c}Storage(options: ${P}StorageOptions): {`,
        '  kind: "custom";',
        "  eventStore: EventStore;",
        "  snapshotStore: SnapshotStore;",
        "  branchRegistry?: BranchRegistry;",
        "} {",
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
        '// } from "@loom/testing/conformance";',
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
    title: "Compute placement (ExecutionDispatcher)",
    wiring: "dispatcher: new <Name>Dispatcher({ /* … */ })",
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
        '// import { runExecutionDispatcherConformance } from "@loom/testing/conformance";',
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
    title: "Telemetry adapter (flow/step lifecycle hooks)",
    wiring: "telemetry: [<name>Telemetry({ /* … */ })]",
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
        ` * Wire it as \`telemetry: [${c}Telemetry()]\`; \`defineConfig\` composes multiple.`,
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
    title: "Effect middleware (wrap every effect execution)",
    wiring: "effectMiddleware: [<name>Middleware({ /* … */ })]",
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
        ` * \`effectMiddleware: [${c}Middleware()]\`; order is behavioural, so document where`,
        " * yours belongs relative to retry/metering.",
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
        '// import { runTimerStoreConformance } from "@loom/testing/conformance";',
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

  projection: {
    key: "projection",
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
        '// import { runProjectionRuntimeConformance } from "@loom/testing/conformance";',
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
};

export const SEAM_KEYS = Object.keys(SEAMS);

/** Human-readable seam list for `loom plugin seams`. */
export function listSeams(): string {
  const rows = SEAM_KEYS.map((k) => {
    const s = SEAMS[k]!;
    const conf = s.conformance.length > 0 ? " (conformance ✓)" : "";
    return `  ${k.padEnd(11)} ${s.title}${conf}\n              wire: ${s.wiring}`;
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
  if (seam.conformance.length > 0) devDeps["@loom/testing"] = version;
  devDeps.typescript = "^5.6.3";
  devDeps.vitest = "^2.1.8";

  const pkg: Record<string, unknown> = {
    name: packageName,
    version: "0.0.0",
    ...(firstParty ? {} : { private: false }),
    description: `A Loom ${seam.key} plugin — ${seam.title}.`,
    keywords: firstParty ? ["loom", "loom-plugin"] : ["loom", "loom-plugin", `loom-${seam.key}`],
    type: "commonjs",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: { ".": { require: "./dist/index.js", types: "./dist/index.d.ts" } },
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
    "- Prove it with `@loom/testing/conformance` (see `src/index.test.ts`).",
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
