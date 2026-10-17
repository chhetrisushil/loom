import { CassetteProvider } from "@loom/eval";
import type { LlmProvider } from "@loom/llm";
import { cassettePath, writeCassette } from "./agentLoop/cassettes";
import { runTask } from "./agentLoop/subject";
import { TASKS } from "./agentLoop/tasks";

// ── `pnpm eval:record`: LIVE cassette recording, on demand only (ADR 0131 D4.3) ───────────────────────────
//
// This is the ONLY code in `evals/` that can reach a model, and it cannot be reached by accident:
//   - it is not wired to `pnpm eval`, `pnpm test`, turbo, `eval:update-baseline`, install or any hook;
//   - it refuses under `CI=true`;
//   - without `--live` it is a DRY RUN that lists what it would (re)record and records nothing;
//   - with `--live` it still needs a model (`--model gemini:<id>` or `LOOM_EVAL_RECORD_MODEL`; no default is
//     guessed) and the Gemini key that loom's own `GeminiProvider` reads (`GEMINI_API_KEY`, else `GOOGLE_API_KEY`).
//     The key is checked for PRESENCE only and is never printed.
// The provider is loom's `GeminiProvider` from `@loom/llm` (the same adapter behind the CLI's `--model gemini:<m>`),
// loaded lazily, so importing this module (or running any eval) never constructs a provider or touches the network.
//
// It writes cassettes only (one file per task, `--task <id>` to re-record selectively, repeatable). It never edits
// thresholds or the baseline: review the cassette diff, run `pnpm eval`, then `pnpm eval:update-baseline`.

export const MODEL_ENV = "LOOM_EVAL_RECORD_MODEL";
export const KEY_ENVS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

export interface RecordArgs {
  readonly live: boolean;
  readonly model?: string;
  readonly tasks: readonly string[];
}

export function parseRecordArgs(argv: readonly string[]): RecordArgs {
  let live = false;
  let model: string | undefined;
  const tasks: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--live") live = true;
    else if (a === "--model") model = argv[++i];
    else if (a.startsWith("--model=")) model = a.slice("--model=".length);
    else if (a === "--task") tasks.push(argv[++i] ?? "");
    else if (a.startsWith("--task=")) tasks.push(a.slice("--task=".length));
    else
      throw new Error(`unknown argument "${a}" (flags: --live, --model gemini:<id>, --task <id>)`);
  }
  return { live, tasks, ...(model !== undefined && { model }) };
}

type Env = Readonly<Record<string, string | undefined>>;

/** Why a record run must not proceed, or `undefined`. Pure: reads nothing but its arguments. */
export function recordRefusal(args: RecordArgs, env: Env): string | undefined {
  if (env.CI === "true" || env.CI === "1") {
    return "refusing to record under CI=true: live recording is manual only (ADR 0131 D4.3)";
  }
  const known = new Set(TASKS.map((t) => t.id));
  for (const t of args.tasks) {
    if (!known.has(t)) return `unknown task "${t}" (known: ${[...known].join(", ")})`;
  }
  if (!args.live) return undefined; // a dry run needs no model and no key
  const model = args.model ?? env[MODEL_ENV];
  if (model === undefined || model === "") {
    return `no model given: pass --model gemini:<model-id> or set ${MODEL_ENV}=gemini:<model-id> (no default is assumed)`;
  }
  if (!model.startsWith("gemini:") || model.length <= "gemini:".length) {
    return `unsupported model "${model}": recording uses Gemini, as gemini:<model-id>`;
  }
  if (!KEY_ENVS.some((k) => (env[k] ?? "") !== "")) {
    return `no API key: set ${KEY_ENVS[0]} (or ${KEY_ENVS[1]}) in the environment (it is never printed)`;
  }
  return undefined;
}

export interface RecordDeps {
  /** Build the live provider for `gemini:<id>`; only ever called on a `--live` run that passed every check. */
  makeProvider(modelId: string): Promise<LlmProvider>;
  write(taskId: string, data: Record<string, unknown>): void;
  log(line: string): void;
}

async function geminiProvider(modelId: string): Promise<LlmProvider> {
  const { GeminiProvider } = await import("@loom/llm");
  return new GeminiProvider({ model: modelId });
}

const defaultDeps: RecordDeps = {
  makeProvider: geminiProvider,
  write: (id, data) => writeCassette(id, data as never),
  log: (l) => console.log(l),
};

/** Returns the process exit code. */
export async function runRecord(
  argv: readonly string[],
  env: Env,
  deps: RecordDeps = defaultDeps
): Promise<number> {
  let args: RecordArgs;
  try {
    args = parseRecordArgs(argv);
  } catch (e) {
    deps.log(String((e as Error).message));
    return 1;
  }
  const refusal = recordRefusal(args, env);
  if (refusal !== undefined) {
    deps.log(`eval:record: ${refusal}`);
    return 1;
  }
  const selected = TASKS.filter((t) => args.tasks.length === 0 || args.tasks.includes(t.id));
  if (!args.live) {
    deps.log("eval:record: DRY RUN (nothing is called, nothing is written). It would re-record:");
    for (const t of selected) deps.log(`  ${t.id}  ->  ${cassettePath(t.id)}`);
    deps.log(
      "Pass --live (and --model gemini:<id>, with GEMINI_API_KEY set) to record. Costs real tokens."
    );
    return 0;
  }
  const model = (args.model ?? env[MODEL_ENV]) as string;
  const modelId = model.slice("gemini:".length);
  const live = await deps.makeProvider(modelId);
  for (const t of selected) {
    // A fresh, empty cassette per task: the exchange is whatever the live model actually said.
    const rec = new CassetteProvider({ mode: "record", inner: live, data: {} });
    deps.log(`recording ${t.id} with gemini:${modelId} ...`);
    await runTask(t, rec);
    const data = rec.toJSON();
    deps.write(t.id, data);
    deps.log(`  ${t.id}: ${Object.keys(data).length} exchange(s) written`);
  }
  deps.log(
    "Done. Review the cassette diff, run `pnpm eval`, then `pnpm eval:update-baseline` if the scores moved on purpose."
  );
  return 0;
}

if (require.main === module) {
  runRecord(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  );
}
