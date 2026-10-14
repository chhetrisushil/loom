import {
  type Backend,
  type LeaseBenchRow,
  type Shape,
  measureLeaseOverhead,
} from "./leaseOverheadLib";

// ADR 0130 D11 / Q8 gate: eager heartbeat leasing costs <= 10% on the no-op throughput ceiling and
// nothing at I/O-bound durations, else fall back to lazy. See leaseOverheadLib.ts.
//
//   pnpm --filter @loom/bench-throughput bench:lease
//   LOOM_BENCH_REPEATS=7 LOOM_BENCH_CONC=64 LOOM_BENCH_EXECS=3000 pnpm --filter ... bench:lease

function intEnv(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function listEnv(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.split(",").map((x) => x.trim());
}

async function main(): Promise<void> {
  // LOOM_BENCH_CONCS=16,64,256 sweeps concurrency (LOOM_BENCH_CONC=64 alone is the old single value).
  const concs = listEnv("LOOM_BENCH_CONCS", [String(intEnv("LOOM_BENCH_CONC", 64))]).map(Number);
  // LOOM_BENCH_BACKENDS=memory,sqlite,postgres ; postgres needs LOOM_BENCH_PG_URL (or LOOM_TEST_POSTGRES_URL).
  const backends = listEnv("LOOM_BENCH_BACKENDS", ["memory", "sqlite"]) as Backend[];
  const shapes = listEnv("LOOM_BENCH_SHAPES", ["noop", "io"]) as Shape[];
  const pgUrl = process.env.LOOM_BENCH_PG_URL ?? process.env.LOOM_TEST_POSTGRES_URL;
  const executions = intEnv("LOOM_BENCH_EXECS", 3000);
  const sqliteExecutions = intEnv("LOOM_BENCH_SQLITE_EXECS", 1200);
  const pgExecutions = intEnv("LOOM_BENCH_PG_EXECS", 1200);
  const ioExecutions = intEnv("LOOM_BENCH_IO_EXECS", 1500);
  const ioMs = intEnv("LOOM_BENCH_IO_MS", 20);
  const repeats = intEnv("LOOM_BENCH_REPEATS", 5);
  const rows: LeaseBenchRow[] = [];
  for (const concurrency of concs)
    for (const backend of backends)
      for (const shape of shapes) {
        const n =
          shape === "io"
            ? ioExecutions
            : backend === "memory"
              ? executions
              : backend === "sqlite"
                ? sqliteExecutions
                : pgExecutions;
        rows.push(
          await measureLeaseOverhead({
            backend,
            shape,
            concurrency,
            executions: n,
            ioMs,
            repeats,
            ...(pgUrl !== undefined && { pgUrl }),
          })
        );
      }
  console.log(`repeats=${repeats} ioMs=${ioMs}`);
  console.log(
    "| backend | shape | conc | execs | off exec/s | on exec/s | overhead % (median ratio) | paired median % | paired min..max % | off samples | on samples |"
  );
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---|---|---|");
  const r0 = (x: number) => Math.round(x).toLocaleString("en-US");
  const f1 = (x: number) => x.toFixed(1);
  for (const r of rows)
    console.log(
      `| ${r.backend} | ${r.shape} | ${r.concurrency} | ${r.executions} | ${r0(r.off)} | ${r0(r.on)} | ${f1(r.overheadPct)} | ${f1(r.pairedMedianPct)} | ${f1(r.pairedMinPct)}..${f1(r.pairedMaxPct)} | ${r.offSamples.map(r0).join(" ")} | ${r.onSamples.map(r0).join(" ")} |`
    );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
