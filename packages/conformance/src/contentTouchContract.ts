import type { ContentStoreLike } from "./index";

// ── ContentStore SPI 1.3.0 touch contract (ADR 0055 D5) — internal to the kit ──

const SPI_1_3_METHODS = ["deleteIfUntouchedSince", "listPage", "touchClock"] as const;

export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

/**
 * ContentStore SPI 1.3.0 (ADR 0055 D5): the race guard's contract, checked through the
 * conditional delete ALONE (no `listPage` read-back a store could get right while its delete
 * gets it wrong). Throws, naming the violation, when:
 *  - the store implements only part of `deleteIfUntouchedSince` / `listPage` / `touchClock`;
 *  - a put of bytes it already holds does not bump the touch time the delete compares, which
 *    is the `INSERT OR IGNORE` shape that loses a re-cited blob to a concurrent sweep.
 * Resolves for a store with none of the three (an SPI 1.2 store) and for a conforming one.
 * Internal to the kit: exported from THIS module only so the kit's own negative tests can
 * prove it fires. It is not part of `@loom/conformance`'s public surface (ADR 0083: no second
 * consumer).
 */
export async function checkContentStoreTouchContract(store: ContentStoreLike): Promise<void> {
  const present = SPI_1_3_METHODS.filter((m) => store[m] !== undefined);
  if (present.length === 0) return;
  if (present.length !== SPI_1_3_METHODS.length) {
    throw new Error(
      `ContentStore SPI 1.3.0: implement deleteIfUntouchedSince, listPage and touchClock together — this store has only ${present.join(", ")}`
    );
  }
  const bytes = new TextEncoder().encode(`touch-contract-${Math.random()}`);
  const ref = await store.put(bytes);
  await settle();
  const between = await store.touchClock!(); // after the first put, before the re-put
  await settle();
  await store.put(bytes); // the re-citation
  if (await store.deleteIfUntouchedSince!(ref, between + 1)) {
    throw new Error(
      "ContentStore SPI 1.3.0: a put of bytes the store already held did not bump the touch time — deleteIfUntouchedSince erased a blob re-cited after the cutoff (INSERT OR IGNORE instead of ON CONFLICT DO UPDATE?)"
    );
  }
  if ((await store.get(ref)) === null) {
    throw new Error("ContentStore SPI 1.3.0: a refused deleteIfUntouchedSince erased the blob");
  }
  await store.delete(ref);
}
