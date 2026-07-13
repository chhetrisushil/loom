import { describe, expect, it } from "vitest";
import { searchPlugins } from "./pluginSearch";

function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
  return (async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe("searchPlugins", () => {
  it("queries the loom-plugin keyword and maps registry hits", async () => {
    let calledUrl = "";
    const fetchImpl = (async (url: string) => {
      calledUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          objects: [
            {
              package: { name: "loom-plugin-redis", version: "1.2.0", description: "Redis store" },
            },
          ],
        }),
      };
    }) as unknown as typeof fetch;

    const hits = await searchPlugins("redis", fetchImpl);
    expect(calledUrl).toContain("keywords%3Aloom-plugin");
    expect(calledUrl).toContain("redis");
    expect(hits).toEqual([
      { name: "loom-plugin-redis", version: "1.2.0", description: "Redis store" },
    ]);
  });

  it("returns [] for no results and tolerates a missing description", async () => {
    const hits = await searchPlugins(
      "nope",
      fakeFetch({ objects: [{ package: { name: "x", version: "0.1.0" } }] })
    );
    expect(hits).toEqual([{ name: "x", version: "0.1.0", description: "" }]);
  });

  it("throws on a non-ok response", async () => {
    await expect(searchPlugins("x", fakeFetch({}, false, 503))).rejects.toThrow(/HTTP 503/);
  });
});
