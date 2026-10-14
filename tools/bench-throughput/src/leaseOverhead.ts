import { type LeaseBenchRow, measureLeaseOverhead } from "./leaseOverheadLib";

// ADR 0130 D11 / Q8 gate: eager heartbeat leasing costs <= 10% on the no-op throughput ceiling and
// nothing at I/O-bound durations, else fall back to lazy. See leaseOverheadLib.ts.
//
//   pnpm --filter @loom/bench-throughput bench:lease
//   LOOM_BENCH_REPEATS=7 LOOM_BENCH_CONC=64 LOOM_BENCH_EXECS=3000 pnpm --filter ... bench:lease

function intEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
  const concurrency = intEnv("LOOM_BENCH_CONC", 64);
  const executions = intEnv("LOOM_BENCH_EXECS", 3000);
  const sqliteExecutions = intEnv("LOOM_BENCH_SQLITE_EXECS", 1200);
  const ioExecutions = intEnv("LOOM_BENCH_IO_EXECS", 1500);
  const ioMs = intEnv("LOOM_BENCH_IO_MS", 20);
  const repeats = intEnv("LOOM_BENCH_REPEATS", 5);
  const rows: LeaseBenchRow[] = [];
  for (const [backend, shape, n] of [
    ["memory", "noop", executions],
    ["sqlite", "noop", sqliteExecutions],
    ["memory", "io", ioExecutions],
    ["sqlite", "io", ioExecutions],
  ] as const) {
    rows.push(
      await measureLeaseOverhead({ backend, shape, concurrency, executions: n, ioMs, repeats })
    );
  }
  console.log(`concurrency=${concurrency} repeats=${repeats} ioMs=${ioMs}`);
  console.log(
    "| backend | shape | execs | off exec/s | on exec/s | overhead % | off samples | on samples |"
  );
  console.log("|---|---|---:|---:|---:|---:|---|---|");
  const r0 = (x: number) => Math.round(x).toLocaleString("en-US");
  for (const r of rows)
    console.log(
      `| ${r.backend} | ${r.shape} | ${r.executions} | ${r0(r.off)} | ${r0(r.on)} | ${r.overheadPct.toFixed(1)} | ${r.offSamples.map(r0).join(" ")} | ${r.onSamples.map(r0).join(" ")} |`
    );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
