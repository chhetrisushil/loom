import type { ContentStoreLike } from "./index";

// ── ContentStore SPI 1.3.0/1.4.0 touch contract (ADR 0055 D5, D6 amendment 2) — internal to the kit ──

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
  if (store.touch !== undefined) await checkTouch(store, ref);
  await store.delete(ref);
}

/**
 * SPI 1.4.0 `touch`: bumps the touch time the conditional delete compares (no put involved),
 * and an unknown address is a reported no-op, never an insert.
 */
async function checkTouch(store: ContentStoreLike, ref: { __loomContent: string }): Promise<void> {
  await settle();
  const between = await store.touchClock!();
  await settle();
  const ghost = `sha256:${"0".repeat(63)}1`;
  const missing = await store.touch!([ref.__loomContent, ghost, ref.__loomContent]);
  if (missing.length !== 1 || missing[0] !== ghost) {
    throw new Error(
      `ContentStore SPI 1.4.0: touch must resolve with exactly the addresses the store does not hold (expected [${ghost}], got [${missing.join(", ")}])`
    );
  }
  if (await store.deleteIfUntouchedSince!(ref, between + 1)) {
    throw new Error(
      "ContentStore SPI 1.4.0: touch did not bump the touch time — deleteIfUntouchedSince erased a blob that was touched after the cutoff"
    );
  }
  if ((await store.get(ref)) === null) {
    throw new Error("ContentStore SPI 1.4.0: a refused deleteIfUntouchedSince erased the blob");
  }
  await store.touch!([]); // an empty batch is legal
  if ((await store.get({ __loomContent: ghost })) !== null) {
    throw new Error("ContentStore SPI 1.4.0: touch of an unknown address created a blob");
  }
}
