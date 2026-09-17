// Browser-safe subpath: only the in-memory stores, so importing it never pulls
// the SQLite store (better-sqlite3 / node:fs) that the package barrel re-exports.
// (These packages compile to CommonJS, which bundlers cannot tree-shake — hence a
// dedicated subpath rather than relying on `sideEffects`.)
// The in-memory branch registry is node-free too; a browser that forks needs it.
module.exports = {
  ...require("./dist/InMemoryAsyncEventStore"),
  ...require("./dist/InMemoryBranchRegistry"),
};
