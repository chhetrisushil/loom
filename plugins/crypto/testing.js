// Testing-only subpath: the deterministic cipher seam (ADR 0130 residuals D7). Never part of the
// main entry; a custom IV source is allowed only under NODE_ENV=test or VITEST.
module.exports = require("./dist/testing");
