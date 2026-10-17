// Labelled queries for the retrieval eval, graded 0/1/2 (absent = 0):
//   2 = the document directly answers the question
//   1 = the document is related and partly useful
// Written from the asker's side and labelled by reading the documents in `corpus.ts` BEFORE any search
// was run. See PROVENANCE.md. Recall counts any graded document (grade >= 1) as relevant; nDCG uses the grades.

export interface RetrievalQuery {
  readonly id: string;
  readonly query: string;
  readonly grades: Readonly<Record<string, 1 | 2>>;
}

export const QUERIES: readonly RetrievalQuery[] = [
  { id: "r01", query: "how often should I water my plants", grades: { d16: 2, d17: 1 } },
  { id: "r02", query: "my leaves are turning yellow", grades: { d17: 2, d16: 1 } },
  { id: "r03", query: "what should I feed the starter", grades: { d01: 2 } },
  { id: "r04", query: "how long should the dough rise", grades: { d02: 2, d05: 1 } },
  { id: "r05", query: "why did my loaf come out flat", grades: { d05: 2, d02: 1 } },
  { id: "r06", query: "how to get a crispy crust", grades: { d03: 2 } },
  { id: "r07", query: "wetter dough bigger holes", grades: { d04: 2 } },
  { id: "r08", query: "how do I know the queen is laying well", grades: { d06: 2, d07: 1 } },
  { id: "r09", query: "when do I check the hive", grades: { d07: 2 } },
  { id: "r10", query: "the bees are leaving in a big group", grades: { d08: 2 } },
  { id: "r11", query: "feed bees for the winter", grades: { d09: 2 } },
  { id: "r12", query: "parasites on bees", grades: { d10: 2 } },
  { id: "r13", query: "how many miles per week should I build up", grades: { d11: 2 } },
  { id: "r14", query: "what to do before race day", grades: { d12: 2, d14: 1 } },
  { id: "r15", query: "do I really need a day off from running", grades: { d13: 2 } },
  { id: "r16", query: "eating and drinking on a long run", grades: { d14: 2 } },
  { id: "r17", query: "pain in the front of my lower leg", grades: { d15: 2 } },
  { id: "r18", query: "when to repot", grades: { d18: 2 } },
  { id: "r19", query: "bugs on my plant leaves and fine webs", grades: { d20: 2 } },
  { id: "r20", query: "how much should I save for emergencies", grades: { d22: 2, d21: 1 } },
  { id: "r21", query: "which debt to pay first", grades: { d23: 2, d21: 1 } },
  { id: "r22", query: "where is my money going each month", grades: { d24: 2 } },
  { id: "r23", query: "why start investing early", grades: { d25: 2 } },
  { id: "r24", query: "how much air in my tires", grades: { d26: 2, d28: 1 } },
  { id: "r25", query: "my bike chain is dirty and noisy", grades: { d27: 2 } },
  { id: "r26", query: "how to see Jupiter", grades: { d34: 2, d33: 1 } },
  { id: "r27", query: "see stars better at night", grades: { d31: 2, d32: 2, d33: 1 } },
  { id: "r28", query: "my compost smells bad", grades: { d37: 2, d36: 1 } },
  { id: "r29", query: "what can I put in the compost", grades: { d39: 2, d36: 1 } },
  { id: "r30", query: "how do I know compost is ready", grades: { d40: 2, d38: 1 } },
  { id: "r31", query: "winter stores", grades: { d09: 2 } },
  { id: "r32", query: "fix a flat", grades: { d28: 2, d26: 1 } },
  { id: "r33", query: "avoid bright lights when stargazing", grades: { d31: 2, d32: 1 } },
];

/**
 * The pathological query from the audit-arc-3 finding: one word repeated 20,000 times (about 160 KB).
 * Unbounded, it built a 20,000-clause MATCH and took SQLite 32.7 seconds. It is a TERMINATION case:
 * completing within the test timeout is the proof; there is deliberately no timing assertion.
 */
export const PATHOLOGICAL_QUERY = "sourdough ".repeat(20_000);
