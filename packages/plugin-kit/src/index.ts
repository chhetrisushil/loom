// Type helpers for authoring Loom plugins. This package intentionally depends only
// on the SPI interface packages — never on @loom/app — so a store plugin can be
// typed against the preset contract without pulling in the composition layer (and
// without the app→plugin cycle that would create). See ADR 0043 / docs/plugins.md.

import type { BranchRegistry, EventStore } from "@loom/event-runtime";
import type { SnapshotStore } from "@loom/snapshot-runtime";

/**
 * The `custom` storage descriptor every store plugin's preset returns — structurally
 * identical to `@loom/app`'s `StorageConfig` `custom` arm, but declared here so plugins
 * don't depend on `@loom/app`.
 */
export interface CustomStorage {
  kind: "custom";
  eventStore: EventStore;
  snapshotStore: SnapshotStore;
  branchRegistry?: BranchRegistry;
}

/**
 * A storage preset: a pure `(options) => CustomStorage` passed to
 * `defineConfig({ storage })`. `Options` defaults to `void` for a no-arg preset.
 */
export type StoragePreset<Options = void> = (options: Options) => CustomStorage;

/**
 * Identity helper that pins a function to the {@link StoragePreset} contract — you get
 * inference on `options` and a clear type error if the returned shape drifts:
 *
 * ```ts
 * export const myStorage = defineStoragePreset((opts: { url: string }) => ({
 *   kind: "custom",
 *   eventStore: new MyEventStore(opts.url),
 *   snapshotStore: new MySnapshotStore(opts.url),
 * }));
 * ```
 */
export function defineStoragePreset<Options = void>(
  fn: StoragePreset<Options>
): StoragePreset<Options> {
  return fn;
}
