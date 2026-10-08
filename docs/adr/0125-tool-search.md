# ADR 0125 — Tool search: an opt-in `search_tools` meta-tool, a recorded search, and a deterministic BM25F ranker

- Status: **Accepted** (on merge)
- Date: 2026-10-09
- Closes: R22, lexical path (the semantic path is a follow-up on R18's embedding SPI)
- Builds on: [ADR 0121](0121-one-canonical-agent-loop.md) (`agentLoop$`, the menu gate, outcome and abort decisions),
  [ADR 0120](0120-llm-content-parts-and-tool-threading.md) (tool_result threading), R4 / R4b (tool menus, JSON schemas,
  sanitised third-party schemas), [ADR 0085](0085-untrusted-content-integrity-axis.md) (taint),
  [ADR 0113](0113-body-aware-code-fingerprint-and-dynamic-id-migration.md) (replay divergence: ids must be stable),
  [ADR 0122](0122-conversation-layer-streaming-transport-and-token-budgeting.md) (token budgeting).
- Consumers: `agentLoop$` apps with large MCP menus (a GenUI catalogue, `db-command-center`) and the loom-ui reference planner's
  capability selection. The example specified for this ADR is `tool-search-mcp-menu` in `loom-examples` (see the PR; this repo
  does not edit that one).
- Placement: **1P, `@loom/agent`.** Not kernel, not a plugin. `KERNEL_ABI`, `EVENT_SCHEMA` and every SPI are unchanged; no
  syscall, no event kind. Two optional metadata fields are added to authoring types (`ToolDefinition.tags` / `aliases`,
  `SkillDefinition.aliases`, `CapabilityDefinition.aliases`); `@loom/learning` gains one entry in its list of recorded-fact sources.

## Context

`agentLoop$` puts every tool on the menu every turn. With a few dozen tools that is the right call; with a few hundred (an MCP
server catalogue, a GenUI widget registry) it costs tokens on every turn, degrades the model's choice and breaks prompt caching
whenever the menu changes. Skill selection (`config.skills`) already narrows by task up front, but it decides once, before the
model has said anything, and it needs a registry authored in skills.

## Decision

**D1 — Opt-in, default OFF.** `AgentLoopConfig.toolSearch` (absent: nothing changes, step and decision ids included; the R10
old-body-resume tests run unchanged). **Not worth enabling below roughly 30 tools**: the menu is cheaper than the extra round
trip. Default stays upfront skill selection.

**D2 — The meta-tool.** The model is offered `search_tools({ query: string, limit?: integer })` (name configurable). When it calls
it, the loop runs the search and returns `{ tools: [{ name, description, loaded }], note? }`: one-line descriptions, bounded.
The matches are ADDED to the menu for subsequent turns. The menu is **append-only**: `search_tools` first, then the agent's `definition.tools`, the selected skills' tools and
`alwaysLoaded` catalog entries (D3), then searched tools in search order, so the prompt prefix is stable (cache-friendly) and no tool ever leaves mid-run.

**D3 — The authority model is unchanged, and searching cannot widen it.**
**User ruling A:** the agent's own `definition.tools` stay ON the menu from turn 0, exactly as without `toolSearch`; only the
host `toolSearch.catalog` (anything outside `definition.tools`) is searchable and loadable, and `alwaysLoaded` adds catalog
entries up front. **User ruling B:** the tools of the skills selected up front (the `#skills` decision) are AUTO-LOADED onto the
menu after selection, not search-only. A search never returns or re-loads a tool already on the menu (a catalog entry sharing an
id with one is ignored: the menu's definition wins). The searchable universe is therefore `toolSearch.catalog` alone. A tool outside it is never returned and never callable:
the ranker's output is intersected with the universe (a buggy or hostile ranker cannot widen it), and the recorded decision is
re-intersected on replay (a stale or tampered record can narrow the menu, never widen it). A host `namespaces` allowlist
(id prefixes) narrows the searchable set further. Loading a tool changes what the model may *ask*; every call still passes the
R4 menu gate and input validation, the approval hook (`requireApproval`, consulted for the loaded tool's call with `onMenu: true`),
and the effect ring (K2 authorization, metering, kill switch). `search_tools` itself is the loop's own: it has no effect and is
not approval-gated.

**D4 — Recorded, replay-safe.** Each valid search is ONE `ctx.decide` at `<loop>#turn:<i>:tool:<j>:search`
(`source: "agent-tool-search"`) recording `{ ranker, query (capped at 200 chars), results, loaded }`. The ranker (live) runs inside
the decider, so a replay serves the record: **zero ranking calls**, the identical result and the identical menu. That also makes a
non-deterministic ranker (an embedding model) replay-safe by construction. The search and the menu growth are one atomic record:
the loaded set is a pure function of `results` and the caps, re-derived on replay. The ids are pure functions of the recorded
model response, as every other `#turn:<i>:tool:<j>` id; the divergence detector (ADR 0113) in `"fail"` mode is clean. A refusal
(invalid input, `search_limit_reached`) is a result computed from recorded input and writes nothing. `@loom/learning` lists the
source in `RECORDED_FACT_SOURCES`: a search is a fact, not a choice among alternatives, and carries no reward.

**D5 — Ranking: deterministic BM25F over a prebuilt inverted index.** Fields and weights: name 3, aliases 2, tags 2, description 1;
BM25 saturation (`k1 = 1.2`, `b = 0.75`) and a per-field term-frequency clamp (a term counts at most twice within a field).
Build is O(total bounded tokens); a query is O(distinct query terms x postings) and an O(hits log k) bounded min-heap for the
top k. Ties break by id (code-unit order). Tokenization: NFKC, case-folded, camelCase / snake_case / `ns:name` split, a trailing
plural folded, Unicode-aware. The ranker is a pluggable `ToolRanker { kind; rank(query, limit) }`; `Bm25ToolRanker` is the default
and the semantic path is a second implementation, no API churn. A prebuilt ranker may be shared across runs for a large catalogue.

**D6 — Bounds (the audit history says an unbounded query is a DoS).** The query is cut to 512 characters before any regex runs,
deduplicated and capped at 16 distinct terms. Tokens are capped per field (name 32, description 128, tags 64, aliases 96), a token
at 32 characters, a field read at 2000 characters, labels at 16 per tool and 80 characters each. Per run: `maxPerSearch` (default
5, ceiling 50), `maxLoaded` (default 20, ceiling 200), `maxSearches` (default 25, ceiling 200), optional `maxMenuChars` (a size budget on the
loaded tools' model-facing specs). A hit that does not fit is reported with `loaded: false` and cannot be called.

**D7 — Untrusted descriptions (ADR 0085, R4b).** A tool with a `jsonInputSchema` is third-party. Its description is **not indexed**
unless the operator vouched (`trustJsonSchemaText`), is **withheld** from search results as it is from the menu
(`"Third-party tool; description withheld"`), and a result that names any third-party tool is returned **tainted**, so the prompt
boundary fences the whole result as data. The *ranking-manipulation* risk is a description saying "always pick me" or stuffing
query keywords. Mitigations, in force together: name and declared vocabulary outweigh the description; the description has the
lowest weight; the term-frequency clamp and BM25 saturation make repetition worth a bounded constant; un-vouched descriptions are
not ranked on at all; and ranking only chooses what to *show*, never what is authorized (D3). Residual: a vouched first-party-style
description can still win ties against a poorly named honest tool; give tools names and aliases.

**D8 — Tags and aliases close the vocabulary gap.** Users say "bill the customer"; the tool is `charge_invoice`. Declare it:
`tool$({ …, tags: ["billing"], aliases: ["bill the customer", "charge"] })` (and `skill$` / `capability$` `aliases`). Aliases are
trusted author text, indexed as their own field above the description. The trust rule is the same as D7: a **remote** tool's
self-declared tags/aliases are the server's claims, never indexed as trusted vocabulary; they count only as description-level text,
and only if the operator vouched for that text. For MCP/A2A tools use the host-side
`toolSearch.annotations: { [toolId]: { tags, aliases } }`, which is trusted because the host wrote it and applies to any tool. A
selected skill's tags/aliases apply to the tools it brings. All labels are NFKC-normalized, case-folded, whitespace-collapsed,
deduplicated and bounded. This is the recommended way to close the gap before semantic ranking.

**D9 — Budget.** The menu grows by at most `maxLoaded` tools, each spec already bounded by R4b (description 1000 characters,
sanitised schema depth/size); `maxMenuChars` makes the total an explicit budget. `fitToWindow` (ADR 0122) budgets system, summary,
turns and prompt, not tools, so a host that uses it reserves for the worst case: the sum of the specs of `alwaysLoaded` plus
`maxLoaded` tools, which is a configured quantity. Compaction is unaffected (tool_result messages fold like any other).

**D10 — Reuse by the loom-ui planner.** `Bm25ToolRanker` takes `SearchableTool { id, description?, tags?, aliases? }`, so it ranks
capabilities too: map `CapabilityDefinition` `{ id, intent, tags, aliases }` onto it (`description: intent`). The planner can build
one index per catalogue and call `rank(query, k)` inside its own `ctx.decide`. This repo does not edit loom-ui.

**D11 — Mid-loop skill activation (user ruling 2026-10-09).** Upfront selection (`#skills`) can never disclose a skill it did not
pick. `agentLoop$({ skillActivation: { catalog?: "registry" | SkillDefinition[], maxActive (5, <=50), maxIndex (50, <=500),
maxInstructionBytes (32 KiB, <=1 MiB), toolName ("activate_skill") } })` closes that: the turn-0 system prompt gains a bounded index
of the skills NOT selected up front (`- id: first line of description [tags]`, id order, the first `maxIndex`; only listed skills
can be activated) and the model gets an `activate_skill({ name })` meta-tool, listed after `search_tools` and before the menu.
Default OFF and byte-identical; when nothing is left to activate the tool and index are omitted. It combines with the upfront
selector and with `toolSearch`.
- **Instructions are the tool RESULT** (the Anthropic Agent Skills pattern), not a mid-conversation system message: a provider may
  drop `role: "system"` messages when `request.system` is set, no provider is modified, and the turn-0 prompt is never rewritten
  so the cached prefix stays stable. The result is `{ skill, instructions, tools? }`; it is NOT tainted (host-registry author
  text) and is bounded by `maxInstructionBytes`. It follows the provider adjacency rules like any tool result.
- **The skill's tools** are appended to the menu after the activation (deduped against the menu by id; the menu only grows). They
  pass the same menu gate, approval hook, principal/effect-ring checks as any tool. `ToolSearchSession.noteLoaded` marks them
  loaded, so search never re-offers them.
- **Recorded.** Each activation is one `ctx.decide` `<loop>#turn:<i>:tool:<j>:skill`, `source: "agent-skill-activation"`, value
  `{ skill }`; a replay re-applies it without re-deciding, and the record is re-checked against the call (a tampered record can
  refuse, never activate another skill). Unknown / over-`maxActive` / `invalid_tool_input` are typed error results that record
  nothing; an instructions refusal (`instructions_too_large`, `instructions_refused`) is a typed error that records its verdict
  (see Review round 1); an already-active skill is re-delivered.
- **Trust.** Skills are HOST-registered author text. The catalog is never built from a remote/untrusted declaration; instructions
  that arrive tainted (ADR 0085) are refused, never delivered.
- **Config errors are loud:** the meta-tool name colliding with any menu tool, the search tool, a `toolSearch.catalog` tool or any
  offered skill's tool; a non-positive/over-ceiling cap; `"registry"` without a `skills` registry.
- **Residuals.** The activation result is an ordinary tool_result, so compaction may fold it into its summary; the skill's
  instructions then survive only as the summary's paraphrase, but its tools stay on the menu (append-only) and activating the skill
  again re-delivers them (Review round 1). A run re-loads an
  activated skill's instructions on replay from the CURRENT registry, as upfront skills already are. Skill tools are not counted
  against `toolSearch.maxLoaded`.

**D12 — Skills discoverable through search (R22b, user ruling 2026-10-09: "add skills to search_tools as R22 follow-up").** With a
large registry the D11 index (`maxIndexBytes`) cuts off the tail, and a skill past the cut cannot be activated. New option
`skillActivation.discovery: "index" | "search" | "both"` (default `"index"`: byte-identical to D11). `"search"` / `"both"` REQUIRE
`toolSearch`: anything else is a config error. (A host `toolSearch.ranker` was refused in v1; D13 lifts that.)
- **`"search"`** replaces the prompt index with one fixed line (no skill text reaches the prompt at all) saying skills are found
  with `search_tools` and loaded with `activate_skill`. **`"both"`** keeps the index (its `+N more` marker adds "find them with
  `search_tools`") and search also covers skills. An index that fits nothing is only a config error in `"index"` mode.
- **Discoverable set** = the activation catalog minus upfront-selected skills (and minus ids the index could not show on one line),
  NOT limited by `maxIndex` / `maxIndexBytes`. The offered set for `activate_skill` becomes index-listed UNION discoverable;
  anything else is still `unknown_skill`. Activation, its recording and its replay are unchanged (no new decision source; the
  learning substrate is untouched).
- **One index, built lazily.** The same BM25F index (same fields and weights: id/name 3, aliases 2, tags 2, description 1) holds
  tools and skills. Skills are host-registry author text, hence vouched. A skill's key is `"\0skill:" + id`: a skill and a tool
  with the same id (even a tool literally named `skill:x`) never collide, and a tool whose id starts with that NUL prefix is a
  `ToolSearchError` config error while skills are on (it would otherwise be silently unsearchable). The top-k heap is unchanged.
- **Hit shape (pick).** Tool hits keep their EXACT shape under `tools` (no `kind` added: it would change the output of existing
  configs). Skill hits are a SEPARATE array, present only when discovery is on: `skills: [{ kind: "skill", id, description }]`
  (description = first line, 160 chars). A search NEVER loads or activates a skill, or its tools, or its instructions: the model
  must call `activate_skill`. With no tool hit but skill hits the note says so; with none at all, "No matching tools or skills."
- **Budget (pick).** Skill hits count toward `maxPerSearch`: ONE shared page, best-ranked first (a separate
  `maxSkillsPerSearch` would be a second knob for the same context cost). The model's `limit` applies to the total.
- **Already-active skills (pick):** excluded from hits, like loaded tools (re-delivery goes through `activate_skill(name)`, which
  the model already knows). The ranker's over-ask grows by the number of active skills.
- **Recorded.** The same `agent-tool-search` decision gains `skills: string[]` (ids), written only when discovery is on, so a
  record from a default run is unchanged. On replay (and live) the record is re-admitted against the LIVE discoverable set: a
  forged id, a skill selected upfront since, an already-active skill, a non-array or garbage entries are dropped, and the total
  stays within `maxPerSearch` (tools first). The meta-tool descriptions of both tools gain one sentence when discovery is on.
- **Search is a convenience, not authorization.** `activate_skill` accepts ANY catalog skill (minus upfront-selected) by id,
  whether or not a search returned it; the offered set is the catalog, so "found with search" is never a precondition. `"both"` with
  a tiny `maxIndexBytes` is allowed (search covers everything, the index just lists fewer); `"search"` ignores `maxIndexBytes`.
- **Config errors:** `discovery` not one of the three; `"search"`/`"both"` without `toolSearch`. (v1 also refused a host
  `toolSearch.ranker`; that refusal is removed by D13.)
- **Residuals.** (1) ~~A custom `ranker` plus skill discovery is refused~~ — closed by D13 (a custom ranker ranks tools only;
  the `\0skill:` key stays internal to the built-in single index). (2) The discoverable set is not byte-bounded in the prompt (it is not in the
  prompt) but the lazy index is O(registry); a registry of tens of thousands of skills pays that once on the first search. (3) A
  search result lists skills the `"both"` index already shows; that is intentional, not deduplicated. (4) `skillActivation.maxIndex`
  no longer bounds reachability in `"search"`/`"both"`. (5) ~~Future custom-ranker contract~~ — implemented by D13.

**D13 — A custom tool ranker with skill discovery (R22c, user ruling 2026-10-09: "implement custom ranker follow-up").** The v1
refusal of `toolSearch.ranker` with `discovery: "search" | "both"` is removed. Contract:
- **A custom `toolSearch.ranker` ranks TOOLS only** (the unchanged `ToolRanker` interface). It is never given a skill doc, and no
  `\0skill:` key ever reaches it; a skill-looking key it returns is not a tool id and is dropped.
- **Skills are ranked separately**, never in the tool ranker's index: by the built-in BM25F over skill docs only (same fields and
  weights, built lazily, RAW skill ids), or by the optional `skillActivation.skillRanker?: ToolRanker` (same interface; it sees skill
  docs only and returns raw skill ids, the key prefix stays internal). Results are re-admitted against the live discoverable,
  inactive set. `skillRanker` requires `discovery: "search" | "both"` (config error otherwise). **Two-ranker mode** is on iff a
  custom `toolSearch.ranker` OR a `skillRanker` is present; with neither, the R22b single combined BM25F index is used and the path
  is byte-identical to before (same results, same record, no `skillRanker` key).
- **Page composition (pick): interleave by rank position, tool first** (t1, s1, t2, s2, ...) until `maxPerSearch`/`limit`; a kind
  that runs out hands its unused share to the other. Positions are integers, so there are no ties, and scores from different
  rankers are never compared or mixed. Rejected: "tools then skills" (starves skills whenever the tool ranker fills the page),
  and score blending (the scales are unrelated).
- **Over-ask and widening are per ranker**, each bounded (`MAX_RANK_ASK`, at most 4 rounds): the tool ranker is asked for the page
  plus loaded tools plus namespace-hidden tools, the skill ranker for the page plus active skills; each widens only while its own
  admitted list is short of the page and it has more to give.
- **Failures.** Either ranker throwing (non-terminal) is `search_unavailable`, a fixed reason, nothing recorded; terminal errors
  (R10) propagate. The tool ranker runs first; if it throws the skill ranker is not called.
- **Recording and replay.** Same shape (`results`, `loaded`, `skills`); two-ranker mode additionally writes `skillRanker: <kind>`
  next to `ranker` (the learning substrate sees which ranker produced each side). Replay calls NEITHER ranker and re-admits against
  the live sets, tools first up to `maxPerSearch`. A live page has at most `maxPerSearch` entries in total, so an untampered
  interleaved page is never truncated differently on replay (tested under `divergence: "fail"`).
- **Residual.** A sloppy skill ranker that ignores `limit` makes `admitSkills` iterate its whole output (host-controlled, like the
  tool ranker).

## Review round 1 (2026-10-09)

The first adversarial review (verdict: not approved as drafted; design holds) found the following; all are fixed.

- **Human tools and the settle phase (P2).** The parallel-versus-sequential choice read `humanTools` before the settle phase, but a
  search or an activation in that phase can grow the menu with a `kind: "human"` tool. After the settle loop the turn now runs
  sequentially, in call order, if any call still to run is a human tool (R10 P3-7). Old logs are unaffected: only R22 paths reach it.
- **Replay re-intersection (P2).** The recorded search is re-intersected with what THIS run may use on every path; the record is
  untrusted input, so a non-array `results` / `loaded`, a null or non-object record, repeated ids, hidden / unknown / already
  loaded ids, and more ids than the caps are all clipped, never widened. `loaded` is intersected with the freshly planned page, in
  page order.
- **D7 amended: what "third party" means.** A tool is un-vouched if the plugin that built it says so (`ToolDefinition.origin:
  "remote"`, additive and advisory, set by the MCP and A2A plugins wherever they build a tool from a remote declaration), OR it
  carries a `jsonInputSchema`, OR it is `kind: "a2a"` (fail closed: a plugin that forgets the marker is still treated as remote). An
  un-vouched tool's description is not ranked or shown, its own tags / aliases are ignored (host `annotations` still apply), and a
  result naming it is tainted; `trustJsonSchemaText` vouches for the text as before. A description that is itself TAINTED is never
  vouched for: it is listed withheld, not indexed, and the tool is not put on the menu (the prompt boundary would refuse its spec).
  Residual: the menu spec of a loaded A2A tool still carries the peer's description via `toolSpecFor` (unchanged R4b behaviour for a
  tool with no `jsonInputSchema`); only search's own ranking and results are covered here.
- **D11 amended: refusals and replay.** The instructions verdict is now part of the RECORDED decision: a live refusal records
  `{ skill, refused: "instructions_refused" | "instructions_too_large" }` (it used to record nothing), so a replay reproduces the
  refusal whatever the registry holds by then, and an accepted activation records `{ skill }` and STANDS on replay even if the
  reloaded text no longer passes the checks: its tools join the menu (consistent with the record) and the result is the typed
  error `instructions_unavailable`. Once a decision is recorded, replay honours it in both directions (a skill that grew, a skill
  that shrank), appends nothing, and cannot diverge. Residual: on replay the instructions delivered are the CURRENT registry text,
  which may differ from what the original run's model saw; the model's recorded responses do not change.
- **Re-activating an active skill re-delivers it.** After compaction folds the activation result into a summary the instructions
  would otherwise be unrecoverable. The result is `{ skill, instructions, note }`; nothing is recorded, no tools are added, and it
  is not counted against `maxActive`. (`already_active` is no longer an error.) The instructions are re-checked (tainted /
  oversized refuse as typed errors).
- **The index is bounded in bytes.** `maxIndexBytes` (default 8 KiB, ceiling 128 KiB); ids over 64 characters or containing
  control / format / line-separator characters are not offered (the model could not name them from the index); tags are capped at 32
  characters; the first line of a description ends at ANY line separator (`\n`, `\r`, VT, FF, NEL, U+2028, U+2029). Skills past the
  cap are not offered and are summarised as `- (+N more skills not listed)`. Deterministic (id order). `unknown_skill` caps the
  echoed name like the menu check does.
- **Name collisions.** The search meta-tool's name is checked against offered skills' tools (a config error), like the activation
  tool's.
- **Selection is relevance, not authorization.** The `"registry"` default makes EVERY registry skill reachable by the model (its
  tools still pass the menu gate, approval hook and effect ring when called). Restrict the reachable set with an explicit
  `catalog` array.
- **Ranking details.** `Bm25ToolRanker.rank` throws a `RangeError` for a NaN limit and clamps negative / fractional / infinite ones;
  the default index is built on the first search; the ask over-asks by the hidden (namespace-filtered) count as well as the loaded
  count and, if a shared ranker over a wider catalog still leaves the page short, widens (doubling, at most 4 rounds and 1000 hits).
  `maxMenuChars` counts only tools a search loaded (`alwaysLoaded` tools do not count against it). `agent-skill-activation` is a
  recorded-fact source for `@loom/learning`.

## Alternatives rejected

- *Rewriting the system prompt on activation, or a mid-conversation system message* (D11): breaks the cached prefix and is dropped by
  providers that take a separate `system`.

- *Search that returns schemas without loading* (the model then needs a second "load" call): one more turn per discovery.
- *Replacing the menu each turn with the latest results*: breaks the cached prefix and lets a tool vanish between a plan and its use.
- *Ranking by the model* (an LLM call per search): non-deterministic cost on the critical path; the record makes it replay-safe, so
  a `ToolRanker` can still do it, but it is not the default.
- *Trusting a remote server's `tags`*: the server chooses what the user's words map to. No.

## Consequences and residuals

- Each discovery costs a model round trip. Below ~30 tools do not enable it.
- Parallel calls: `search_tools` is settled sequentially with the turn's other calls (the settle phase is sequential even under
  `parallelTools`), so a search followed by a call to a tool it loads, in the same turn, works and is deterministic.
- `search_tools` is not approval-gated and is not metered as an effect. It is bounded by `maxSearches`, and it costs one decision.
- The semantic ranker (R18) is a follow-up behind `ToolRanker`.
- **Polish round (2026-10-09).** A ranker that throws, or a `loadInstructions` that throws, is feedback (typed
  `search_unavailable` / `instructions_unavailable`, a fixed reason, nothing recorded) unless the error is terminal under R10
  (cancellation, kill switch, quota, a park), which still propagates. Because the decider threw, `ctx.decide` marks the segment
  unsettled (as for any throwing decider). `maxIndexBytes` too small for even one skill is a config error.
- Residual: the A2A menu spec still carries the peer's description (pre-existing, R4b).
- Residual: re-delivering an already-active skill re-reads the LIVE instructions and records nothing, so a replay may deliver
  newer text than the first run did (the activation itself still replays from its record).
- Residual (host-controlled): a custom `ranker` that ignores `limit` makes `admit` iterate its whole output.

## Questions for the user

None open on menu composition: both questions the first draft raised were ruled by the user (D3, rulings A and B).
