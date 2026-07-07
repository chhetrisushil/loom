// Browser-safe subpath: only the in-memory event store, so importing it never pulls
// the SQLite store (better-sqlite3 / node:fs) that the package barrel re-exports.
// (These packages compile to CommonJS, which bundlers cannot tree-shake — hence a
// dedicated subpath rather than relying on `sideEffects`.)
module.exports = require("./dist/InMemoryAsyncEventStore");
