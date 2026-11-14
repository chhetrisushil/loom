import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageInfo } from "./packageInfo";

// The MCP handshake once advertised `version: "0.0.1"` long after the package moved on. The
// handshake now reads the package's own manifest; this pins that it is the REAL one.
describe("packageInfo", () => {
  it("is this package's name and version, read from its package.json", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    expect(packageInfo()).toEqual({ name: "@loomwork/plugin-mcp", version: pkg.version });
    expect(packageInfo().version).not.toBe("0.0.1");
  });
});
