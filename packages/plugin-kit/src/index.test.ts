import { describe, expect, it } from "vitest";
import { type CustomStorage, defineStoragePreset } from "./index";

describe("defineStoragePreset", () => {
  it("is an identity helper that pins a function to the StoragePreset contract", () => {
    const fakeStores = {
      kind: "custom" as const,
      // biome-ignore lint/suspicious/noExplicitAny: opaque store stand-ins for the type test
      eventStore: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: opaque store stand-ins for the type test
      snapshotStore: {} as any,
    } satisfies CustomStorage;

    const preset = defineStoragePreset((_opts: { url: string }) => ({ ...fakeStores }));
    expect(preset).toBeTypeOf("function");
    expect(preset({ url: "x" }).kind).toBe("custom");
  });
});
