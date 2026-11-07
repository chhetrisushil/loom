import { describe, expect, it } from "vitest";
import { defineConfig } from "./defineConfig";

// A stale kind used to fall through to the in-memory stores: it ran normally, wrote nothing, and
// lost every event on restart. The docs taught `{ kind: "sqlite" }` for months.
describe("defineConfig storage.kind", () => {
  const compose = (storage: unknown) =>
    defineConfig({ storage: storage as never, flows: [], checks: { verify: "off" } });

  it.each(["sqlite", "postgres"])("refuses %s, naming its preset", (kind) => {
    expect(() => compose({ kind, dir: ".data" })).toThrow(
      new RegExp(`${kind}Storage\\(.*@loom/plugin-${kind}`)
    );
  });

  it.each([["nonsense"], [undefined], [42]])("refuses an unknown kind: %s", (kind) => {
    expect(() => compose({ kind })).toThrow(/unknown storage kind/);
  });

  it("still accepts memory", () => {
    expect(compose({ kind: "memory" }).stores.eventStore).toBeDefined();
  });
});
