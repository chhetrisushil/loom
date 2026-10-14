// Operator-only entry (ADR 0130 residuals D7): the real cause behind a denial-shaped sealed
// refusal. Never part of the main entry, so an RPC/HTTP edge that re-exports the main index cannot
// hand callers the detail.
module.exports = require("./dist/operator");
