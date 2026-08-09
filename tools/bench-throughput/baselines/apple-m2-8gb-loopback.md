<!-- Captured 2026-08-09T08:53Z. Verbatim output of `pnpm --filter @loom/bench-throughput hardware`. -->

# Loom hardware report

- node: v24.18.0 · darwin/arm64
- cpu: Apple M2 × 8 logical
- memory: 8.0 GB
- postgres: PostgreSQL 17.2 on x86_64-apple-darwin23.6.0, compiled by Apple clang version 16.0.0 (clang-1600.0.26.4), 64-bit
- **db round-trip: 0.304 ms** (a loopback database is ≲0.1 ms; a networked one is not)
- pg.fsync: on
- pg.max_connections: 300
- pg.shared_buffers: 163848kB
- pg.synchronous_commit: on
- pg.wal_level: replica
- pg.work_mem: 4096kB

## 1. Write path — where it saturates, and what concurrency buys past that

| concurrency | events/sec | p50 ms | p99 ms |
|---:|---:|---:|---:|
| 8 | 22,127 | 0.31 | 1.2 |
| 32 | 17,410 | 1.45 | 7.0 |
| 128 | 16,896 | 5.95 | 34.0 |
| 512 | 21,540 | 23.34 | 28.4 |

Peak sustained write throughput: **22,127 events/sec**.

## 2. Durable executions — the ceiling, and whether it matches `writes ÷ events-per-exec`

| steps | events/exec | exec/sec | events/sec | predicted exec/sec |
|---:|---:|---:|---:|---:|
| 1 | 4 | 3,436 | 13,745 | 5,532 |
| 3 | 8 | 2,788 | 22,304 | 2,766 |

## 3. Realistic effects — does execution concurrency scale?

1-step flow, 100 ms effect. Efficiency is against Little's Law (`concurrency ÷ latency`).

| concurrency | exec/sec | Little's Law | efficiency | p50 ms | p99 ms |
|---:|---:|---:|---:|---:|---:|
| 32 | 298 | 320 | 93% | 105 | 113 |
| 128 | 917 | 1,280 | 72% | 146 | 158 |
| 512 | 3,891 | 5,120 | 76% | 120 | 149 |

## 4. Write/effect crossover — which workloads are write-bound on this host

Share is of aggregate work time; ADR 0065 gate 1 asks exactly this question.

| effect latency | effect ms | write ms | write share | verdict |
|---:|---:|---:|---:|---|
| 0 ms | 19 | 3,632 | 99.5% | **write-bound** |
| 1 ms | 374 | 3,933 | 91.3% | **write-bound** |
| 5 ms | 3,122 | 2,374 | 43.2% | effect-bound |
| 25 ms | 5,669 | 1,195 | 17.4% | effect-bound |

Where this flips is the number that matters: above it, batching the write path cannot help however large the raw event rate looks.
