# Host baselines

One file per host, each the verbatim output of:

```bash
LOOM_TEST_POSTGRES_URL=postgres://… pnpm --filter @loom/bench-throughput hardware
```

The report is self-describing — CPU, memory, Postgres version and settings, and the
**database round-trip time** are in the output — so two files can be diffed directly and the
difference attributed. Round-trip is the one to check first: a loopback database is ≲0.1 ms
and a networked one is not, and that single number explains most disagreements between hosts.

Add a file when you measure a new host. Do not edit an existing one in place — a baseline
whose provenance is unclear is worse than none.
