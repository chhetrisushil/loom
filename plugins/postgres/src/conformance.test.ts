import {
  runBranchRegistryConformance,
  runEventStoreConformance,
  runEventStoreDecoratorConformance,
  runLeaseStoreConformance,
  runMemoryStoreConformance,
  runReadModelStoreConformance,
} from "@loom/conformance";
import { CoalescingEventStore, TenantScopedEventStore } from "@loom/event-runtime";
import { Pool } from "pg";
import { afterAll, beforeAll, describe } from "vitest";
import { PostgresBranchRegistry } from "./PostgresBranchRegistry";
import { PostgresEventStore } from "./PostgresEventStore";
import { PostgresLeaseStore } from "./PostgresLeaseStore";
import { PostgresMemoryStore } from "./PostgresMemoryStore";
import { PostgresReadModelStore } from "./PostgresReadModelStore";
import { migrate } from "./schema";

// The portable EventStore contract (ADR 0033) against the Postgres backend — now including
// the `appendBatch` cases (SPI 1.3.0 / ADR 0074 D1), which is what makes the batching
// implementation verifiable rather than merely present. Gated on LOOM_TEST_POSTGRES_URL
// like the rest of the Postgres suite.
//
// Each conformance case writes under fixed ids ("x", "b", "f", …), so cases must not see
// each other's rows. Every `factory()` call therefore gets its OWN schema — cheaper and
// stronger than truncating between cases, and it keeps this file from racing the sibling
// suites vitest runs concurrently against the same database.
const PG_URL = process.env.LOOM_TEST_POSTGRES_URL;

const SCHEMA_COUNT = 32; // comfortably above the case count of the largest kit run here
const schemaName = (i: number): string => `loom_conf_${process.pid}_${i}`;

if (PG_URL === undefined) {
  describe.skip("PostgresEventStore conformance (needs LOOM_TEST_POSTGRES_URL)", () => {});
} else {
  const pools: Pool[] = [];
  let next = 0;
  // Its own cursor, not a shared one: the MemoryStore kit writes only to `memory_entries`,
  // so sharing a schema with an EventStore case is harmless, while sharing one with ANOTHER
  // memory case (which a shared cursor would cause once the two kits' case counts pass
  // SCHEMA_COUNT) would let fixed keys like "k" leak between cases.
  let nextMemory = 0;
  // Likewise for the read-model kit: its cases share fixed model ids ("m", "a", "b"), so it
  // needs its own cursor rather than sharing the EventStore's. Until now the Postgres read
  // model was covered only by a hand-rolled case in `postgres-stores.test.ts` while the
  // SQLite one was held to the kit — so the portable contract was enforced on one backend
  // and merely assumed on the other.
  let nextReadModel = 0;
  // And for the branch-registry kit, whose cases share fixed ref names ("main", "cand-a").
  // Until now the Postgres BranchRegistry ran against NO kit at all — SQLite was held to the
  // portable contract while the Postgres implementation, the one with hand-written
  // compare-and-set SQL, was merely assumed to match it.
  let nextBranch = 0;
  // Its own cursor as well: the lease kit reuses fixed ids ("x", "y") per case.
  let nextLease = 0;
  // ADR 0074 Amendment (L1) — the decorator kit over the REAL backend, so the SQL
  // `appendBatch`, fencing and keyset paging are exercised THROUGH the decorators. Each run
  // gets its own cursor AND its own tenant: the tenant prefix keeps its rows (and its
  // enumeration) apart from every other run sharing a schema.
  let nextTenant = 0;
  let nextCoalescedTenant = 0;

  beforeAll(async () => {
    // Create and migrate every schema up front, so `factory()` can stay synchronous (the
    // conformance contract) and hand back a store that is immediately usable.
    const admin = new Pool({ connectionString: PG_URL });
    try {
      for (let i = 0; i < SCHEMA_COUNT; i++) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schemaName(i)} CASCADE`);
        await admin.query(`CREATE SCHEMA ${schemaName(i)}`);
      }
    } finally {
      await admin.end();
    }
    for (let i = 0; i < SCHEMA_COUNT; i++) {
      const pool = new Pool({
        connectionString: PG_URL,
        options: `-c search_path=${schemaName(i)}`,
        max: 4,
      });
      pools.push(pool);
      await migrate(pool);
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
    const admin = new Pool({ connectionString: PG_URL });
    try {
      for (let i = 0; i < SCHEMA_COUNT; i++) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schemaName(i)} CASCADE`);
      }
    } finally {
      await admin.end();
    }
  }, 60_000);

  runEventStoreConformance(() => {
    const pool = pools[next++ % pools.length] as Pool;
    return new PostgresEventStore(pool);
  }, "PostgresEventStore");

  runEventStoreDecoratorConformance(
    "TenantScopedEventStore over Postgres",
    (inner) => new TenantScopedEventStore(inner, "dk-tenant"),
    { inner: () => new PostgresEventStore(pools[nextTenant++ % pools.length] as Pool) }
  );

  runEventStoreDecoratorConformance(
    "Coalescing(TenantScopedEventStore) over Postgres",
    (inner) => new CoalescingEventStore(new TenantScopedEventStore(inner, "dk-coalesced")),
    { inner: () => new PostgresEventStore(pools[nextCoalescedTenant++ % pools.length] as Pool) }
  );

  runMemoryStoreConformance(() => {
    const pool = pools[nextMemory++ % pools.length] as Pool;
    return new PostgresMemoryStore(pool);
  }, "PostgresMemoryStore");

  runReadModelStoreConformance(() => {
    const pool = pools[nextReadModel++ % pools.length] as Pool;
    return new PostgresReadModelStore(pool);
  }, "PostgresReadModelStore");

  runLeaseStoreConformance(() => {
    const pool = pools[nextLease++ % pools.length] as Pool;
    return new PostgresLeaseStore(pool);
  }, "PostgresLeaseStore");

  runBranchRegistryConformance(() => {
    const pool = pools[nextBranch++ % pools.length] as Pool;
    return new PostgresBranchRegistry(pool);
  }, "PostgresBranchRegistry");
}
