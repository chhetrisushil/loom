import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { measureAgentLoop } from "./agentLoop/measure";
import { AGENT_LOOP_CEILINGS, AGENT_LOOP_THRESHOLDS } from "./agentLoop/thresholds";
import { measureAppgen } from "./appgen/measure";
import { APPGEN_THRESHOLDS } from "./appgen/thresholds";
import { measurePlanner } from "./planner/measure";
import { PLANNER_THRESHOLDS } from "./planner/thresholds";
import {
  BACKENDS,
  POSTGRES_SKIP_REASON,
  measureRetrieval,
  postgresBackend,
} from "./retrieval/measure";
import { retrievalThresholds } from "./retrieval/thresholds";
import {
  type MetricRow,
  type Scoreboard,
  buildScoreboard,
  compareAgainstBaseline,
  parseScoreboard,
  regressions,
  renderDeltas,
  renderScoreboardMarkdown,
  serializeScoreboard,
} from "./scoreboard";
import { measureSkills } from "./skills/measure";
import { SKILL_THRESHOLDS } from "./skills/thresholds";
import { measureToolSearch } from "./toolSearch/measure";
import { TOOL_SEARCH_THRESHOLDS } from "./toolSearch/thresholds";

// `pnpm eval`: measure every area, write `out/scoreboard.{json,md}`, print the delta against the committed
// baseline in `baseline/`, and exit non-zero on a gated regression. `--update-baseline` rewrites the baseline
// instead (a reviewed diff). The thresholds themselves are enforced by the vitest `*.eval.test.ts` files.

const ROOT = join(__dirname, "..");
const BASELINE = join(ROOT, "baseline");
const OUT = join(ROOT, "out");

export interface Collected {
  readonly board: Scoreboard;
  /** False when the Postgres leg did not run (no `LOOM_TEST_POSTGRES_URL`): the board is PARTIAL. */
  readonly postgresRan: boolean;
}

/**
 * `--update-baseline` on a partial board would silently drop the Postgres rows from the committed baseline
 * (and the next full run would then report them `new`). Refuse unless the caller says so with `--allow-partial`.
 */
export function baselineRefusal(postgresRan: boolean, argv: readonly string[]): string | undefined {
  if (postgresRan || argv.includes("--allow-partial")) return undefined;
  return "refusing to update the baseline: the Postgres leg did not run (LOOM_TEST_POSTGRES_URL is unset), so the new baseline would DROP every retrieval/postgres/* row. Set LOOM_TEST_POSTGRES_URL, or pass --allow-partial to write a partial baseline on purpose.";
}

export async function collect(): Promise<Collected> {
  const rows: MetricRow[] = [];
  rows.push(...(await measureToolSearch(TOOL_SEARCH_THRESHOLDS)));
  const pg = postgresBackend();
  if (pg === undefined) console.log(`note: ${POSTGRES_SKIP_REASON}`);
  rows.push(
    ...(await measureRetrieval(
      pg === undefined ? BACKENDS : [...BACKENDS, pg],
      retrievalThresholds
    ))
  );
  rows.push(...(await measureSkills(SKILL_THRESHOLDS)));
  rows.push(...(await measureAgentLoop(AGENT_LOOP_THRESHOLDS, AGENT_LOOP_CEILINGS)));
  rows.push(...(await measureAppgen(APPGEN_THRESHOLDS)));
  rows.push(...(await measurePlanner(PLANNER_THRESHOLDS)));
  return { board: buildScoreboard(rows), postgresRan: pg !== undefined };
}

async function main(): Promise<number> {
  const { board, postgresRan } = await collect();
  const json = serializeScoreboard(board);
  const md = renderScoreboardMarkdown(board);

  if (process.argv.includes("--update-baseline")) {
    const refusal = baselineRefusal(postgresRan, process.argv);
    if (refusal !== undefined) {
      console.error(refusal);
      return 1;
    }
    mkdirSync(BASELINE, { recursive: true });
    writeFileSync(join(BASELINE, "scoreboard.json"), json);
    writeFileSync(join(BASELINE, "scoreboard.md"), md);
    console.log(`baseline written (${Object.keys(board.metrics).length} metrics)`);
    return 0;
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "scoreboard.json"), json);
  writeFileSync(join(OUT, "scoreboard.md"), md);
  console.log(md);

  let baseline: Scoreboard;
  try {
    baseline = parseScoreboard(readFileSync(join(BASELINE, "scoreboard.json"), "utf8"));
  } catch {
    console.error(
      "no committed baseline (evals/baseline/scoreboard.json): run `pnpm eval:update-baseline`"
    );
    return 1;
  }
  const deltas = compareAgainstBaseline(board, baseline);
  console.log(renderDeltas(deltas));
  const bad = regressions(deltas);
  if (bad.length > 0) {
    console.error(`REGRESSION: ${bad.map((d) => d.key).join(", ")}`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
