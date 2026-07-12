import { describe, expect, it } from "vitest";
import { type PluginFinding, checkPlugin } from "./plugin";

const levels = (f: PluginFinding[], level: PluginFinding["level"]) =>
  f.filter((x) => x.level === level).map((x) => x.message);

describe("checkPlugin", () => {
  it("passes a well-formed third-party store plugin", () => {
    const findings = checkPlugin(
      {
        name: "loom-plugin-redis",
        keywords: ["loom", "loom-plugin"],
        peerDependencies: { "@loom/event-runtime": "*", "@loom/snapshot-runtime": "*" },
      },
      ['import { runEventStoreConformance } from "@loom/testing/conformance";']
    );
    expect(levels(findings, "error")).toEqual([]);
    expect(levels(findings, "warn")).toEqual([]);
  });

  it("errors when the plugin depends on the replay fold engine", () => {
    const findings = checkPlugin(
      { name: "@loom/plugin-x", dependencies: { "@loom/replay-vm": "workspace:*" } },
      []
    );
    expect(levels(findings, "error")[0]).toMatch(/replay fold/);
  });

  it("warns a third-party plugin that bundles SPI packages instead of peering them", () => {
    const findings = checkPlugin(
      {
        name: "loom-plugin-x",
        keywords: ["loom-plugin"],
        dependencies: { "@loom/event-runtime": "*" },
      },
      ["conformance"]
    );
    expect(levels(findings, "warn").join()).toMatch(/peer-depend/);
  });

  it("warns on missing loom-plugin keyword and missing conformance", () => {
    const findings = checkPlugin({ name: "loom-plugin-x" }, []);
    expect(levels(findings, "warn").join()).toMatch(/keyword/);
    expect(levels(findings, "warn").join()).toMatch(/conformance/);
  });

  it("warns when the name follows neither convention", () => {
    const findings = checkPlugin({ name: "my-thing" }, ["@loom/testing/conformance"]);
    expect(levels(findings, "warn").join()).toMatch(/neither/);
  });

  it("allows a legitimate workflow-runtime dependency (a2a/renderer pattern)", () => {
    const findings = checkPlugin(
      { name: "@loom/plugin-a2a", dependencies: { "@loom/workflow-runtime": "workspace:*" } },
      ["@loom/testing/conformance"]
    );
    expect(levels(findings, "error")).toEqual([]);
  });
});
