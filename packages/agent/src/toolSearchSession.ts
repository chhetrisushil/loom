import { tainted } from "@loom/classify";
import type { ToolDefinition } from "@loom/core";
import type { ExecutionContext } from "@loom/workflow-runtime";
import { z } from "zod";
import { toolSpecFor, validateToolInput } from "./toolSchema";
import { Bm25ToolRanker, type ToolRanker } from "./toolSearch";

// ── R22 (ADR 0125) — tool search: the loop half ─────────────────────────────────
//
// `ToolSearchSession` owns everything `agentLoop$` needs for the `search_tools` meta-tool except the
// loop's own plumbing: the allowed universe, what is loaded so far, the caps, and one recorded
// decision per search. It is deliberately ignorant of the transcript and of frames.

/** The `DECISION_RECORDED.source` of a search. `@loom/learning` treats it as a recorded fact. */
export const SOURCE_TOOL_SEARCH = "agent-tool-search";

export const DEFAULT_SEARCH_TOOL_NAME = "search_tools";
export const DEFAULT_MAX_PER_SEARCH = 5;
export const DEFAULT_MAX_LOADED = 20;
export const DEFAULT_MAX_SEARCHES = 25;
/** Hard ceilings: a host cannot configure its way into an unbounded menu or result. */
export const MAX_PER_SEARCH_CEILING = 50;
export const MAX_LOADED_CEILING = 200;
export const MAX_SEARCHES_CEILING = 200;
/** Characters of a description shown in a result (first line only). */
const MAX_RESULT_DESCRIPTION = 160;
/** Characters of the query recorded in the decision. */
const MAX_RECORDED_QUERY = 200;

/** Opt-in tool search for `agentLoop$`. Absent: the run is byte-identical to a run without this feature. */
export interface ToolSearchConfig {
  /**
   * The tools the HOST offers for search: the searchable set, and the ONLY set a search can load.
   * The agent's own `definition.tools` and the selected skills' tools are already on the menu from
   * turn 0 (user ruling, ADR 0125 D3), so they are not searched; offering a tool here is the
   * authorization. An id already on the menu is ignored here (the menu's definition wins).
   */
  catalog?: readonly ToolDefinition[];
  /** Catalog ids added to the menu up front, after `definition.tools` and the selected skills' tools. */
  alwaysLoaded?: readonly string[];
  /**
   * An allowlist of searchable id PREFIXES (`"mcp:github:"`). Only matching tools are found;
   * `alwaysLoaded` is the host's explicit choice and is exempt. Absent: every offered tool.
   */
  namespaces?: readonly string[];
  /**
   * HOST-supplied search vocabulary per tool id: `tags` and `aliases` ("bill the customer"). These
   * are trusted (the host wrote them) and apply to ANY tool, including a remote MCP / A2A one,
   * whose own manifest cannot be trusted to declare them. This is the recommended way to close the
   * vocabulary gap between how users phrase a need and how a tool is named, before a semantic
   * ranker. A tool author's own `tool$({ tags, aliases })` is honoured for first-party tools only.
   */
  annotations?: Readonly<Record<string, { tags?: readonly string[]; aliases?: readonly string[] }>>;
  /** Results per search (also the model's `limit` ceiling). Default 5, at most 50. */
  maxPerSearch?: number;
  /** Tools the model can add to the menu over the whole run. Default 20, at most 200. */
  maxLoaded?: number;
  /** Searches per run. Default 25, at most 200. */
  maxSearches?: number;
  /**
   * Cap on the combined JSON size of the loaded tools' model-facing specs (characters). A hit that
   * would exceed it is reported but not loaded. Absent: only `maxLoaded` bounds the menu.
   */
  maxMenuChars?: number;
  /** The meta-tool's name. Default `"search_tools"`; it must not collide with a searchable tool. */
  searchToolName?: string;
  /**
   * The ranking backend. Default: BM25F built over the searchable set (name > tags > description).
   * A prebuilt ranker may be shared across runs (build once for a large catalog); its results are
   * intersected with the allowed set, and RECORDED, so even a non-deterministic ranker (semantic,
   * R18) replays identically.
   */
  ranker?: ToolRanker;
}

const searchInput = z.object({
  query: z.string(),
  limit: z.number().int().min(1).optional(),
});

/** A hit as the model reads it. */
export interface ToolSearchHit {
  name: string;
  description: string;
  /** `false` when the hit was NOT added to the menu (menu full): it cannot be called. */
  loaded: boolean;
}

interface Recorded {
  ranker: string;
  query: string;
  results: string[];
  loaded: string[];
}

export class ToolSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolSearchError";
    Object.setPrototypeOf(this, ToolSearchError.prototype);
  }
}

const isThirdParty = (t: ToolDefinition): boolean => t.jsonInputSchema !== undefined;
/** A description reaches the index/the model only if it is first-party or the operator vouched for it. */
const vouched = (t: ToolDefinition): boolean => !isThirdParty(t) || t.trustJsonSchemaText === true;
const firstLine = (s: string): string => {
  const line = s.split("\n", 1)[0] as string;
  return line.length > MAX_RESULT_DESCRIPTION ? `${line.slice(0, MAX_RESULT_DESCRIPTION)}…` : line;
};

function positiveInt(name: string, v: number | undefined, def: number, ceiling: number): number {
  const n = v ?? def;
  if (!Number.isSafeInteger(n) || n < 1 || n > ceiling) {
    throw new ToolSearchError(
      `toolSearch.${name} must be an integer in [1, ${ceiling}] (got ${String(v)})`
    );
  }
  return n;
}

export class ToolSearchSession {
  readonly name: string;
  /** The meta-tool's definition, as the model is offered it. */
  readonly definition: ToolDefinition;
  private readonly byId = new Map<string, ToolDefinition>();
  private readonly searchable = new Set<string>();
  private readonly loadedIds = new Set<string>();
  private readonly ranker: ToolRanker;
  private readonly maxPerSearch: number;
  private readonly maxLoaded: number;
  private readonly maxSearches: number;
  private readonly maxMenuChars: number | undefined;
  private searches = 0;
  private searchLoaded = 0;
  private menuChars = 0;
  /** Tools in menu order after the meta-tool: `alwaysLoaded`, then search order. Append-only. */
  readonly initial: ToolDefinition[] = [];

  constructor(
    cfg: ToolSearchConfig,
    /** Tools already on the menu (definition.tools + selected skills' tools), in menu order. */
    preloaded: readonly ToolDefinition[]
  ) {
    this.name = cfg.searchToolName ?? DEFAULT_SEARCH_TOOL_NAME;
    this.maxPerSearch = positiveInt(
      "maxPerSearch",
      cfg.maxPerSearch,
      DEFAULT_MAX_PER_SEARCH,
      MAX_PER_SEARCH_CEILING
    );
    this.maxLoaded = positiveInt(
      "maxLoaded",
      cfg.maxLoaded,
      DEFAULT_MAX_LOADED,
      MAX_LOADED_CEILING
    );
    this.maxSearches = positiveInt(
      "maxSearches",
      cfg.maxSearches,
      DEFAULT_MAX_SEARCHES,
      MAX_SEARCHES_CEILING
    );
    if (
      cfg.maxMenuChars !== undefined &&
      (!Number.isSafeInteger(cfg.maxMenuChars) || cfg.maxMenuChars < 1)
    ) {
      throw new ToolSearchError("toolSearch.maxMenuChars must be a positive integer");
    }
    this.maxMenuChars = cfg.maxMenuChars;
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(this.name)) {
      throw new ToolSearchError("toolSearch.searchToolName must match [A-Za-z0-9_.:-]{1,64}");
    }
    for (const t of preloaded) this.loadedIds.add(t.id);
    for (const t of cfg.catalog ?? []) {
      if (!this.loadedIds.has(t.id) && !this.byId.has(t.id)) this.byId.set(t.id, t);
    }
    if (this.byId.has(this.name) || this.loadedIds.has(this.name)) {
      throw new ToolSearchError(
        `toolSearch.searchToolName "${this.name}" collides with a searchable tool`
      );
    }
    const prefixes = cfg.namespaces;
    for (const t of this.byId.values()) {
      if (prefixes === undefined || prefixes.some((p) => t.id.startsWith(p)))
        this.searchable.add(t.id);
    }
    for (const id of cfg.alwaysLoaded ?? []) {
      const t = this.byId.get(id);
      if (t === undefined) {
        throw new ToolSearchError(
          `toolSearch.alwaysLoaded names "${id}", which is not a \`catalog\` tool`
        );
      }
      if (!this.loadedIds.has(id)) {
        this.loadedIds.add(id);
        this.initial.push(t);
      }
    }
    this.ranker =
      cfg.ranker ??
      new Bm25ToolRanker(
        [...this.searchable].map((id) => {
          const t = this.byId.get(id) as ToolDefinition;
          const host = cfg.annotations?.[id];
          // Trusted vocabulary: the host's annotations and the tool author's own — the
          // last ONLY for a first-party tool. A remote tool's self-declared tags/aliases are the
          // server's claims: they count as description-level text, and only if the operator vouched
          // for that text (`trustJsonSchemaText`).
          const own = isThirdParty(t) ? undefined : t;
          const remote =
            isThirdParty(t) && vouched(t) ? [...(t.tags ?? []), ...(t.aliases ?? [])] : [];
          return {
            id,
            // An un-vouched third-party description is not ranked on: it is attacker text.
            ...(vouched(t) && { description: [t.description, ...remote].join(" ") }),
            tags: [...(host?.tags ?? []), ...(own?.tags ?? [])],
            aliases: [...(host?.aliases ?? []), ...(own?.aliases ?? [])],
          };
        })
      );
    this.definition = {
      _tag: "ToolDefinition",
      id: this.name,
      name: this.name,
      description:
        "Search the available tools by what you need to do and add the best matches to your tool list. " +
        "Call it with a short natural-language `query`; the tools it returns can be called from the next step on.",
      kind: "tool",
      inputSchema: searchInput.describe("search_tools input"),
      outputSchema: z.unknown(),
    } as unknown as ToolDefinition;
  }

  get metaSpec(): ReturnType<typeof toolSpecFor> {
    return toolSpecFor(this.definition);
  }

  isSearchCall(toolName: string): boolean {
    return toolName === this.name;
  }

  /** Whether `id` is a tool the model may currently call (loaded). */
  isLoaded(id: string): boolean {
    return this.loadedIds.has(id);
  }

  /** Tools put on the menu by something else (a skill activation): search never offers them again. */
  noteLoaded(tools: readonly ToolDefinition[]): void {
    for (const t of tools) this.loadedIds.add(t.id);
  }

  /** Tools the host marked always-on contribute to the menu budget. */
  private specChars(t: ToolDefinition): number {
    return JSON.stringify(toolSpecFor(t)).length;
  }

  /**
   * Run one `search_tools` call. Returns the tool_result `output`, whether it is an error, and the
   * tools newly added to the menu (the caller appends them, in this order).
   */
  async run(
    ctx: Pick<ExecutionContext, "decide">,
    decisionKey: string,
    input: unknown
  ): Promise<{ output: unknown; isError: boolean; newlyLoaded: ToolDefinition[] }> {
    const v = validateToolInput(searchInput, input);
    if (!v.ok) {
      return {
        output: {
          error: {
            code: "invalid_tool_input",
            message: `Input for tool "${this.name}" must be { query: string, limit?: positive integer }.`,
          },
        },
        isError: true,
        newlyLoaded: [],
      };
    }
    if (this.searches >= this.maxSearches) {
      return {
        output: {
          error: {
            code: "search_limit_reached",
            message: `At most ${this.maxSearches} searches per run.`,
          },
        },
        isError: true,
        newlyLoaded: [],
      };
    }
    this.searches++;
    const { query, limit } = input as z.infer<typeof searchInput>;
    const want = Math.min(limit ?? this.maxPerSearch, this.maxPerSearch);

    const recorded = await ctx.decide<Recorded>(
      decisionKey,
      async () => {
        // Over-ask by what is already loaded so loaded hits can be dropped without starving the page.
        const ranked = await this.ranker.rank(query, want + this.loadedIds.size);
        const results = this.admit(
          ranked.map((h) => h.id),
          want
        );
        return {
          ranker: this.ranker.kind,
          query: query.slice(0, MAX_RECORDED_QUERY),
          results,
          loaded: this.plan(results),
        };
      },
      { source: SOURCE_TOOL_SEARCH }
    );

    // Live and replayed alike: the record is re-intersected with what THIS run may use, so a stale or
    // tampered record can narrow the menu and can never widen it (or exceed the caps).
    const results = this.admit(recorded.results, want);
    const planned = new Set(this.plan(results));
    const toLoad = recorded.loaded.filter((id) => planned.has(id));
    const newlyLoaded: ToolDefinition[] = [];
    for (const id of toLoad) {
      const t = this.byId.get(id) as ToolDefinition;
      this.loadedIds.add(id);
      this.searchLoaded++;
      this.menuChars += this.specChars(t);
      newlyLoaded.push(t);
    }
    const loadedNow = new Set(toLoad);
    const hits: ToolSearchHit[] = results.map((id) => {
      const t = this.byId.get(id) as ToolDefinition;
      return {
        name: id,
        description: firstLine(toolSpecFor(t).description),
        loaded: loadedNow.has(id),
      };
    });
    const output: Record<string, unknown> = { tools: hits };
    if (hits.some((h) => !h.loaded)) {
      output.note = "The tool list is full: matches with loaded=false cannot be called.";
    }
    if (hits.length === 0) output.note = "No matching tools.";
    // Any third-party tool in the result puts attacker-influenced bytes (its name, its vouched text)
    // in front of the model: fence the whole result as data (ADR 0085), same as an MCP tool's own output.
    const third = results.find((id) => isThirdParty(this.byId.get(id) as ToolDefinition));
    return {
      output: third === undefined ? output : tainted(output, `tool-search:${third}`),
      isError: false,
      newlyLoaded,
    };
  }

  /** Candidate ids -> the ones this run may be shown: offered, searchable, not loaded, deduped, <= `want`. */
  private admit(ids: readonly string[], want: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (typeof id !== "string" || seen.has(id)) continue;
      seen.add(id);
      if (!this.searchable.has(id) || this.loadedIds.has(id)) continue;
      out.push(id);
      if (out.length >= want) break;
    }
    return out;
  }

  /** Which of `results` fit in the menu (count and size caps), in order, stopping at the first that does not. */
  private plan(results: readonly string[]): string[] {
    const out: string[] = [];
    let count = this.searchLoaded;
    let chars = this.menuChars;
    for (const id of results) {
      if (count >= this.maxLoaded) break;
      if (this.maxMenuChars !== undefined) {
        const c = this.specChars(this.byId.get(id) as ToolDefinition);
        if (chars + c > this.maxMenuChars) break;
        chars += c;
      }
      count++;
      out.push(id);
    }
    return out;
  }
}
