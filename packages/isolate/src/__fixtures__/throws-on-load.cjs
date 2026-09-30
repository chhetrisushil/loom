// Top-level code with a side effect that then throws. LOAD_LOG counts how many times the
// top-level code ran, so a test can tell "once" from "twice".
require("node:fs").appendFileSync(process.env.LOAD_LOG, "x");
throw new Error("boom at load");
