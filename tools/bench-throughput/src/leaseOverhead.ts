import {
  type Backend,
  type LeaseBenchRow,
  type Shape,
  measureLeaseOverhead,
} from "./leaseOverheadLib";

// ADR 0130 D11 / Q8 gate: heartbeat leasing costs <= 10% on the no-op throughput ceiling and
// nothing at I/O-bound durations. Measures OFF vs EAGER vs LAZY (the S7g default). See leaseOverheadLib.ts.
//
//   pnpm --filter @loom/bench-throughput bench:lease
// LOOM_BENCH_PG_URL (postgres backend) MUST point at a THROWAWAY database: rows/tables are left
// behind. The pool max is 32, so the conc-256 cells are pool-bound as well as write-bound. The
// `execs` column is the count actually run (round(n / conc) * conc), not the configured n.
//
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
  // WARNING: LOOM_BENCH_PG_URL must be a THROWAWAY database (rows/tables are left behind).
  const backends = listEnv("LOOM_BENCH_BACKENDS", ["memory", "sqlite"]) as Backend[];
  const shapes = listEnv("LOOM_BENCH_SHAPES", ["noop", "io"]) as Shape[];
  const pgUrl = process.env.LOOM_BENCH_PG_URL ?? process.env.LOOM_TEST_POSTGRES_URL;
  const executions = intEnv("LOOM_BENCH_EXECS", 3000);
  const sqliteExecutions = intEnv("LOOM_BENCH_SQLITE_EXECS", 1200);
  const pgExecutions = intEnv("LOOM_BENCH_PG_EXECS", 1200);
  const ioExecutions = intEnv("LOOM_BENCH_IO_EXECS", 1500);
  const ioMs = intEnv("LOOM_BENCH_IO_MS", 20);
  const repeats = intEnv("LOOM_BENCH_REPEATS", 5);
  // LOOM_BENCH_IDS=caller (default) | minted: caller-chosen ids pay the sequence-0 bootstrap barrier.
  const ids = process.env.LOOM_BENCH_IDS === "minted" ? "minted" : "caller";
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
            ids,
            ...(pgUrl !== undefined && { pgUrl }),
          })
        );
      }
  console.log(`repeats=${repeats} ioMs=${ioMs} ids=${ids}`);
  console.log(
    "| backend | shape | conc | execs | off exec/s | eager exec/s | lazy exec/s | eager overhead % | lazy overhead % | eager paired med (min..max) % | lazy paired med (min..max) % | off samples | eager samples | lazy samples |"
  );
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|---|");
  const r0 = (x: number) => Math.round(x).toLocaleString("en-US");
  const f1 = (x: number) => x.toFixed(1);
  for (const r of rows)
    console.log(
      `| ${r.backend} | ${r.shape} | ${r.concurrency} | ${r.executions} | ${r0(r.off)} | ${r0(r.eager)} | ${r0(r.lazy)} | ${f1(r.eagerOverheadPct)} | ${f1(r.lazyOverheadPct)} | ${f1(r.eagerPairedMedianPct)} (${f1(r.eagerPairedMinPct)}..${f1(r.eagerPairedMaxPct)}) | ${f1(r.lazyPairedMedianPct)} (${f1(r.lazyPairedMinPct)}..${f1(r.lazyPairedMaxPct)}) | ${r.offSamples.map(r0).join(" ")} | ${r.eagerSamples.map(r0).join(" ")} | ${r.lazySamples.map(r0).join(" ")} |`
    );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
