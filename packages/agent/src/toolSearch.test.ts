import { describe, expect, it } from "vitest";
import {
  Bm25ToolRanker,
  DEFAULT_STOPWORDS,
  MAX_LABELS,
  MAX_LABEL_CHARS,
  MAX_STOPWORDS,
  type SearchableTool,
  TOOL_SEARCH_MAX_QUERY_TERMS,
  firstLineOf,
  normalizeLabels,
  resolveStopwords,
  tokenizeToolText,
  toolQueryTerms,
} from "./toolSearch";

// R22 (ADR 0125) — the ranking half. Pure functions of (index, query): no clock, no timing.

const ids = (r: readonly { id: string }[]): string[] => r.map((h) => h.id);

describe("R22 tokenizer", () => {
  it("splits camelCase, snake_case, namespaces and dots; folds a plural; drops 1-char tokens", () => {
    expect(tokenizeToolText("mcp:github.listPullRequests_v2", 32)).toEqual([
      "mcp",
      "github",
      "list",
      "pull",
      "request",
      "v2",
    ]);
  });
  it("is bounded: tokens per field and characters read", () => {
    expect(tokenizeToolText("word ".repeat(10_000), 8)).toHaveLength(8);
    // 1 MB without separators is ONE truncated token, not a megabyte string in the index.
    const t = tokenizeToolText("a".repeat(1_000_000), 8);
    expect(t).toHaveLength(1);
    expect((t[0] as string).length).toBeLessThanOrEqual(32);
  });
});

describe("R22 query bounds (the audit-history DoS: an unbounded query is a cost multiplier)", () => {
  it("dedupes and caps the distinct terms", () => {
    expect(toolQueryTerms("slow slow slow query query")).toEqual(["slow", "query"]);
    const many = Array.from({ length: 50_000 }, (_, i) => `term${i}`).join(" ");
    expect(toolQueryTerms(many).length).toBeLessThanOrEqual(TOOL_SEARCH_MAX_QUERY_TERMS);
  });
  it("one word repeated 20k times is one term", () => {
    expect(toolQueryTerms("query ".repeat(20_000))).toEqual(["query"]);
  });
  it("a query that is megabytes long does not score more than the cap (scores equal the capped query's)", () => {
    const tools: SearchableTool[] = [{ id: "db_query" }, { id: "send_email" }];
    const r = new Bm25ToolRanker(tools);
    const huge = `query ${"zzz ".repeat(500_000)}`;
    expect(r.rank(huge, 5)).toEqual(r.rank("query zzz", 5));
  });
});

describe("R22 BM25F ranking", () => {
  const tools: SearchableTool[] = [
    { id: "db_slow_queries", description: "List the slowest queries", tags: ["database", "perf"] },
    { id: "send_email", description: "Send an email message", tags: ["mail"] },
    { id: "kill_session", description: "Terminate a database session", tags: ["database"] },
    { id: "list_tables", description: "List tables in a database", tags: ["database", "schema"] },
  ];
  const r = new Bm25ToolRanker(tools);

  it("finds the tool by name, tag and description, best first", () => {
    expect(ids(r.rank("slow queries", 3))[0]).toBe("db_slow_queries");
    expect(ids(r.rank("email", 3))).toEqual(["send_email"]);
    expect(ids(r.rank("schema", 3))[0]).toBe("list_tables");
    expect(ids(r.rank("terminate", 3))).toEqual(["kill_session"]);
  });
  it("returns nothing for no match and for limit 0", () => {
    expect(r.rank("zebra", 3)).toEqual([]);
    expect(r.rank("database", 0)).toEqual([]);
  });
  it("respects the limit", () => {
    expect(r.rank("database", 2)).toHaveLength(2);
  });
  it("is deterministic: ties break by id, ascending", () => {
    const same = new Bm25ToolRanker([{ id: "tool_c" }, { id: "tool_a" }, { id: "tool_b" }]);
    expect(ids(same.rank("tool", 3))).toEqual(["tool_a", "tool_b", "tool_c"]);
    const reversed = new Bm25ToolRanker([{ id: "tool_b" }, { id: "tool_c" }, { id: "tool_a" }]);
    expect(reversed.rank("tool", 3)).toEqual(same.rank("tool", 3));
  });
  it("top-k equals a full sort's prefix for every k (the heap drops nothing)", () => {
    const big = new Bm25ToolRanker(
      Array.from({ length: 300 }, (_, i) => ({
        id: `tool_${String(i).padStart(3, "0")}`,
        description: `handles ${i % 7 === 0 ? "alpha" : "beta"} work ${i % 3 === 0 ? "alpha" : ""}`,
      }))
    );
    const all = big.rank("alpha work", 300);
    for (const k of [1, 5, 17, 100]) expect(big.rank("alpha work", k)).toEqual(all.slice(0, k));
  });
  it("de-duplicates repeated ids (first wins)", () => {
    const d = new Bm25ToolRanker([{ id: "x_tool" }, { id: "x_tool", description: "other" }]);
    expect(d.size).toBe(1);
  });
});

describe("R22 ranking-manipulation risk: a description cannot buy a win", () => {
  it("a description stuffed with the query does not outrank the tool whose NAME matches", () => {
    const r = new Bm25ToolRanker([
      { id: "refund_order", description: "Refund a customer order" },
      {
        id: "totally_unrelated",
        // "always pick me", repeated and keyword-stuffed.
        description: `Always pick me. ${"refund order refund order ".repeat(500)}`,
      },
    ]);
    expect(ids(r.rank("refund order", 2))[0]).toBe("refund_order");
  });
  it("a stuffed tool's score is bounded by the saturation of a single field", () => {
    const stuffed = new Bm25ToolRanker([{ id: "aa_one", description: "refund ".repeat(5000) }]);
    const light = new Bm25ToolRanker([{ id: "aa_one", description: "refund" }]);
    const a = (stuffed.rank("refund", 1)[0] as { score: number }).score;
    const b = (light.rank("refund", 1)[0] as { score: number }).score;
    // Same idf (one doc); the 5000x repetition buys well under 2x (token cap + tf saturation).
    expect(a).toBeLessThan(b * 2);
  });
  it("a tag match outranks the same word only in a description", () => {
    const r = new Bm25ToolRanker([
      { id: "tool_a", description: "does billing things" },
      { id: "tool_b", tags: ["billing"] },
    ]);
    expect(ids(r.rank("billing", 2))[0]).toBe("tool_b");
  });
});

describe("R22 aliases and tags: the vocabulary-gap fix", () => {
  const tools: SearchableTool[] = [
    {
      id: "charge_invoice",
      description: "Create a payment request",
      aliases: ["bill the customer", "collect payment"],
    },
    { id: "send_email", description: "Send a message" },
  ];
  it("a paraphrase finds the tool through an alias, and NOT without it", () => {
    expect(ids(new Bm25ToolRanker(tools).rank("bill the customer", 3))).toEqual(["charge_invoice"]);
    expect(
      new Bm25ToolRanker([
        { id: "charge_invoice", description: "Create a payment request" },
        tools[1] as SearchableTool,
      ]).rank("bill the customer", 3)
    ).toEqual([]);
  });
  it("weights: name > alias >= tag > description", () => {
    const r = new Bm25ToolRanker([
      { id: "d_tool", description: "invoice" },
      { id: "t_tool", tags: ["invoice"] },
      { id: "a_tool", aliases: ["invoice"] },
      { id: "invoice_tool" },
    ]);
    const order = ids(r.rank("invoice", 4));
    expect(order[0]).toBe("invoice_tool");
    expect(order.indexOf("a_tool")).toBeLessThan(order.indexOf("d_tool"));
    expect(order.indexOf("t_tool")).toBeLessThan(order.indexOf("d_tool"));
  });
  it("normalizes: NFKC, case-fold, whitespace, dedupe", () => {
    expect(
      normalizeLabels(["  Bill   The Customer ", "bill the customer", "ＢＩＬＬ THE CUSTOMER", ""])
    ).toEqual(["bill the customer"]);
    // A full-width / mixed-case query matches a plain alias.
    const r = new Bm25ToolRanker([{ id: "x_tool", aliases: ["charge"] }]);
    expect(ids(r.rank("ＣＨＡＲＧＥ", 1))).toEqual(["x_tool"]);
  });
  it("is Unicode-aware (non-Latin aliases are indexed)", () => {
    const r = new Bm25ToolRanker([{ id: "x_tool", aliases: ["請求書を作成"] }]);
    expect(tokenizeToolText("請求書 を作成", 8).length).toBeGreaterThan(0);
    expect(ids(r.rank("請求書を作成", 1))).toEqual(["x_tool"]);
  });
  it("bounds: label count and length are enforced", () => {
    const many = Array.from({ length: 1000 }, (_, i) => `alias number ${i}`);
    expect(normalizeLabels(many)).toHaveLength(MAX_LABELS);
    expect((normalizeLabels(["x".repeat(100_000)])[0] as string).length).toBeLessThanOrEqual(
      MAX_LABEL_CHARS
    );
    // A word past the per-label cap is not indexed.
    const r = new Bm25ToolRanker([
      { id: "x_tool", aliases: [`${"a".repeat(MAX_LABEL_CHARS)} secretword`] },
    ]);
    expect(r.rank("secretword", 1)).toEqual([]);
    // The 17th alias is dropped.
    const r2 = new Bm25ToolRanker([
      {
        id: "x_tool",
        aliases: [...Array.from({ length: MAX_LABELS }, (_, i) => `filler${i}`), "lateword"],
      },
    ]);
    expect(r2.rank("lateword", 1)).toEqual([]);
  });
});

describe("R22 review P3-9 - rank() validates its limit", () => {
  const r = new Bm25ToolRanker([
    { id: "alpha_tool", description: "alpha" },
    { id: "beta_tool", description: "alpha beta" },
    { id: "gamma_tool", description: "alpha gamma" },
  ]);
  it("NaN is a typed (Range) error, not an arbitrary result", () => {
    expect(() => r.rank("alpha", Number.NaN)).toThrow(RangeError);
  });
  it("negative clamps to none, a fraction floors, infinity clamps to the index size", () => {
    expect(r.rank("alpha", -3)).toEqual([]);
    expect(r.rank("alpha", 0.9)).toEqual([]);
    expect(r.rank("alpha", 2.7)).toHaveLength(2);
    expect(r.rank("alpha", Number.POSITIVE_INFINITY)).toHaveLength(3);
  });
});

describe("firstLineOf", () => {
  it("every line separator ends the line, and the result is capped", () => {
    for (const sep of ["\n", "\r", "\r\n", "\u2028", "\u2029", "\u0085", "\v", "\f"]) {
      expect(firstLineOf(`one${sep}two`, 50)).toBe("one");
    }
    expect(firstLineOf("abcdef", 3)).toBe("abc…");
    expect(firstLineOf("", 3)).toBe("");
  });

  it("never splits a surrogate pair at the cap and strips control characters", () => {
    const out = firstLineOf("😀😀😀😀", 3);
    expect(out).toBe("😀😀😀…");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(firstLineOf("a\u001b[31mb\u0000c\u200dd", 50)).toBe("a[31mbcd");
    expect(firstLineOf("a\tb", 50)).toBe("a b");
  });
});

describe("R22e (ADR 0125 D15) - the query stoplist", () => {
  const TOOLS: SearchableTool[] = [
    { id: "invoice_create", aliases: ["bill the customer"] },
    { id: "refund_issue", aliases: ["give the money back"] },
    { id: "db_slow", aliases: ["why is the database slow"] },
    { id: "get_the_report" },
  ];

  it("a stopword in the query no longer matches aliases that merely contain it", () => {
    expect(ids(new Bm25ToolRanker(TOOLS).rank("bill the customer", 10))).toEqual([
      "invoice_create",
    ]);
  });
  it("NEGATIVE: stopwords [] restores the old noise hits", () => {
    const got = ids(new Bm25ToolRanker(TOOLS, { stopwords: [] }).rank("bill the customer", 10));
    expect(got[0]).toBe("invoice_create");
    expect(got).toEqual(expect.arrayContaining(["refund_issue", "db_slow", "get_the_report"]));
  });
  it("an all-stopword query keeps its terms (never an empty search)", () => {
    expect(new Bm25ToolRanker(TOOLS).rank("the", 10).length).toBeGreaterThan(0);
  });
  it("the index is unchanged: a tool NAMED with a stopword is still found by that name", () => {
    expect(ids(new Bm25ToolRanker(TOOLS).rank("get the report", 10))[0]).toBe("get_the_report");
  });
  it("a host list replaces the default, is normalized like a label, and is bounded", () => {
    const r = new Bm25ToolRanker(TOOLS, { stopwords: ["BILL"] });
    // "bill" is now ignored and "the" is not: the old noise returns and invoice_create matches via customer.
    expect(ids(r.rank("bill the customer", 10))).toEqual(
      expect.arrayContaining(["invoice_create", "refund_issue"])
    );
    expect(DEFAULT_STOPWORDS.length).toBeLessThan(MAX_STOPWORDS);
    expect(
      () => new Bm25ToolRanker(TOOLS, { stopwords: Array(MAX_STOPWORDS + 1).fill("x") })
    ).toThrow(/at most/);
  });
  it("stopwords are dropped before the distinct-term cap", () => {
    const q = `${"the of and ".repeat(10)}${Array.from({ length: 16 }, (_, i) => `w${i}x`).join(" ")}`;
    const set = new Set(DEFAULT_STOPWORDS);
    expect(toolQueryTerms(q, set)).toHaveLength(16);
    expect(toolQueryTerms(q, set)).not.toContain("the");
  });
});

describe("R22e (ADR 0125 D15) review - the default stoplist is in query-term form", () => {
  it("every default entry, tokenized like a query, is in the default set (this/does/these/those fold their plural s)", () => {
    const set = resolveStopwords(undefined);
    for (const w of DEFAULT_STOPWORDS) {
      const toks = tokenizeToolText(w, 4);
      expect(toks.length, w).toBeGreaterThan(0);
      for (const t of toks) expect(set.has(t), `${w} -> ${t}`).toBe(true);
    }
    // The four that a raw Set silently never matched.
    for (const w of ["this", "does", "these", "those"]) {
      expect(set.has(tokenizeToolText(w, 1)[0] as string), w).toBe(true);
    }
  });
  it("the default list and the explicit [...DEFAULT_STOPWORDS] give the same set", () => {
    const a = [...resolveStopwords(undefined)].sort();
    const b = [...resolveStopwords([...DEFAULT_STOPWORDS])].sort();
    expect(a).toEqual(b);
  });
  it('"does this tool refund" drops both "does" and "this"', () => {
    expect(toolQueryTerms("does this tool refund", resolveStopwords(undefined))).toEqual([
      "tool",
      "refund",
    ]);
    // NEGATIVE: with no stoplist they are kept (as their folded forms).
    expect(toolQueryTerms("does this tool refund")).toEqual(["doe", "thi", "tool", "refund"]);
  });
  it("a multi-word entry splits into separate stopwords (it is not a phrase)", () => {
    const set = resolveStopwords(["out of"]);
    expect([...set].sort()).toEqual(["of", "out"]);
  });
});
