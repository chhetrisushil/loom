// `@loomwork/sdk/postgres` — the Postgres store plugin, re-exported behind a subpath so `pg`
// is pulled in only by consumers that explicitly want it. The plugin is an optional peer: an app
// using this subpath adds `@loomwork/plugin-postgres` beside the SDK.
export {
  PostgresEventStore,
  PostgresSnapshotStore,
  PostgresBranchRegistry,
  PostgresTimerStore,
  postgresStorage,
  type PostgresStorageOptions,
} from "@loomwork/plugin-postgres";
