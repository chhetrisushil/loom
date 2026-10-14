// Testing-only subpath: the deterministic cipher seam (ADR 0130 residuals D7). Never part of the
// main entry; a custom IV source is refused when NODE_ENV is "production".
module.exports = require("./dist/testing");
