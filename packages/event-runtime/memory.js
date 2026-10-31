// Browser-safe subpath: only the in-memory stores, so importing it never pulls
// the SQLite store (better-sqlite3 / node:fs) that the package barrel re-exports.
// (These packages compile to CommonJS, which bundlers cannot tree-shake — hence a
// dedicated subpath rather than relying on `sideEffects`.)
// The in-memory branch registry is node-free too; a browser that forks needs it.
module.exports = {
  ...require("./dist/InMemoryAsyncEventStore"),
  ...require("./dist/InMemoryBranchRegistry"),
  // ADR 0138: the in-memory archive imports only the node-free SPI file (archiveSpi), not the digest helpers.
  InMemoryArchiveStore: require("./dist/InMemoryArchiveStore").InMemoryArchiveStore,
  // ADR 0130 D11: leases.ts has no imports, so the in-memory lease store is browser-safe too.
  InMemoryLeaseStore: require("./dist/leases").InMemoryLeaseStore,
};
