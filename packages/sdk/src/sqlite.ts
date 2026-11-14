// `@loomwork/sdk/sqlite` — the SQLite store plugin, re-exported behind a subpath so it is
// pulled in only by consumers that explicitly want it (keeps `@loomwork/sdk` browser-safe). The plugin
// is an optional peer: an app using this subpath adds `@loomwork/plugin-sqlite` beside the SDK.
export {
  SqliteEventStore,
  SqliteBranchRegistry,
  SqliteSnapshotStore,
  SqliteTimerStore,
  sqliteStorage,
  type SqliteStorageOptions,
} from "@loomwork/plugin-sqlite";
