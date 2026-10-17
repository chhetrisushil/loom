import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Scores, failingMetrics } from "../gate";
import { DOCS } from "./corpus";
import {
  BACKENDS,
  type Backend,
  POSTGRES_SKIP_REASON,
  SEARCH_LIMIT,
  type Subject,
  openSubject,
  postgresBackend,
  scoreRetrieval,
} from "./measure";
import { PATHOLOGICAL_QUERY } from "./queries";
import { retrievalThresholds } from "./thresholds";

// ADR 0131 D3/D4: the same labelled corpus through EVERY MemoryStore backend, by `MemoryStore.search` and by
// `KnowledgeBase.retrieve`. The Postgres leg runs when LOOM_TEST_POSTGRES_URL is set (CI sets it; each package
// gets its own database, vitest.shared.ts); without it the leg is skipped WITH A PRINTED REASON, and the sweep
// at the bottom still insists that at least the two always-available backends ran.

const pg = postgresBackend();
if (pg === undefined) console.warn(`[evals] ${POSTGRES_SKIP_REASON}`);

const backends: readonly Backend[] = pg === undefined ? BACKENDS : [...BACKENDS, pg];
const ran = new Set<string>();

describe.each(backends.map((b) => [b.name, b] as const))(
  "retrieval eval on %s",
  (_name, backend) => {
    let subject: Subject;
    const real: Record<string, Scores> = {};
    const degraded: Record<string, Scores> = {};

    beforeAll(async () => {
      subject = await openSubject(backend);
      for (const route of ["memory", "knowledge"] as const) {
        real[route] = await scoreRetrieval(subject[route]);
        degraded[route] = await scoreRetrieval(subject.degraded[route]);
      }
      ran.add(backend.name);
    });
    afterAll(async () => {
      await subject?.close();
    });

    it.each(["memory", "knowledge"] as const)("the real %s route clears every floor", (route) => {
      expect(
        failingMetrics(real[route] as Scores, retrievalThresholds(backend.name, route))
      ).toEqual([]);
    });

    it.each(["memory", "knowledge"] as const)(
      "FAIL-PROOF: a degraded queryTerms (first term only) falls below the floors on the %s route, naming recall@5 and ndcg@10",
      (route) => {
        const failing = failingMetrics(
          degraded[route] as Scores,
          retrievalThresholds(backend.name, route)
        );
        expect(failing).toContain("recall@5");
        expect(failing).toContain("ndcg@10");
        expect((degraded[route] as Scores)["recall@5"]).toBeLessThan(
          (real[route] as Scores)["recall@5"] as number
        );
      }
    );

    it("a query repeating one word 20,000 times terminates and returns a bounded page (no timing assertion)", async () => {
      // Completing within the test timeout IS the proof (audit arc 3: this took SQLite 32.7 s before queryTerms).
      const hits = await subject.rawSearch(PATHOLOGICAL_QUERY);
      expect(hits).toBeGreaterThan(0);
      expect(hits).toBeLessThanOrEqual(SEARCH_LIMIT);
      const ids = await subject.memory(PATHOLOGICAL_QUERY);
      expect(ids.every((id) => DOCS.some((d) => d.id === id))).toBe(true);
    });
  }
);

describe("retrieval sweep", () => {
  it("ran at least the two always-available backends, so a skip cannot hide all of them", () => {
    expect(ran.has("memory")).toBe(true);
    expect(ran.has("sqlite")).toBe(true);
    expect(ran.size).toBeGreaterThanOrEqual(2);
    // The Postgres leg is accounted for either way: it ran, or its reason was printed above.
    expect(ran.has("postgres") || pg === undefined).toBe(true);
  });
});
